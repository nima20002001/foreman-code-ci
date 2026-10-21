import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { ClaudeDecodedEvent } from './normalization.js'

/** sequence is the existing adapter transport cursor, not an SDK native sequence.
 * Source uses actual SDK eventId/result_index and deliberately omits that cursor. */
export function claudeNativeEvent(event: ClaudeDecodedEvent, sequence: number): NativeHarnessEvent {
  const { evidence, change } = event
  return { sequence, occurredAt: evidence.observedAt, type: `claude.${change.kind}`, payload: {
    ...change, source: { ...(evidence.eventId ? { eventId: evidence.eventId } : {}), observedAt: evidence.observedAt,
      ...(change.kind === 'result' && change.resultIndex !== undefined ? { sequence: String(change.resultIndex) } : {}) },
    owner: evidence.owner, promptUuids: evidence.promptUuids,
    ...(evidence.nativeSessionId ? { nativeSessionId: evidence.nativeSessionId } : {}),
    ...(evidence.messageId ? { messageId: evidence.messageId } : {}),
    ...(evidence.messageUuid ? { messageUuid: evidence.messageUuid } : {}),
    ...(evidence.contentIndex !== undefined ? { contentIndex: evidence.contentIndex } : {}),
    ...(evidence.parentToolUseId ? { parentToolUseId: evidence.parentToolUseId } : {}),
    ...(evidence.toolUseId ? { toolUseId: evidence.toolUseId } : {}),
  } }
}
