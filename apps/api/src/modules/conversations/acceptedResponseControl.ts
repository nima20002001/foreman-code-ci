import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { withInteractionResponse, isSessionNativeInteraction, type OperatorConversationState, type PendingNativeInteraction,
  type InteractionResponseValue } from '@foreman-code/contracts'
import { AcceptedChatResponseControlSchema, type AcceptedChatResponseControl } from '@foreman-code/contracts/interaction-activity'

function responseNative(pending: PendingNativeInteraction): AcceptedChatResponseControl['native'] {
  const request = pending.request
  return { harness: pending.session.harness, providerVersion: pending.session.providerVersion, sessionId: pending.session.nativeSessionId,
    ...(pending.session.harness === 'claude' ? { messageId: pending.turn.nativeMessageId,
      generation: request && typeof request === 'object' && !Array.isArray(request) && typeof request.generation === 'string' ? request.generation : undefined }
      : { turnId: pending.turn.nativeTurnId }), requestId: pending.turn.nativeRequestId!, requestType: pending.nativeRequestType }
}

/** Capture only an offered, exact persisted request choice; receipt replay keeps its original metadata. */
export function acceptedResponseControl(state: AgentChatState, nativeRequestId: string, optionId: string,
  response?: InteractionResponseValue): AcceptedChatResponseControl | undefined {
  const pending = state.pendingInteraction, active = state.activeTurn, conversation = state.conversation, scope = state.activitySnapshot?.scope
  const option = pending?.responseOptions.find((candidate) => candidate.optionId === optionId)
  if (!pending || !conversation || !scope || !option || pending.turn.nativeRequestId !== nativeRequestId
    || conversation.nativeSession?.nativeSessionId !== pending.session.nativeSessionId
    || !isSessionNativeInteraction(pending) && (!active || active.nativeTurnId !== pending.turn.nativeTurnId)) return undefined
  if (pending.session.harness === 'claude') {
    const submission = state.turns.find((turn) => turn.requestId === active!.requestId)?.nativeSubmission
    if (!submission || submission.nativeSessionId !== pending.session.nativeSessionId || submission.nativeMessageId !== pending.turn.nativeMessageId) return undefined
  }
  const selected = withInteractionResponse(option, response)
  return AcceptedChatResponseControlSchema.parse({ schemaVersion: 1, kind: 'respond', conversationId: conversation.id,
    modelRequestId: active?.requestId ?? nativeRequestId, scope, native: responseNative(pending),
    choice: { optionId: option.optionId, semantic: option.semantic,
      ...(selected.response !== undefined ? { response: selected.response } : {}) } })
}

export function acceptedOperatorResponseControl(state: OperatorConversationState, requestId: string, nativeRequestId: string,
  optionId: string, response?: InteractionResponseValue): AcceptedChatResponseControl | undefined {
  const pending = state.pendingInteraction, scope = state.activitySnapshot?.scope
  const option = pending?.responseOptions.find((choice) => choice.optionId === optionId)
  if (!pending || !option || pending.turn.nativeRequestId !== nativeRequestId || !scope
    || (state.activeRequestId ?? (isSessionNativeInteraction(pending) ? nativeRequestId : undefined)) !== requestId) return undefined
  if (pending.session.harness === 'claude' && (!state.nativeSubmission || state.nativeSubmission.nativeSessionId !== pending.session.nativeSessionId
    || state.nativeSubmission.nativeMessageId !== pending.turn.nativeMessageId)) return undefined
  const selected = withInteractionResponse(option, response)
  return AcceptedChatResponseControlSchema.parse({ schemaVersion: 1, kind: 'respond', conversationId: state.conversation.id,
    modelRequestId: requestId, scope, native: responseNative(pending), choice: { optionId: option.optionId, semantic: option.semantic,
      ...(selected.response !== undefined ? { response: selected.response } : {}) } })
}
