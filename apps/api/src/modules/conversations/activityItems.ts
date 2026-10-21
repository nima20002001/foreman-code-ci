import type { ConversationPublicationReceipt } from './messagePublications.js'
import { ActivityItemSchema, InteractionSummarySchema, type ActivityItem, type ActivitySourceRevision, type InteractionSummary,
  type Message, type PendingNativeInteraction, type WorkRef } from '@foreman-code/contracts'

export function conversationTextItems(conversationId: string, messages: readonly Message[],
  binding: { harness: string; sessionId: string | null; turnIdFor(requestId: string): string | undefined }): ActivityItem[] {
  return messages.filter((message) => message.requestId && message.revision !== undefined && message.sequence !== undefined).map((message) => {
    const owner: WorkRef = { kind: 'chat_request', conversationId, requestId: message.requestId! }
    const turnId = binding.turnIdFor(message.requestId!)
    const body = message.activityChannel === 'reasoning' ? { kind: 'reasoning_summary', summary: message.content }
      : { kind: 'text', text: message.content, finality: message.nativeMessageComplete === false ? 'provisional' : 'authoritative_final' }
    return ActivityItemSchema.parse({ id: `message:${message.id}`, ...(message.activityChannel !== 'reasoning' ? { messageId: message.id, role: message.role } : {}),
      revision: message.revision, order: message.sequence, orderSource: 'conversation_message', owner,
      ...(message.activityChannel !== 'reasoning' && message.afterActivitySequence !== undefined ? { afterActivitySequence: message.afterActivitySequence } : {}),
      ...(message.activityNative ? { native: message.activityNative } : binding.sessionId && message.nativeMessageId ? { native: { harness: binding.harness, sessionId: binding.sessionId,
        itemId: message.nativeMessageId, ...(turnId ? { turnId } : {}) } } : {}),
      source: { schemaVersion: 1, system: 'conversation_message', observedAt: null }, evidence: 'confirmed',
      ...body })
  })
}
export function messageSourceRevisions(messages: readonly Message[]): ActivitySourceRevision[] {
  return messages.flatMap((message) => message.revision === undefined ? [] : [{ source: 'message' as const, id: message.id, revision: message.revision }])
}

/** A stored chat callback is projected from its own native request pointer, without allocating another receipt. */
export function chatInteractionSummary(input: { conversationId: string; requestId: string | null; revision: string;
  pending: PendingNativeInteraction | null; responseDelivery?: 'offered' | 'submitted' | 'uncertain' | null }): InteractionSummary[] {
  const { pending, requestId } = input
  if (!pending?.turn.nativeRequestId || !requestId) return []
  const generation = pending.session.harness === 'claude' && pending.request && typeof pending.request === 'object' && !Array.isArray(pending.request)
    && typeof pending.request.generation === 'string' && pending.request.generation.length ? pending.request.generation : undefined
  return [InteractionSummarySchema.parse({ id: JSON.stringify(['chat-interaction', input.conversationId, requestId, pending.turn.nativeRequestId]), revision: input.revision,
    sourceRevisions: [{ source: 'scope', id: input.conversationId, revision: input.revision }],
    owner: { kind: 'chat_request', conversationId: input.conversationId, requestId },
    native: { harness: pending.session.harness, sessionId: pending.session.nativeSessionId, turnId: pending.turn.nativeTurnId,
      ...(pending.turn.nativeMessageId ? { messageId: pending.turn.nativeMessageId } : {}), ...(generation ? { generation } : {}), requestId: pending.turn.nativeRequestId },
    delivery: input.responseDelivery === 'uncertain' ? 'uncertain' : input.responseDelivery === 'submitted' ? 'delivery_pending' : 'pending',
    // submitted is an effect fence, not recorded answer/acceptance evidence.
    answerRecorded: false, providerAcknowledged: false, workerAcknowledged: false, responseAvailability: 'unknown' })]
}

/** Finalized publication receipts may appear before adoption; text completion does not authorize them. */
export function conversationPublicationItems(conversationId: string, messages: readonly Message[], receipts: readonly ConversationPublicationReceipt[]): ActivityItem[] {
  return receipts.flatMap((receipt) => {
    const message = messages.find((entry) => entry.id === receipt.messageId)
    if (!message?.requestId || message.sequence === undefined) return []
    return [ActivityItemSchema.parse({ kind: 'file_publication', id: `publication:${receipt.receiptId}`, revision: receipt.fileActivityRevision,
      order: message.sequence, orderSource: 'file_publication', owner: { kind: 'chat_request', conversationId, requestId: message.requestId },
      native: 'nativeMessageId' in receipt
        ? { harness: 'claude', sessionId: receipt.nativeSessionId, messageId: receipt.nativeMessageId }
        : { harness: 'codex', sessionId: receipt.nativeSessionId, turnId: receipt.nativeTurnId },
      source: { schemaVersion: 1, system: 'file_tool_publication', observedAt: null }, evidence: 'confirmed',
      receiptId: receipt.receiptId, fileId: receipt.fileId, fileRevisionId: receipt.fileRevisionId, status: receipt.fileState === 'ready' ? 'ready' : 'unknown' })]
  })
}
