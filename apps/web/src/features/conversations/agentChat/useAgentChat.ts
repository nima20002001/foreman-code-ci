import type { Dispatch, RefObject, SetStateAction } from 'react'
import { errorMessage } from '../../../shared/errorMessage'
import { ChatDeliveryReceiptSchema, EngineChatReadbackSchema, type ChatDeliveryReceipt, type SessionMode } from '@foreman-code/contracts'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ManagementAction } from '@foreman-code/contracts/management'
import type { AgentChatContext, AgentChatIntent, AgentChatState } from '@foreman-code/contracts/agent-chat'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import type { SelectedRunChatExecution } from '@foreman-code/contracts/selected-run-chat'
import { selectedRunChatApi } from './selectedRunChatClient'
import { agentChatApi } from '../../../shared/api/agentChat'
import { ApiError } from '../../../shared/api/client'
import { createStreamReadback } from '../../../shared/api/streamReadback'
import { committedMessage, createCommittedMessageBuffer, patchCommittedMessages } from '../delivery/committedMessageStream'
import { subscribeAgentChat, type AgentChatConnection } from '../../../shared/api/agentChatStream'
import { sameDeliveryTarget } from '../../workflow-chat/draft'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../../shared/api/sessionBoundary'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { isApiAccessError } from '../../../shared/api/accessError'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { canUseBoardAction } from '../../workflow-board/permissions'
import { useConversationDraftStore } from '../conversationDraftStore'
import { messageAttachmentRefs, sameAttachmentRefs, type ChatAttachmentAttempt } from '../chatAttachmentAttempt'
import { markChatTurnCompleted } from '../chatTurnCompletion'
import { useAgentChatHistory } from './useAgentChatHistory'
import { acceptAgentReadback, deliveryTargetMatches } from './readbackMetadata'
import { claimDeliveryDraftReadback, claimDraftReadback, receiptForCommand } from './receiptReadback'
import { acceptPendingDelivery, forgetPendingCommand, rememberPendingCommand, restorePendingCommands } from './pendingCommands'
import { agentChatContextKey, approvalReplyAvailable, intentUnavailable, stateBelongsToContext } from './model'

import { agentChatCommandOrder, agentChatReadbacksKey, compactAgentChatResult, confirmedCommandReceipt, currentCommandReceipt, rememberAgentChatReadback, retireAgentChatAcknowledgements, type AgentChatReadbacks, type AgentChatCommand as Command, type AgentChatCommandResult as Result, type AgentChatCommandRecord } from './commandRecords'
export type { AgentChatCommandRecord } from './commandRecords'

function reconcileDraftReadback(state: AgentChatState | undefined, commands: AgentChatCommandRecord[], draftKey: string) {
  let reconciled = false
  for (const record of commands) {
    const { command } = record
    if ((claimDraftReadback(command, confirmedCommandReceipt(record, state) ?? receiptForCommand(state, command))
      || state && claimDeliveryDraftReadback(command, record.result?.receipt)) && command?.kind === 'send') {
      clearCommandDraft(draftKey, command)
      command.attachmentAttempt?.acknowledge?.()
      reconciled = true
    }
  }
  return reconciled
}

function clearCommandDraft(draftKey: string, command: Extract<Command, { kind: 'send' }>): void {
  const drafts = useConversationDraftStore.getState()
  if (command.draftVersion === undefined) drafts.clearDraft(draftKey, command.input.content)
  else drafts.clearExactDraft(draftKey, command.input.content, command.draftVersion)
}

function matchesDelivery(receipt: ChatDeliveryReceipt, command: Extract<Command, { kind: 'send' }>, context: AgentChatContext): boolean {
  const target = receipt.target
  if (receipt.commandId !== command.input.requestId || target.kind === 'operator_conversation'
    || target.agent.workspaceId !== context.workspaceId || target.agent.workflowId !== context.workflowId
    || target.agent.workflowNodeId !== context.workflowNodeId || target.agent.agentId !== context.agentId) return false
  if (target.kind === 'workflow_execution') return target.execution.runId === context.runId && command.input.expectedConversationId === null
  if (target.kind === 'workflow_coordinator') return target.runId === context.runId && command.input.expectedConversationId === null
  return command.input.expectedConversationId === null || command.input.expectedConversationId === target.conversationId
}

