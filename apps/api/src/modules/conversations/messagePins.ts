import { MessageAttachmentRefSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { DomainError } from '../errors.js'

/** Server-owned output pins are not new send inputs and do not consume the ten
 * input slots. Keep them separate so resume never re-delivers published output. */
export const MessagePublicationRefsSchema = MessageAttachmentRefSchema.array()
  .refine((refs) => new Set(refs.map((ref) => ref.fileId)).size === refs.length,
    'Attach a logical file at most once per message')

export function mergeMessagePins(...groups: readonly (readonly MessageAttachmentRef[])[]): MessageAttachmentRef[] {
  const byFile = new Map<string, MessageAttachmentRef>()
  for (const refs of groups) for (const ref of refs) {
    const prior = byFile.get(ref.fileId)
    if (prior && prior.revisionId !== ref.revisionId) throw new DomainError(
      'MESSAGE_PUBLICATION_CONFLICT', 'A different revision is already pinned to this message.', 409)
    byFile.set(ref.fileId, ref)
  }
  return MessagePublicationRefsSchema.parse([...byFile.values()])
}
