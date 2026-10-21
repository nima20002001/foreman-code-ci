import { asRecord } from '../../shared/records.js'
import { TextTruncationSchema, type TextTruncation } from '@foreman-code/contracts/activity-text'
import type { NativeHarnessEvent, RecordedAgentHarness } from '@foreman-code/contracts'

/** Deltas are presentation-only; completed public message items are persisted separately. */
export function nativeAssistantText(event: NativeHarnessEvent): Array<{ partId: string; text: string; mode: 'append' | 'replace' }> {
  const payload = event.payload
  if (payload.subagentNativeId || event.type === 'native.unlinked_notification') return []
  if (event.type === 'claude.text' && !payload.parentToolUseId && typeof payload.itemId === 'string'
    && typeof payload.text === 'string' && (payload.operation === 'append' || payload.operation === 'replace')) {
    return [{ partId: payload.itemId, text: payload.text, mode: payload.operation }]
  }
  const method = typeof payload.nativeMethod === 'string' ? payload.nativeMethod : event.type
  if (method === 'item/reasoning/summaryTextDelta' && typeof payload.delta === 'string') {
    return [{ partId: `thinking:${String(payload.itemId ?? 'reasoning')}`, text: payload.delta, mode: 'append' }]
  }
  if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
    return [{ partId: String(payload.itemId ?? 'assistant'), text: payload.delta, mode: 'append' }]
  }
  if (event.type === 'assistant.delta' && typeof payload.text === 'string') {
    return [{ partId: String(payload.itemId ?? 'assistant'), text: payload.text, mode: 'append' }]
  }
  const item = asRecord(payload.item)
  if (event.type === 'item.completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
    return [{ partId: String(item.id ?? 'assistant'), text: item.text, mode: 'replace' }]
  }
  return []
}

export function completedNativeAssistantMessage(event: NativeHarnessEvent, harness: RecordedAgentHarness):
  { id: string; text: string; parentMessageId?: string; complete?: boolean; truncation?: TextTruncation } | undefined {
  if (event.payload.subagentNativeId || event.type === 'native.unlinked_notification') return undefined
  if (harness === 'claude' && event.type === 'claude.text' && !event.payload.parentToolUseId
    && event.payload.operation === 'replace' && typeof event.payload.itemId === 'string'
    && typeof event.payload.text === 'string') {
    const parentMessageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : undefined
    // Without block-parent identity, a provisional snapshot cannot use the terminal-message path.
    if (!parentMessageId && event.payload.final !== true) return undefined
    const truncation = TextTruncationSchema.optional().parse(event.payload.truncation)
    return { ...(truncation ? { truncation } : {}), id: event.payload.itemId, text: event.payload.text, complete: event.payload.final === true,
      ...(parentMessageId ? { parentMessageId } : {}) }
  }
  if (harness === 'codex' && event.type === 'item.completed') {
    const item = asRecord(event.payload.item)
    if (item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
      return { id: item.id, text: item.text }
    }
  }
  return undefined
}
