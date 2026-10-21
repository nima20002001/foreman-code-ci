import type { Message } from '@foreman-code/contracts'

export type ChatTimelineEntry = { kind: 'activity'; id: string }
  | { kind: 'text'; id: string; partId: string; text: string }

export function nativeTextPartKey(native: NonNullable<Message['activityNative']>,
  channel: Message['activityChannel'] = 'assistant'): string {
  const identity = JSON.stringify([native.sessionId, native.turnId ?? null, native.itemId ?? null,
    native.partId ?? null, native.parentItemId ?? null, native.generation ?? null, channel])
  return channel === 'reasoning' ? `thinking:${identity}` : identity
}

export function messageTextPartKey(message: Message): string | undefined {
  return message.activityNative ? nativeTextPartKey(message.activityNative, message.activityChannel) : message.nativeMessageId
}

export function savedTextPartKeys(messages: readonly Message[], requestId: string | null | undefined): Set<string> {
  const keys = messages.filter(message => message.requestId === requestId).map(messageTextPartKey)
  return new Set(keys.filter((key): key is string => key !== undefined))
}

export function selectLiveTextTimeline(messages: readonly Message[], requestId: string | null | undefined,
  timeline: readonly ChatTimelineEntry[]): ChatTimelineEntry[] {
  const saved = savedTextPartKeys(messages, requestId)
  return timeline.filter(item => item.kind === 'activity' || !saved.has(item.partId))
}
