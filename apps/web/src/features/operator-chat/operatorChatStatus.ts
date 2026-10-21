import type { OperatorConversationState, OperatorConversationSummary } from '@foreman-code/contracts'
import type { AgentChatSessionState } from '@foreman-code/contracts/agent-chat'
import { chatBackgroundWork } from '../conversations/chatWorkStatus'
import { chatStatus } from '../conversations/chatStatus'
import type { OperatorChatConnection } from '../../shared/api/operatorChatStream'

export function operatorNeedsAttention(state: OperatorConversationState): boolean {
  return Boolean(state.pendingInteraction && state.responseDelivery === 'offered'
    && state.turnState !== 'canceling')
}

export function summarizeOperatorConversation(state: OperatorConversationState): OperatorConversationSummary {
  return { conversationId: state.conversation.id, title: state.conversation.title,
    revision: state.revision, activeRequestId: state.activeRequestId, turnState: state.turnState,
    needsAttention: operatorNeedsAttention(state), ...(state.activitySnapshot ? { backgroundActivity: chatBackgroundWork(state.activitySnapshot)?.evidence ?? null } : {}) }
}

export function operatorNavigationStatus(summary: OperatorConversationSummary): string {
  if (summary.turnState === 'canceling') return 'Cancellation requested'
  if (summary.needsAttention) return 'Needs your decision'
  if (summary.turnState === 'uncertain') return 'State uncertain'
  if (summary.activeRequestId || ['active', 'starting'].includes(summary.turnState)) return 'Running'
  if (summary.turnState === 'error') return 'Turn failed'
  if (summary.backgroundActivity) return summary.backgroundActivity === 'unknown' ? 'Unfinished work unconfirmed' : 'Background work continues'
  return 'Ready'
}

export function operatorTurnStatus(state: OperatorConversationState, connection: OperatorChatConnection, snapshotFresh = false): string {
  const background = !state.activeRequestId && !['active', 'starting'].includes(state.turnState) ? chatBackgroundWork(state.activitySnapshot) : undefined
  let phase: AgentChatSessionState = 'idle'
  let executionLabel: string | undefined
  if (state.turnState === 'canceling') phase = 'interrupting'
  else if (state.turnState === 'uncertain') phase = 'uncertain'
  else if (operatorNeedsAttention(state)) {
    phase = 'waiting_approval'
    executionLabel = 'Waiting for your decision.'
  } else if (state.activeRequestId || ['active', 'starting'].includes(state.turnState)) {
    phase = state.turnState === 'starting' ? 'creating' : 'active'
    executionLabel = 'Operator is working…'
  } else if (state.turnState === 'error') {
    phase = 'error'
    executionLabel = 'The turn failed.'
  } else if (background) executionLabel = `${background.label}. ${background.message}`
  else executionLabel = state.lastResult ? '' : 'Ready for your message.'
  const delivery = state.pendingInteraction && state.responseDelivery !== 'offered'
    ? 'Checking delivery of your decision.' : undefined
  const presentation = chatStatus({ phase, connection, snapshotFresh, hasConversation: true,
    ...(executionLabel !== undefined ? { executionLabel } : {}), ...(delivery ? { delivery } : {}) })
  return [presentation.connection, presentation.execution, presentation.delivery].filter(Boolean).join(' ')
}

/** Late summary polls cannot undo a decision already acknowledged by a newer revision. */
export function newerOperatorSummaries(
  current: readonly OperatorConversationSummary[] | undefined,
  next: readonly OperatorConversationSummary[],
): OperatorConversationSummary[] {
  const existing = new Map(current?.map((item) => [item.conversationId, item]))
  return next.map((item) => {
    const previous = existing.get(item.conversationId)
    return previous && previous.revision > item.revision ? previous : item
  })
}
