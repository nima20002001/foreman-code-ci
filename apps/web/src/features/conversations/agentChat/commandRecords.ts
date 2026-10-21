import type { Mutation, QueryClient } from '@tanstack/react-query'
import type { ChatDeliveryReceipt, InteractionResponseValue } from '@foreman-code/contracts'
import type { AgentChatState, AgentChatTurn, SendAgentChatMessageRequest, AgentChatSendResponse } from '@foreman-code/contracts/agent-chat'
import type { ChatAttachmentAttempt } from '../chatAttachmentAttempt'
import { receiptForCommand } from './receiptReadback'

export type AgentChatCommand =
  | { kind: 'send'; input: SendAgentChatMessageRequest; clearDraft: boolean; draftVersion?: number; attachmentAttempt?: ChatAttachmentAttempt }
  | { kind: 'stop'; conversationId: string; requestId: string; expectedNativeTurnId?: string }
  | { kind: 'cancel'; conversationId: string; requestId: string; turnRequestId: string }
  | { kind: 'respond'; conversationId: string; requestId: string; nativeRequestId: string;
    optionId: string; response?: InteractionResponseValue }

/** The query owns the full projection. Mutations keep only command/readback identity, not snapshots. */
export type AgentChatCommandResult = { conversationId?: string; turn?: AgentChatTurn; receipt?: ChatDeliveryReceipt; replayed?: boolean }
export type AgentChatCommandReadback = { conversationId: string; turn: AgentChatTurn }
export type AgentChatReadbacks = Record<number, AgentChatCommandReadback>
export const agentChatReadbacksKey = ['agent-chat', 'command-readbacks'] as const
export type AgentChatCommandRecord = {
  command: AgentChatCommand | undefined; result: AgentChatCommandResult | undefined; error: unknown
  status: 'idle' | 'pending' | 'success' | 'error'; submittedAt: number; readback?: AgentChatCommandReadback
}
export const AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT = 20

export function agentChatCommandOrder(mutation: Mutation): number {
  const original = mutation.options.meta?.chatCommandOrder
  return typeof original === 'number' ? original : mutation.mutationId
}

export function compactAgentChatResult(result: AgentChatSendResponse | { state: AgentChatState }): AgentChatCommandResult {
  return { conversationId: result.state && 'conversation' in result.state ? result.state.conversation?.id : undefined,
    ...('turn' in result && result.turn ? { turn: result.turn } : {}),
    ...('receipt' in result && result.receipt ? { receipt: result.receipt } : {}),
    ...('replayed' in result ? { replayed: result.replayed } : {}) }
}

/** Never read a receipt from a replacement conversation, even if its request id happens to match. */
export function currentCommandReceipt(result: AgentChatCommandResult | undefined, state: AgentChatState | undefined): AgentChatTurn | undefined {
  const requestId = result?.turn?.requestId ?? result?.receipt?.commandId
  return requestId && result?.conversationId === state?.conversation?.id
    ? state?.turns.find((turn) => turn.requestId === requestId) : undefined
}

/** Terminal proof is separate from the initial HTTP acknowledgement. A bounded state window is
 * lossy, so Query retains only a detached receipt, keyed by its owning mutation id (not a snapshot).
 * Capture at state acceptance, before batched renders or a later window can evict the receipt. */
export function rememberAgentChatReadback(client: QueryClient, stateKey: readonly unknown[], state: AgentChatState): void {
  if (!state.conversation) return
  const mutations = client.getMutationCache().findAll({ mutationKey: [...stateKey.slice(0, 3), 'command'], exact: true })
  const previous = client.getQueryData<AgentChatReadbacks>(agentChatReadbacksKey) ?? {}
  let next = previous
  for (const mutation of mutations) {
    if (previous[mutation.mutationId]) continue
    const result = mutation.state.data as AgentChatCommandResult | undefined
    if (result?.conversationId && result.conversationId !== state.conversation.id) continue
    const receipt = receiptForCommand(state, mutation.state.variables as AgentChatCommand | undefined)
    if (!receipt || !['completed', 'failed', 'canceled'].includes(receipt.delivery)) continue
    next = { ...next, [mutation.mutationId]: { conversationId: state.conversation.id, turn: structuredClone(receipt) } }
  }
  if (next !== previous) client.setQueryData(agentChatReadbacksKey, next)
}

/** Readback can suppress an unresolved warning only for this exact conversation and request. */
export function confirmedCommandReceipt(record: AgentChatCommandRecord | undefined, state: AgentChatState | undefined): AgentChatTurn | undefined {
  const proof = record?.readback
  if (!proof || record?.command?.kind !== 'send' || proof.conversationId !== state?.conversation?.id
    || proof.turn.requestId !== record.command.input.requestId
    || record.result?.conversationId && record.result.conversationId !== proof.conversationId) return undefined
  return receiptForCommand(state, record.command, [proof.turn])
}

export function isRetirableAcknowledgement(record: Pick<AgentChatCommandRecord, 'status' | 'result' | 'readback'>, state?: AgentChatState): boolean {
  if (record.status === 'pending' || record.status === 'idle') return false
  if (record.status !== 'success' && !record.readback) return false
  const turn = record.readback?.turn ?? currentCommandReceipt(record.result, state) ?? record.result?.turn
  if (!turn && record.result?.receipt) return ['completed', 'failed', 'canceled'].includes(record.result.receipt.state)
  // Keep unresolved input even after HTTP success: accepted/queued work can still become unknown.
  // A successful control has no turn; a send retires only after positive terminal readback.
  return !turn || ['completed', 'failed', 'canceled'].includes(turn.delivery)
}

/** Bound terminal acknowledgements across this QueryClient, including recovered HTTP errors.
 * Pending and genuinely unresolved identities are never aged out or replayed. */
export function retireAgentChatAcknowledgements(client: QueryClient): void {
  const cache = client.getMutationCache()
  const readbacks = client.getQueryData<AgentChatReadbacks>(agentChatReadbacksKey) ?? {}
  const acknowledged = cache.getAll().filter((mutation) => {
    const key = mutation.options.mutationKey
    if (key?.length !== 4 || key[0] !== 'agent-chat' || key[3] !== 'command') return false
    const state = client.getQueryData<AgentChatState>([...key.slice(0, 3), 'state'])
    return isRetirableAcknowledgement({ status: mutation.state.status, result: mutation.state.data as AgentChatCommandResult | undefined,
      readback: readbacks[mutation.mutationId] }, state)
  })
  for (const mutation of acknowledged.sort((left, right) => agentChatCommandOrder(left) - agentChatCommandOrder(right)).slice(0, -AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)) cache.remove(mutation)
  // Proof has exactly the mutation's lifetime; retirement cannot leave a second unbounded cache.
  const retained = new Set(cache.getAll().map((mutation) => mutation.mutationId))
  const entries = Object.entries(readbacks).filter(([id]) => retained.has(Number(id)))
  if (entries.length !== Object.keys(readbacks).length) client.setQueryData(agentChatReadbacksKey, Object.fromEntries(entries))
}
