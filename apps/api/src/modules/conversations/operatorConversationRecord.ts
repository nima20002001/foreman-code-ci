import { ConversationSchema } from '@foreman-code/contracts'
import { NativeNonSubmissionSchema } from './nativeNonSubmission.js'

export const OperatorConversationRecordSchema = ConversationSchema.safeExtend({
  nativeNonSubmission: NativeNonSubmissionSchema.optional(),
})

export function publicOperatorConversation(record: unknown) {
  const conversation = OperatorConversationRecordSchema.parse(record)
  delete conversation.nativeNonSubmission
  return ConversationSchema.parse(conversation)
}
