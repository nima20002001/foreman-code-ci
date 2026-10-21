import type { Message, OperatorActivity } from '@foreman-code/contracts'

/** Keep old activity beside its request, not below every later reply. Public sequence
 * boundaries take precedence; completed-message fallback uses the matching last reply. */
export function placeChatActivities(messages: readonly Message[], activities: readonly OperatorActivity[], activeRequestId?: string) {
  const before = new Map<string, OperatorActivity[]>(), after = new Map<string, OperatorActivity[]>()
  const earlier: OperatorActivity[] = [], trailing: OperatorActivity[] = []
  for (const entry of activities) {
    const related = messages.filter((message) => message.requestId === entry.requestId)
    const replies = related.filter((message) => message.role === 'assistant')
    const lastReply = replies.at(-1)
    const target = replies.find((message) => message.afterActivitySequence !== undefined
      && BigInt(message.afterActivitySequence) >= BigInt(entry.sequence))
      ?? (lastReply?.afterActivitySequence === undefined ? lastReply : undefined)
    const anchor = target ?? related.at(-1)
    if (anchor) {
      const placement = target ? before : after
      placement.set(anchor.id, [...(placement.get(anchor.id) ?? []), entry])
    } else if (entry.requestId === activeRequestId) trailing.push(entry)
    else earlier.push(entry)
  }
  // All activity rows share the history list as their parent. An anchor change must
  // not move a disclosure into a different message subtree (and remount it).
  const rows = [
    ...earlier.map((entry) => ({ entry, beforeMessageId: messages[0]?.id })),
    ...messages.flatMap((message, index) => [
      ...(before.get(message.id) ?? []).map((entry) => ({ entry, beforeMessageId: message.id })),
      ...(after.get(message.id) ?? []).map((entry) => ({ entry, beforeMessageId: messages[index + 1]?.id })),
    ]),
    ...trailing.map((entry) => ({ entry, beforeMessageId: undefined })),
  ]
  return { before, after, earlier, trailing, rows }
}
