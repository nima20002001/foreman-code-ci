import type { Message } from '@foreman-code/contracts'
import { inheritCommittedRevision } from './committedMessageRevision'

type NativeMessage = Omit<Message, 'conversationId'>
const encoder = new TextEncoder()
const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength

/** Exact-message expansion has its own cache; the live window always retains a bounded latest preview. */
function preview<T extends NativeMessage>(message: T, budget: number): T | undefined {
  if (sizeOf(message) <= budget) return message
  const originalBytes = Math.max(encoder.encode(message.content).byteLength, message.truncation?.originalBytes ?? 0)
  const identity = { ...message, originalInput: undefined, attachments: undefined, acceptedModel: undefined,
    content: '', truncation: { truncated: true, originalBytes } }
  if (sizeOf(identity) > budget) return undefined
  let low = 0, high = message.content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (sizeOf({ ...identity, content: message.content.slice(0, middle) }) <= budget) low = middle
    else high = middle - 1
  }
  if (/[\uD800-\uDBFF]/.test(message.content[low - 1] ?? '')) low--
  return inheritCommittedRevision({ ...identity, content: message.content.slice(0, low) }, message)
}

export function boundedNativeWindow<T extends NativeMessage>(messages: readonly T[], budget = 256 * 1024) {
  const ordered = [...messages].sort((a, b) => a.sequence !== undefined && b.sequence !== undefined
    ? BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0 : 0)
  const retained: T[] = []
  let bytes = 2
  for (const original of ordered.reverse()) {
    if (retained.length === 100) break
    const separator = retained.length ? 1 : 0
    const message = retained.length ? original : preview(original, budget - bytes)
    if (!message) return undefined
    const size = sizeOf(message)
    if (bytes + separator + size > budget) break
    retained.push(message); bytes += separator + size
  }
  return { messages: retained.reverse(), omitted: retained.length < messages.length }
}

export function nativeMessageAtLeastAsNew(candidate: NativeMessage, current: NativeMessage) {
  if (candidate.id !== current.id || current.nativeMessageComplete && !candidate.nativeMessageComplete) return false
  return current.revision === undefined || candidate.revision !== undefined && BigInt(candidate.revision) >= BigInt(current.revision)
}