// A synchronous admission latch, NOT a second copy of server/request state. It covers the gap
// before React renders mutation.isPending and survives closing/reopening a panel during a POST.
const locks = new WeakMap<QueryClient, Set<string>>()
function acquire(client: QueryClient, key: string): (() => void) | undefined {
  const keys = locks.get(client) ?? new Set<string>()
  locks.set(client, keys)
  if (keys.has(key)) return undefined
  keys.add(key)
  return () => { keys.delete(key) }
}
const subscribeNetwork = (notify: () => void) => {
  window.addEventListener('online', notify); window.addEventListener('offline', notify)
  return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify) }
}
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine
export const agentChatStateKey = (context: AgentChatContext, generation = sessionGeneration(), executionId?: string) =>
  ['agent-chat', generation, executionId ? JSON.stringify([agentChatContextKey(context), executionId]) : agentChatContextKey(context), 'state'] as const

/** Access can be revoked during response readback after the command was accepted. */
export function commandMayHaveBeenAccepted(error: unknown): boolean {
  if (!ApiError.is(error)) return true
  return error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE' || isApiAccessError(error)
}

export function useAgentChat(inputContext: AgentChatContext,
  options: { denial?: ApiError | undefined; selection?: SelectedRunChatExecution | undefined } = {}) {
  const { denial: externalDenial, selection } = options
  const { workspaceId, workflowId, workflowNodeId, agentId, runId } = inputContext
  const context = useMemo<AgentChatContext>(() => ({
    workspaceId, workflowId, workflowNodeId, agentId, ...(runId === undefined ? {} : { runId }),
  }), [workspaceId, workflowId, workflowNodeId, agentId, runId])
  const client = useQueryClient(), generation = sessionGeneration()
  const readGeneration = useRef(0)
  const commandDenial = useRef<ApiError | undefined>(undefined)
  const executionId = selection?.executionId
  const key = useMemo(() => agentChatStateKey(context, generation, executionId), [context, generation, executionId])
  const draftKey = key[2]
  const matches = useCallback((incoming: AgentChatState) => {
    const sourceId = incoming.conversation?.origin.kind === 'run_execution'
      ? incoming.conversation.origin.executionId : incoming.sourceTranscript?.executionId
    return stateBelongsToContext(incoming, context) && (!executionId || sourceId === executionId)
  }, [context, executionId])
  useEffect(() => {
    if (!externalDenial) return
    readGeneration.current++
    void client.cancelQueries({ queryKey: ['agent-chat', generation, draftKey] })
    void client.cancelQueries({ queryKey: ['agent-chat', generation, context] })
    client.removeQueries({ queryKey: ['agent-chat', generation, context] })
    client.removeQueries({ queryKey: key, exact: true })
  }, [client, context, draftKey, externalDenial, generation, key])
  const commandKey = useMemo(() => ['agent-chat', generation, draftKey, 'command'] as const, [draftKey, generation])
  const recoveryError = useMemo(() => {
    try {
      restorePendingCommands(client, draftKey, generation)
      return undefined
    } catch (error) {
      return errorMessage(error, 'Pending messages could not be recovered.')
    }
  }, [client, draftKey, generation])
  const commandFilters = useMemo(() => ({ mutationKey: commandKey, exact: true }), [commandKey])
  const online = useSyncExternalStore(subscribeNetwork, isOnline, () => true)
  const access = useLocalHumanAccessQuery()
  const permits = (action: ManagementAction) => !sessionIsSwitching() && generation === sessionGeneration()
    && !access.isError && !!access.data && Date.parse(access.data.principal.expiresAt) > Date.now()
    && canUseBoardAction(access.data.principal.grants, action, context)
  const canRead = permits('agent_chat:read')
  const readbacks = useQuery<AgentChatReadbacks>({ queryKey: agentChatReadbacksKey, enabled: false, gcTime: Infinity })
  const records = useMutationState<AgentChatCommandRecord & { mutationId: number; order: number }>({ filters: commandFilters, select: (mutation) => ({
    mutationId: mutation.mutationId, order: agentChatCommandOrder(mutation), command: mutation.state.variables as Command | undefined, result: mutation.state.data as Result | undefined,
    error: mutation.state.error, status: mutation.state.status, submittedAt: mutation.state.submittedAt,
  }) })
  const commands = useMemo(() => [...records].sort((left, right) => left.order - right.order).map((record) => ({ ...record, readback: readbacks.data?.[record.mutationId] })), [records, readbacks.data])
  const latestCommand = commands.at(-1)
  const pending = useIsMutating(commandFilters) > 0
  const [localError, setLocalError] = useState<string>()
  const [deliveryDenial, setDeliveryDenial] = useState<ApiError>()
  const [connection, setConnection] = useState<AgentChatConnection>('connecting')
  const query = useQuery({ queryKey: key, enabled: canRead && !externalDenial && !deliveryDenial, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const read = ++readGeneration.current
      const denialAtStart = commandDenial.current
      const state = selection ? await selectedRunChatApi.state(selection, { signal })
        : await agentChatApi.read(context, { signal })
      signal.throwIfAborted()
      if (read !== readGeneration.current) throw new DOMException('Newer chat readback required', 'AbortError')
      assertSession(generation)
      if (!matches(state) || !deliveryTargetMatches(state, state.deliveryTarget)) throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Chat returned a different selection. Refresh before sending.' }, 409)
      if (commandDenial.current === denialAtStart) commandDenial.current = undefined
      return state
    },
    structuralSharing: (previous, incoming) => {
      const accepted = acceptAgentReadback(previous as Awaited<ReturnType<typeof agentChatApi.read>> | undefined,
        incoming as Awaited<ReturnType<typeof agentChatApi.read>>, 'read')
      if (generation === sessionGeneration() && !sessionIsSwitching()) {
        rememberAgentChatReadback(client, key, accepted)
      }
      return accepted
    },
  })
  const { history, historyKey } = useAgentChatHistory(context, externalDenial ? undefined : query.data, generation, key, commandDenial, readGeneration)
  const historyDenial = history.errorUpdatedAt >= query.dataUpdatedAt && isApiAccessError(history.error) ? history.error : undefined
  const denial = useProtectedAccessError(query, externalDenial ?? deliveryDenial ?? commandDenial.current ?? historyDenial
    ?? (latestCommand && latestCommand.submittedAt > query.dataUpdatedAt ? latestCommand.error : undefined))
  const state = canRead && !denial && query.data && matches(query.data) ? query.data : undefined
  const currentReceipt = latestCommand?.result
    ? currentCommandReceipt(latestCommand.result, state)
    : receiptForCommand(state, latestCommand?.command)
  const confirmedReceipt = confirmedCommandReceipt(latestCommand, state)
  const latestReceipt = currentReceipt ?? latestCommand?.result?.turn ?? confirmedReceipt
  useAgentChatReceiptReadback({ generation, state, commands, draftKey, setLocalError, client })
  const accept = useCallback((incoming: AgentChatState, source: 'read' | 'receipt' = 'receipt') => {
    assertSession(generation)
    if (sessionIsSwitching() || !matches(incoming)) return
    if (commandDenial.current) return
    if (isApiAccessError(client.getQueryState(key)?.error)) return
    const historyRead = client.getQueryState(['agent-chat', generation, incoming.context, incoming.conversation?.id, 'history'])
    // A late SSE/command snapshot cannot undo a known denial; require a fresh state GET.
    if (historyRead && isApiAccessError(historyRead.error) && historyRead.errorUpdatedAt >= (client.getQueryState(key)?.dataUpdatedAt ?? 0)) return
    client.setQueryData<Awaited<ReturnType<typeof agentChatApi.read>>>(key, previous => acceptAgentReadback(previous, incoming, source))
  }, [client, generation, key, matches])
  const refresh = useCallback(() => {
    setDeliveryDenial(undefined)
    void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false })
  }, [client, key])
  const revoke = (error: Error) => {
    if (!isApiAccessError(error)) return
    setDeliveryDenial(error); commandDenial.current = error; readGeneration.current++
    for (const queryKey of [key, ['agent-chat', generation, context]]) {
      void client.cancelQueries({ queryKey }); client.removeQueries({ queryKey })
    }
  }
  const confirmDelivery = useCallback((receipt: ChatDeliveryReceipt) => {
    if (generation !== sessionGeneration() || sessionIsSwitching() || commandDenial.current || externalDenial) return
    try { acceptPendingDelivery(client, draftKey, generation, receipt) }
    catch (error) { setLocalError(errorMessage(error, 'The delivery receipt could not be retained.')) }
  }, [client, draftKey, externalDenial, generation])
  useAgentChatStream({ client, key, workspaceId: context.workspaceId, conversationId: state?.conversation?.id,
    enabled: canRead && !denial, accept, matches, readGeneration, setConnection })

  const mutation = useAgentChatMutation({ commandKey, generation, context, matches, accept, draftKey, selection,
    setLocalError, refresh, commandDenial, readGeneration, client, key })
  const runCommand = (build: () => Command): boolean => {
    const release = acquire(client, JSON.stringify(commandKey))
    if (!release) return false
    setLocalError(undefined)
    try {
      // Allocate exactly one requestId AFTER synchronous admission, not on each keystroke/click.
      const command = build()
      if (command.kind === 'send') rememberPendingCommand(draftKey, command)
      void mutation.mutateAsync(command).catch(() => {
        // ignore: useAgentChatMutation.onError retains and reports the command failure.
      }).finally(() => { release(); retireAgentChatAcknowledgements(client) })
      return true
    } catch (error) { release(); setLocalError(errorMessage(error, 'The command could not be prepared.')); return false }
  }
  const blocked = (action: ManagementAction) => {
    if (!online) return 'You are offline. Your draft is kept.'
    if (!permits(action)) return 'Your access does not allow this action for this Agent and Run.'
    if (recoveryError) return recoveryError
    if (!state || query.isError) return 'Refresh this conversation before sending a command.'
    if (state.availability.reason === 'run_active' || state.sessionState === 'unavailable') {
      return state.availability.message ?? 'This selection is read only.'
    }
    if (pending) return 'A command is being sent.'
    return undefined
  }
  const send = (content: string, intent: AgentChatIntent, clearDraft = true, allowNewMessage = false, attachmentAttempt?: ChatAttachmentAttempt, sessionMode?: SessionMode): boolean => {
    const text = content.trim()
    const attachments = attachmentAttempt?.attachments ?? []
    const reason = blocked('agent_chat:write') ?? (state ? intentUnavailable(state, intent) : undefined)
    // A completed send can clear the draft before React paints its empty value. Ignore an old
    // Enter/click handler in that gap; do not allocate another requestId for the cleared text.
    reconcileDraftReadback(client.getQueryData<AgentChatState>(key), commands, draftKey)
    if (clearDraft && (useConversationDraftStore.getState().drafts[draftKey] ?? '').trim() !== text) return false
    if (clearDraft && attachmentAttempt?.isCurrent && !attachmentAttempt.isCurrent()) return false
    if (reason || !state || (!text && !attachments.length) || text.length > 32_000 || attachments.length > 0 && !state.conversation) { setLocalError(reason ?? 'Write a message of up to 32,000 characters.'); return false }
    const unconfirmed = state.turns.some((turn) => turn.delivery === 'unknown' && state.messages.some((message) => message.id === turn.messageId && message.content.trim() === text && sameAttachmentRefs(messageAttachmentRefs(message), attachments)))
      || commands.some((record) => {
        if (record.command?.kind !== 'send' || record.command.input.content !== text || !sameAttachmentRefs(record.command.input.attachments, attachments)) return false
        const receipt = confirmedCommandReceipt(record, state) ?? receiptForCommand(state, record.command) ?? (record.result && 'turn' in record.result ? record.result.turn : undefined)
        return receipt ? receipt.delivery === 'unknown' : record.result?.receipt ? record.result.receipt.state === 'unknown'
          : record.status === 'error' && commandMayHaveBeenAccepted(record.error)
      })
    if (unconfirmed && !allowNewMessage) { setLocalError('Delivery is unknown. Use “Send again as new message” and review the warning.'); return false }
    return runCommand(() => {
      const target = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId,
        ...(context.runId ? { runId: context.runId } : {}) }
      return { kind: 'send', clearDraft, draftVersion: useConversationDraftStore.getState().versions[draftKey] ?? 0, attachmentAttempt, input: { requestId: `agent-chat-${crypto.randomUUID()}`, context: target, content: text, intent, ...(sessionMode ? { sessionMode } : {}),
        ...(attachments.length ? { attachments: attachments.map((pin) => ({ ...pin })) } : {}),
        expectedConversationId: state.conversation?.id ?? null,
        ...(intent !== 'next_turn' && state.activeTurn?.nativeTurnId ? { expectedNativeTurnId: state.activeTurn.nativeTurnId } : {}) } }
    })
  }
  const stop = () => {
    const reason = blocked('agent_chat:cancel')
    if (reason || !state?.conversation || !state.capabilities.interruptAndSend || state.availability.reason === 'run_active') return
    runCommand(() => ({ kind: 'stop', conversationId: state.conversation!.id, requestId: `agent-chat-stop-${crypto.randomUUID()}`,
      ...(state.activeTurn?.nativeTurnId ? { expectedNativeTurnId: state.activeTurn.nativeTurnId } : {}) }))
  }
  const cancelQueued = (turnRequestId: string) => {
    if (blocked('agent_chat:cancel') || !state?.conversation || state.turns.find((turn) => turn.requestId === turnRequestId)?.delivery !== 'queued') return
    runCommand(() => ({ kind: 'cancel', conversationId: state.conversation!.id, requestId: `agent-chat-cancel-${crypto.randomUUID()}`, turnRequestId }))
  }
  const respond = (optionId: string, response?: Extract<Command, { kind: 'respond' }>['response']) => {
    if (blocked('agent_chat:respond') || !state?.conversation || !approvalReplyAvailable(state)
      || !state.pendingInteraction?.responseOptions.some((option) => option.optionId === optionId)) return
    runCommand(() => ({ kind: 'respond', conversationId: state.conversation!.id, requestId: `agent-chat-response-${crypto.randomUUID()}`,
      nativeRequestId: state.pendingInteraction!.turn.nativeRequestId!, optionId,
      ...(response !== undefined ? { response } : {}) }))
  }
  return { state, query, history: {
    ...history,
    hasGap: !!history.data && history.data.pageParams[0] !== undefined,
    reloadNearer: async () => {
      await client.resetQueries({ queryKey: historyKey, exact: true })
      await history.fetchNextPage()
    },
  }, access, canRead, denial, online, pending, connection, commands, latestCommand, latestReceipt, currentReceipt, confirmedReceipt, localError, blocked,
    send, stop, cancelQueued, respond, refresh, revoke, confirmDelivery, draftKey, selection, queryKey: key }
}

