import { nativeTextPartKey as operatorTextPartKey, type ChatTimelineEntry } from '../conversations/chatTimeline'
import { ActivityChangeEnvelopeV1Schema, type Message } from '@foreman-code/contracts'
import { TextTruncationSchema } from '@foreman-code/contracts/activity-text'

export const OPERATOR_TEXT_ITEMS = 128
export const OPERATOR_TEXT_BYTES = 128 * 1024
export const OPERATOR_TIMELINE_ITEMS = 512


export { nativeTextPartKey as operatorTextPartKey } from '../conversations/chatTimeline'
export type OperatorTimelineEntry = ChatTimelineEntry
/** Bounded presentation bridge between notifications and Query-owned canonical reads.
 * Discarded on rebootstrap; never owns persisted text, lifecycle or scope revision. */
export interface OperatorTextProjection { requestId: string; parts: Record<string, string>; timeline: OperatorTimelineEntry[]; finalParts?: Record<string, true>; seen?: string[];
  truncations?: Record<string, NonNullable<Message['truncation']>> }

export function projectOperatorActivity(previous: OperatorTextProjection | undefined, activeRequestId: string | null,
  requestId: string, id: string): OperatorTextProjection | undefined {
  if (!activeRequestId || requestId !== activeRequestId) return previous
  const current = previous?.requestId === requestId ? previous : { requestId, parts: {}, timeline: [] }
  if (current.timeline.length >= OPERATOR_TIMELINE_ITEMS) return current
  if (current.timeline.some((entry) => entry.kind === 'activity' && entry.id === id)) return current
  return { ...current, timeline: [...current.timeline, { kind: 'activity', id }] }
}
export function projectOperatorText(previous: OperatorTextProjection | undefined, activeRequestId: string | null,
  data: Record<string, unknown>): OperatorTextProjection | undefined {
  if (!activeRequestId || data.requestId !== activeRequestId || typeof data.text !== 'string'
    || typeof data.partId !== 'string' || !['append', 'replace'].includes(String(data.mode))) return previous
  const current = previous?.requestId === activeRequestId ? previous : { requestId: activeRequestId, parts: {}, timeline: [] }
  const truncation = TextTruncationSchema.optional().safeParse(data.truncation)
  if (!truncation.success) return previous
  if (current.finalParts?.[data.partId]) return current
  const before = current.parts[data.partId] ?? ''
  const after = data.mode === 'replace' ? data.text : before + data.text
  if (!(data.partId in current.parts) && Object.keys(current.parts).length >= OPERATOR_TEXT_ITEMS) return current
  const bytes = new TextEncoder().encode(after).byteLength + Object.entries(current.parts).reduce((total, [id, text]) => id === data.partId ? total : total + new TextEncoder().encode(text).byteLength, 0)
  if (bytes > OPERATOR_TEXT_BYTES || current.timeline.length >= OPERATOR_TIMELINE_ITEMS && data.mode === 'append') return current
  let timeline = current.timeline
  if (!data.partId.startsWith('thinking:') && before !== after) {
    if (!after.startsWith(before)) timeline = timeline.filter((entry) => entry.kind !== 'text' || entry.partId !== data.partId)
    const addition = after.startsWith(before) ? after.slice(before.length) : after
    const last = timeline.at(-1)
    timeline = !addition ? timeline : last?.kind === 'text' && last.partId === data.partId
      ? [...timeline.slice(0, -1), { ...last, text: last.text + addition }]
      : [...timeline, { kind: 'text', id: `${data.partId}:${timeline.length}`, partId: data.partId, text: addition }]
  }
  const truncations = { ...current.truncations }
  if (truncation.data) truncations[data.partId] = truncation.data
  else if (data.mode === 'replace') delete truncations[data.partId]
  return { ...current, requestId: activeRequestId,
    ...(current.truncations || truncation.data ? { truncations } : {}),
    ...(data.final === true ? { finalParts: { ...current.finalParts, [data.partId]: true as const } } : {}),
    parts: { ...current.parts, [data.partId]: after }, timeline }
}


/** Only versioned, owned text is projected live. Unknown deltas require authoritative readback. */
export function projectOperatorEnvelope(previous: OperatorTextProjection | undefined, conversationId: string,
  activeRequestId: string | null, value: unknown, messages: readonly Message[]): OperatorTextProjection | undefined {
  const parsed = ActivityChangeEnvelopeV1Schema.safeParse(value)
  if (!parsed.success) return previous
  const envelope = parsed.data, change = envelope.change
  if (envelope.owner.kind !== 'chat_request' || envelope.owner.conversationId !== conversationId
    || envelope.owner.requestId !== activeRequestId || !envelope.native?.itemId
    || !['text.append', 'text.replace'].includes(change.kind)) return previous
  if (change.kind !== 'text.append' && change.kind !== 'text.replace' || change.channel === 'user') return previous
  const current = previous?.requestId === activeRequestId ? previous : undefined
  if (envelope.native.itemId !== change.itemId) return previous
  const nativeKey = operatorTextPartKey({ ...envelope.native, partId: change.partId ?? envelope.native.partId }, change.channel ?? 'assistant')
  const saved = messages.find((message) => message.requestId === activeRequestId && (message.activityNative
    ? operatorTextPartKey(message.activityNative, message.activityChannel) === nativeKey
    : message.nativeMessageId === change.itemId))
  // A reconnect may replay buffered deltas already represented by this canonical part.
  if (change.kind === 'text.append' && saved) return previous
  const eventKey = envelope.source.eventId ? JSON.stringify([envelope.owner, envelope.native, envelope.source.eventId]) : undefined
  if (eventKey && current?.seen?.includes(eventKey)) return previous
  if (current?.seen && current.seen.length >= 512 && change.kind === 'text.append') return previous
  const projected = projectOperatorText(current, activeRequestId, { requestId: envelope.owner.requestId, partId: nativeKey,
    text: change.text, truncation: change.truncation,
    mode: change.kind === 'text.append' ? 'append' : 'replace', final: change.finality === 'authoritative_final' })
  return projected && eventKey && (projected.seen?.length ?? 0) < 512 ? { ...projected, seen: [...(projected.seen ?? []), eventKey] } : projected
}
