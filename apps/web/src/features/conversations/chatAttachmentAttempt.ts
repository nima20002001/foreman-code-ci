import type { Message } from '@foreman-code/contracts'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { ConversationAttachments } from '../attachments'

/** A local acknowledgement capability retained by the existing command owner, never serialized. */
export interface ChatAttachmentAttempt {
  readonly attachments: readonly MessageAttachmentRef[]
  acknowledge?: () => void
  /** Reject a stale handler after receipt reconciliation removed its selected files. */
  isCurrent?: () => boolean
}

export function prepareChatAttachments(draft: ConversationAttachments): ChatAttachmentAttempt | null {
  // A first text-only message can create a conversation; uploads cannot.
  if (!draft.hasAttachments) return { attachments: [] }
  const snapshot = draft.prepareSend()
  return snapshot === null || !snapshot.attachments.length ? null : {
    attachments: snapshot.attachments,
    acknowledge: () => draft.acknowledgeSent(snapshot),
    isCurrent: () => {
      const current = draft.prepareSend()
      return current !== null && sameAttachmentRefs(snapshot.attachments, current.attachments)
    },
  }
}

/** Readback pins come from each immutable revision, not the file's mutable discovery head. */
export function messageAttachmentRefs(message: Pick<Message, 'attachments'>): MessageAttachmentRef[] {
  return (message.attachments ?? []).map(({ revision }) => ({ fileId: revision.fileId, revisionId: revision.revisionId }))
}

/** Ordered pin comparison; omitted and empty attachments are the same text-only command. */
export function sameAttachmentRefs(left: readonly MessageAttachmentRef[] = [], right: readonly MessageAttachmentRef[] = []): boolean {
  return left.length === right.length && left.every((pin, index) =>
    pin.fileId === right[index].fileId && pin.revisionId === right[index].revisionId)
}

/** Receipt readback includes published outputs as well as the original input pins. */
export function containsAttachmentRefs(received: readonly MessageAttachmentRef[] = [], expected: readonly MessageAttachmentRef[] = []): boolean {
  return expected.every((input) => received.some((pin) =>
    pin.fileId === input.fileId && pin.revisionId === input.revisionId))
}
