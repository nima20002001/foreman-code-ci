import type { OperatorConversationState } from '@foreman-code/contracts'

export const OPERATOR_BOOTSTRAP_FRAME_BYTES = 512 * 1024

/** History has its own HTTP pages. Never wedge reconnect on a single large native payload. */
export function operatorChatBootstrapFrame(state: OperatorConversationState): string {
  const frame = `id: ${state.revision}\nevent: snapshot\ndata: ${JSON.stringify(state)}\n\n`
  if (Buffer.byteLength(frame) <= OPERATOR_BOOTSTRAP_FRAME_BYTES) return frame
  // Do not describe omitted approval/result payloads as absent. This existing
  // state event is an authoritative invalidation, not a replacement snapshot.
  // Clients refetch GET for full current state, independently of SSE frame limits.
  const event = {
    id: state.revision, conversationId: state.conversation.id, type: 'state',
    data: {
      revision: state.revision, activeRequestId: state.activeRequestId, turnState: state.turnState,
      hasPendingInteraction: Boolean(state.pendingInteraction),
      ...(state.responseDelivery ? { responseDelivery: state.responseDelivery } : {}),
      snapshotRequired: true,
    },
  }
  return `id: ${state.revision}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`
}
