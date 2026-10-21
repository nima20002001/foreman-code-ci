import { ApiError } from '../../../shared/api/client'
import type { DeliveryReadback } from './client'
import { boundedNativeWindow, nativeMessageAtLeastAsNew } from './nativeMessageWindow'

/** Committed stream revisions fence in-flight HTTP reads, while a successful newer page owns its cursor. */
export function acceptDeliveryReadback(previous: DeliveryReadback | undefined, incoming: DeliveryReadback): DeliveryReadback {
  if (!previous || !('messages' in previous) || !('messages' in incoming)) return incoming
  if (incoming.revision < previous.revision) {
    throw new ApiError({ code: 'CHAT_READBACK_STALE', message: 'Newer committed messages are visible. Refresh this message window.' }, 409)
  }
  const prior = new Map(previous.messages.map(message => [message.id, message]))
  const messages = incoming.messages.map(message => {
    const current = prior.get(message.id)
    return current && !nativeMessageAtLeastAsNew(message, current) ? current : message
  })
  if (incoming.revision === previous.revision) {
    const ids = new Set(messages.map(message => message.id))
    messages.push(...previous.messages.filter(message => !ids.has(message.id)))
  }
  const window = boundedNativeWindow(messages)
  if (!window) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The native message identity exceeds its read window.' }, 413)
  return { ...incoming, messages: window.messages, hasMore: incoming.hasMore || window.omitted }
}