function useAgentChatStream({ client, key, workspaceId, conversationId, enabled, accept, matches,
  readGeneration, setConnection }: {
  client: QueryClient
  key: ReturnType<typeof agentChatStateKey>
  workspaceId: string
  conversationId: string | undefined
  enabled: boolean
  accept(state: AgentChatState, source: 'receipt'): void
  matches(state: AgentChatState): boolean
  readGeneration: RefObject<number>
  setConnection: Dispatch<SetStateAction<AgentChatConnection>>
}) {
  useEffect(() => {
    if (!conversationId || !enabled) return
    let disposed = false
    const readback = createStreamReadback(async () => {
      if (disposed) return
      await client.cancelQueries({ queryKey: key, exact: true })
      if (!disposed) await client.refetchQueries({ queryKey: key, exact: true })
    })
    const refetch = readback.request
    const text = createCommittedMessageBuffer(messages => {
      if (disposed) return
      client.setQueryData<AgentChatState>(key, previous => previous
        ? patchCommittedMessages(previous, messages, conversationId, previous.activeTurn?.requestId) : previous)
    }, refetch)
    const close = subscribeAgentChat(workspaceId, conversationId, {
      snapshot: (incoming) => {
        if (disposed) return
        text.clear()
        if (matches(incoming)) {
          readGeneration.current++
          void client.cancelQueries({ queryKey: key, exact: true })
          accept(incoming, 'receipt')
          refetch()
        } else refetch()
      },
      event: (event) => {
        if (disposed) return
        if (event.type === 'delta') {
          const state = client.getQueryData<AgentChatState>(key)
          const message = committedMessage(event.data, conversationId, state?.activeTurn?.requestId)
          if (message) { text.push(message); return }
        }
        text.clear()
        if (event.type === 'state' && typeof event.data.requestId === 'string'
          && ['completed', 'failed', 'canceled'].includes(String(event.data.delivery))) {
          markChatTurnCompleted(client, conversationId, event.data.requestId)
        }
        refetch()
      },
      refetch: () => { text.clear(); refetch() },
      connection: (next) => { if (!disposed) setConnection(next) },
    })
    return () => { disposed = true; text.clear(); readback.dispose(); close() }
  }, [client, key, workspaceId, conversationId, enabled, accept, matches, readGeneration, setConnection])
}

