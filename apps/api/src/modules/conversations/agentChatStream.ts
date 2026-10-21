import type { AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'

export const AGENT_CHAT_FRAME_BYTES = 512 * 1024

/** Same readback fallback as Operator chat; never truncate an approval/result or
 * imply it is absent. HTTP state/history remains authoritative for large values.
 * The ordinary first frame is a snapshot; an oversized payload invalidates state
 * instead, which the existing Agent-chat client already handles by refetching.
 */
export function agentChatStreamFrame(event: AgentChatStreamEvent): string {
  const encode = (value: AgentChatStreamEvent) => `event: ${value.type}\nid: ${value.id}\ndata: ${JSON.stringify(value)}\n\n`
  const frame = encode(event)
  if (Buffer.byteLength(frame) <= AGENT_CHAT_FRAME_BYTES) return frame
  return encode({ id: event.id, conversationId: event.conversationId, type: 'state', data: { snapshotRequired: true } })
}
