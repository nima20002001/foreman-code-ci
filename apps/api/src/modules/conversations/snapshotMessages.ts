import { omitProperties } from '../../shared/omitProperties.js'
import { MessageSchema, type Message } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

function preview(message: Message, budget: number): Message {
  // Full original input and hydrated file metadata remain available through exact history.
  const identity = omitProperties(message, ['originalInput', 'attachments', 'acceptedModel'])
  const originalBytes = Math.max(Buffer.byteLength(message.content), message.truncation?.originalBytes ?? 0)
  const result = { ...identity, content: '', truncation: { truncated: true as const, originalBytes } }
  if (Buffer.byteLength(JSON.stringify(result)) > budget) {
    throw new DomainError('CHAT_MESSAGE_IDENTITY_TOO_LARGE', 'The message identity exceeds its bounded snapshot window. Read exact history.', 413)
  }
  let low = 0, high = message.content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const size = Buffer.byteLength(JSON.stringify({ ...result, content: message.content.slice(0, middle) }))
    if (size <= budget) low = middle
    else high = middle - 1
  }
  if (low < message.content.length && /[\uD800-\uDBFF]/.test(message.content[low - 1] ?? '')) low--
  return { ...result, content: message.content.slice(0, low) }
}

/** Retain the newest message as a bounded preview; history still returns its immutable full body. */
export function boundedConversationMessages(values: unknown[], budget: number): Message[] {
  let bytes = 2 // JSON array delimiters
  const retained: Message[] = []
  for (const value of [...values].reverse()) {
    let message = MessageSchema.parse(value)
    let size = Buffer.byteLength(JSON.stringify(message))
    const separator = retained.length ? 1 : 0
    if (retained.length && bytes + separator + size > budget) break
    if (bytes + size > budget) {
      message = preview(message, budget - bytes)
      size = Buffer.byteLength(JSON.stringify(message))
    }
    retained.push(message); bytes += separator + size
  }
  return retained.reverse()
}
