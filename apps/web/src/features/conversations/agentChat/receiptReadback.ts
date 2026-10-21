import type { AgentChatState, AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import type { AgentChatCommandRecord } from './commandRecords'

type Command = NonNullable<AgentChatCommandRecord['command']>
// Only remembers a local side effect, not request/server state. Weak keys retire with mutations.
const reconciledDrafts = new WeakSet<Command>()

/** Match the actual admitted request, never just equal text or a neighboring conversation. */
export function receiptForCommand(state: AgentChatState | undefined, command: Command | undefined, receipts = state?.turns): AgentChatTurn | undefined {
  if (!state?.conversation || command?.kind !== 'send') return undefined
  const input = command.input, context = state.context
  if (input.context?.workflowId !== context.workflowId || input.context.workflowNodeId !== context.workflowNodeId
    || input.context.agentId !== context.agentId || input.context.runId !== context.runId
    || input.expectedConversationId !== null && input.expectedConversationId !== state.conversation.id) return undefined
  return receipts?.find((turn) => turn.requestId === input.requestId)
}

/** Reconcile an unchanged draft once, including GET/SSE readback after a lost POST response. */
export function claimDraftReadback(command: Command | undefined, receipt: AgentChatTurn | undefined): boolean {
  if (command?.kind !== 'send' || !command.clearDraft || !receipt || receipt.requestId !== command.input.requestId
    // Steer admission can still be discarded on a definite native rejection.
    || receipt.intent === 'steer' && receipt.delivery === 'submitting'
    || receipt.delivery === 'unknown' || receipt.delivery === 'failed' || reconciledDrafts.has(command)) return false
  reconciledDrafts.add(command)
  return true
}

/** Common admission is durable without inventing a native journal row. Failed/unknown input stays editable. */
export function claimDeliveryDraftReadback(command: Command | undefined, receipt: ChatDeliveryReceipt | undefined): boolean {
  if (command?.kind !== 'send' || !command.clearDraft || !receipt || receipt.commandId !== command.input.requestId
    || ['failed', 'unknown'].includes(receipt.state) || receipt.appliedIntent === 'steer' && receipt.state === 'submitting'
    || reconciledDrafts.has(command)) return false
  reconciledDrafts.add(command)
  return true
}
