import { MessageSchema, type Message } from '@foreman-code/contracts'
import { mergeChatMessages } from '../agentChat/model'
import { boundedNativeWindow } from './nativeMessageWindow'
import { rememberCommittedRevision } from './committedMessageRevision'

export type CommittedMessage = { message: Message; scopeRevision: string }
const encoder = new TextEncoder()

/** Only full, versioned committed rows can replace text; opaque native deltas request readback. */
export function committedMessage(data: Record<string, unknown>, conversationId: string, requestId?: string | null): CommittedMessage | undefined {
  const parsed = MessageSchema.safeParse(data.message)
  if (!parsed.success || typeof data.scopeRevision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.scopeRevision)) return undefined
  const message = parsed.data
  if (message.conversationId !== conversationId || !requestId || message.requestId !== requestId
    || message.revision === undefined || message.sequence === undefined || !message.activityNative?.sessionId
    || !message.activityNative.itemId || message.role !== 'assistant' || message.activityChannel === 'reasoning') return undefined
  if (encoder.encode(JSON.stringify(message)).byteLength > 64 * 1024) return undefined
  return { message, scopeRevision: data.scopeRevision }
}

export function patchCommittedMessages<T extends { messages: Message[]; revision: number; hasEarlierMessages?: boolean }>(
  previous: T, incoming: readonly CommittedMessage[], conversationId: string, requestId?: string | null): T {
  const replacements = incoming.filter(item => item.message.conversationId === conversationId && item.message.requestId === requestId
    && BigInt(item.scopeRevision) > BigInt(previous.revision)).map(({ message, scopeRevision }) => {
    const prior = previous.messages.find(item => item.id === message.id)
    return rememberCommittedRevision({ ...message, attachments: message.attachments ?? prior?.attachments, acceptedModel: message.acceptedModel ?? prior?.acceptedModel,
      originalInput: message.originalInput ?? prior?.originalInput }, scopeRevision)
  })
  if (!replacements.length) return previous
  const window = boundedNativeWindow(mergeChatMessages(previous.messages, replacements))
  return window ? { ...previous, messages: window.messages, hasEarlierMessages: previous.hasEarlierMessages || window.omitted } : previous
}

export function createCommittedMessageBuffer(apply: (messages: CommittedMessage[]) => void, fallback: () => void) {
  const pending = new Map<string, CommittedMessage>()
  let bytes = 0, timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { clearTimeout(timer); timer = undefined; pending.clear(); bytes = 0 }
  return { clear, push(item: CommittedMessage) {
    const prior = pending.get(item.message.id)
    if (prior && BigInt(prior.message.revision!) >= BigInt(item.message.revision!)) return
    const size = encoder.encode(JSON.stringify(item)).byteLength
    bytes += size - (prior ? encoder.encode(JSON.stringify(prior)).byteLength : 0)
    if (pending.size >= 100 && !prior || bytes > 256 * 1024) { clear(); fallback(); return }
    pending.set(item.message.id, item)
    timer ??= setTimeout(() => { const messages = [...pending.values()]; clear(); apply(messages) }, 100)
  } }
}