type AgentChatMutationOptions = {
  commandKey: readonly ['agent-chat', number, string, 'command']
  generation: number
  context: AgentChatContext
  selection?: SelectedRunChatExecution | undefined
  matches: (state: AgentChatState) => boolean
  accept: (state: AgentChatState, source?: 'read' | 'receipt') => void
  draftKey: string
  setLocalError: Dispatch<SetStateAction<string | undefined>>
  refresh: () => void
  commandDenial: RefObject<ApiError | undefined>
  readGeneration: RefObject<number>
  client: QueryClient
  key: ReturnType<typeof agentChatStateKey>
}

function useAgentChatMutation({ commandKey, generation, context, matches, accept, draftKey, selection,
  setLocalError, refresh, commandDenial, readGeneration, client, key }: AgentChatMutationOptions) {
  const mutation = useMutation<Result, Error, Command>({ mutationKey: commandKey, retry: false, gcTime: Infinity,
    // Never park a write offline and send it later to a potentially changed native turn.
    networkMode: 'always',
    mutationFn: async (command) => {
      assertSession(generation)
      if (!isOnline()) throw new ApiError({ code: 'OFFLINE', message: 'You are offline. No request was sent.' }, 400)
      const workspaceId = context.workspaceId
      let result
      switch (command.kind) {
        case 'send':
          result = selection ? await selectedRunChatApi.send(selection, command.input)
            : await agentChatApi.send(workspaceId, command.input)
          break
        case 'stop':
          result = await agentChatApi.interrupt(workspaceId, command.conversationId, {
            requestId: command.requestId,
            ...(command.expectedNativeTurnId ? { expectedNativeTurnId: command.expectedNativeTurnId } : {}),
          })
          break
        case 'cancel':
          result = await agentChatApi.cancelQueued(workspaceId, command.conversationId, command.turnRequestId, {
            requestId: command.requestId,
          })
          break
        case 'respond':
          result = await agentChatApi.respond(workspaceId, command.conversationId, {
            requestId: command.requestId,
            nativeRequestId: command.nativeRequestId,
            optionId: command.optionId,
            ...(command.response !== undefined ? { response: command.response } : {}),
          })
          break
      }
      const standalone = ReadAgentChatResponseSchema.safeParse(result.state)
      const receipt = 'receipt' in result ? ChatDeliveryReceiptSchema.safeParse(result.receipt) : undefined
      const native = 'turn' in result ? result.turn : undefined
      const common = command.kind === 'send' && receipt?.success && matchesDelivery(receipt.data, command, context)
      if ('receipt' in result && result.receipt && !common && command.kind === 'send') {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The delivery receipt did not confirm this exact command and target.' })
      }
      const engine = !standalone.success && common ? EngineChatReadbackSchema.safeParse(result.state) : undefined
      if (result.state !== undefined && (standalone.success ? !matches(standalone.data) : !engine?.success
        || !receipt?.success || !sameDeliveryTarget(engine.data.target, receipt.data.target))) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response returned a different chat selection.' })
      }
      if (result.state === undefined && !common) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this exact command.' })
      if (command.kind !== 'send' ? !standalone.success || standalone.data.conversation?.id !== command.conversationId
        : native && native.requestId !== command.input.requestId || common && receipt?.success && standalone.success
          && receipt.data.target.kind === 'agent_conversation' && standalone.data.conversation
          && standalone.data.conversation.id !== receipt.data.target.conversationId
          || !common && (native?.requestId !== command.input.requestId
          || command.input.expectedConversationId !== null && (!standalone.success || standalone.data.conversation?.id !== command.input.expectedConversationId))) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this command in this conversation.' })
      }
      if (standalone.success && generation === sessionGeneration() && !sessionIsSwitching()) accept(standalone.data)
      return compactAgentChatResult(result)
    },
    onSuccess: (result, command) => {
      if (generation !== sessionGeneration() || sessionIsSwitching()) return
      // State was accepted in mutationFn; the stored result is compact.
      if (command.kind === 'send' && result.receipt && !result.turn) rememberPendingCommand(draftKey, command, result.receipt)
      if (command.kind === 'send' && (claimDraftReadback(command, result.turn) || claimDeliveryDraftReadback(command, result.receipt))) {
        setLocalError(undefined)
        clearCommandDraft(draftKey, command)
        command.attachmentAttempt?.acknowledge?.()
      }
      refresh()
    },
    onError: async (error, command) => {
      if (generation !== sessionGeneration() || sessionIsSwitching()) return
      if (command.kind === 'send' && !commandMayHaveBeenAccepted(error)) {
        forgetPendingCommand(draftKey, command.input.requestId)
      }
      if (isApiAccessError(error)) {
        // Only a GET begun after this denial can restore protected chat state.
        commandDenial.current = error
        readGeneration.current++
        await client.cancelQueries({ queryKey: key, exact: true })
      }
      refresh()
    },
  })
  return mutation
}

function useAgentChatReceiptReadback({ generation, state, commands, draftKey, setLocalError, client }: {
  generation: number
  state: AgentChatState | undefined
  commands: AgentChatCommandRecord[]
  draftKey: string
  setLocalError: Dispatch<SetStateAction<string | undefined>>
  client: QueryClient
}) {
  useEffect(() => {
    if (generation !== sessionGeneration() || sessionIsSwitching()) return
    if (reconcileDraftReadback(state, commands, draftKey)) setLocalError(undefined)
    for (const record of commands) {
      if (record.command?.kind !== 'send') continue
      const receipt = confirmedCommandReceipt(record, state) ?? receiptForCommand(state, record.command)
      if (receipt && ['completed', 'failed', 'canceled'].includes(receipt.delivery)) {
        forgetPendingCommand(draftKey, record.command.input.requestId)
      }
    }
  }, [state, commands, draftKey, generation, setLocalError])
  useEffect(() => { retireAgentChatAcknowledgements(client) }, [client, state])
}
