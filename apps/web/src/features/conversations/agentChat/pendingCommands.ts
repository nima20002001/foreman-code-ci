import { hydrate, notifyManager, type QueryClient } from '@tanstack/react-query'
import { SendAgentChatMessageRequestSchema } from '@foreman-code/contracts/agent-chat'
import { ChatDeliveryReceiptSchema, type ChatDeliveryReceipt } from '@foreman-code/contracts'
import { identityEpoch, protectedKey } from '../../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../../shared/api/sessionBoundary'
import { sameDeliveryTarget } from '../../workflow-chat/draft'
import type { AgentChatCommand, AgentChatCommandResult } from './commandRecords'
import { AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT, agentChatCommandOrder, agentChatReadbacksKey, retireAgentChatAcknowledgements, type AgentChatReadbacks } from './commandRecords'

const documentEpoch = identityEpoch()
const storageError = 'Pending message storage is unavailable. Recover the original message before sending again.'
type SendCommand = Extract<AgentChatCommand, { kind: 'send' }>
const prefix = (draftKey: string) => protectedKey('outbox', `agent:${draftKey}:`)

/** Persist only immutable send inputs. Query owns delivery and recovered command state. */
export function rememberPendingCommand(draftKey: string, command: SendCommand, receipt?: ChatDeliveryReceipt): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) throw new Error(storageError)
  const key = prefix(draftKey) + encodeURIComponent(command.input.requestId)
  const value = JSON.stringify({ input: SendAgentChatMessageRequestSchema.parse(command.input),
    clearDraft: command.clearDraft, draftVersion: command.draftVersion, submittedAt: Date.now(),
    ...(receipt ? { receipt: ChatDeliveryReceiptSchema.parse(receipt) } : {}) })
  window.localStorage.setItem(key, value)
  if (window.localStorage.getItem(key) !== value) throw new Error(storageError)
  if (receipt) retireStoredReceipts(draftKey)
}

function retireStoredReceipts(draftKey: string): void {
  const terminal: Array<{ key: string; submittedAt: number }> = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix(draftKey))) continue
    try {
      const saved = JSON.parse(localStorage.getItem(key)!), receipt = ChatDeliveryReceiptSchema.safeParse(saved.receipt)
      if (receipt.success && ['completed', 'failed', 'canceled'].includes(receipt.data.state) && Number.isFinite(saved.submittedAt)) {
        terminal.push({ key, submittedAt: saved.submittedAt })
      }
    } catch { /* ignore: malformed pending input remains available to the existing recovery error. */ }
  }
  for (const item of terminal.sort((left, right) => left.submittedAt - right.submittedAt).slice(0, -AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)) {
    localStorage.removeItem(item.key)
  }
}

export function forgetPendingCommand(draftKey: string, requestId: string): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) return
  try {
    window.localStorage.removeItem(prefix(draftKey) + encodeURIComponent(requestId))
  } catch (error) {
    // Retaining an acknowledged input is safe; failed cleanup must not hide its receipt.
    console.warn('Acknowledged Agent message could not be removed from local storage.', error)
  }
}

/** Exact authorized receipt readback updates the existing command owner, never creates a native turn. */
export function acceptPendingDelivery(client: QueryClient, draftKey: string, generation: number, receipt: ChatDeliveryReceipt): void {
  for (const mutation of client.getMutationCache().findAll({ mutationKey: ['agent-chat', generation, draftKey, 'command'], exact: true })) {
    const command = mutation.state.variables as AgentChatCommand | undefined
    const result = mutation.state.data as AgentChatCommandResult | undefined, previous = result?.receipt
    if (command?.kind !== 'send' || mutation.state.status === 'pending' || !previous || previous.id !== receipt.id
      || command.input.requestId !== receipt.commandId || !sameDeliveryTarget(previous.target, receipt.target)
      || Date.parse(receipt.updatedAt) < Date.parse(previous.updatedAt)
      || ['completed', 'failed', 'canceled'].includes(previous.state) && previous.state !== receipt.state
      || JSON.stringify(previous) === JSON.stringify(receipt)) continue
    rememberPendingCommand(draftKey, command, receipt)
    notifyManager.batch(() => {
      const cache = client.getMutationCache()
      cache.remove(mutation)
      const recovered = cache.build(client, { ...mutation.options,
        meta: { ...mutation.options.meta, chatCommandOrder: agentChatCommandOrder(mutation) },
      }, { ...mutation.state, data: { ...result, receipt }, status: 'success', error: null, failureReason: null, failureCount: 0 })
      const readbacks = client.getQueryData<AgentChatReadbacks>(agentChatReadbacksKey)
      const prior = readbacks?.[mutation.mutationId]
      if (readbacks && prior) {
        const retained = { ...readbacks, [recovered.mutationId]: prior }
        delete retained[mutation.mutationId]
        client.setQueryData(agentChatReadbacksKey, retained)
      }
    })
  }
  retireAgentChatAcknowledgements(client)
}

/** Restore as uncertain errors, never paused writes that Query might replay. */
export function restorePendingCommands(client: QueryClient, draftKey: string, generation: number): void {
  if (sessionIsSwitching() || identityEpoch() !== documentEpoch) return
  const mutationKey = ['agent-chat', generation, draftKey, 'command']
  const storedPrefix = prefix(draftKey)
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index)
    if (!key?.startsWith(storedPrefix)) continue
    const saved = JSON.parse(window.localStorage.getItem(key)!)
    const input = SendAgentChatMessageRequestSchema.parse(saved.input)
    const receipt = saved.receipt === undefined ? undefined : ChatDeliveryReceiptSchema.parse(saved.receipt)
    if (typeof saved.clearDraft !== 'boolean' || !Number.isFinite(saved.submittedAt)
      || saved.draftVersion !== undefined && (!Number.isSafeInteger(saved.draftVersion) || saved.draftVersion < 0)
      || key !== storedPrefix + encodeURIComponent(input.requestId)
      || receipt && (receipt.commandId !== input.requestId || receipt.target.kind === 'operator_conversation'
        || receipt.target.agent.workflowId !== input.context.workflowId || receipt.target.agent.workflowNodeId !== input.context.workflowNodeId
        || receipt.target.agent.agentId !== input.context.agentId)) throw new Error(storageError)
    const existing = client.getMutationCache().findAll({ mutationKey, exact: true }).some((mutation) => {
      const command = mutation.state.variables as AgentChatCommand | undefined
      return command?.kind === 'send' && command.input.requestId === input.requestId
    })
    if (existing) continue
    const error = new Error('Delivery uncertain after reload. The original message may already have been accepted.')
    hydrate(client, { mutations: [{ mutationKey, state: {
      variables: { kind: 'send', input, clearDraft: saved.clearDraft, draftVersion: saved.draftVersion }, submittedAt: saved.submittedAt,
      status: receipt ? 'success' : 'error', error: receipt ? null : error, failureReason: receipt ? null : error, failureCount: receipt ? 0 : 1,
      isPaused: false, data: receipt ? { receipt, conversationId: receipt.target.kind === 'agent_conversation' ? receipt.target.conversationId : undefined } : undefined, context: undefined,
    } }] })
  }
}
