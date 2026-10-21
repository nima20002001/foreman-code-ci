import { z } from 'zod';
import { IdSchema, OptionalTimestampFields } from './schemaPrimitives.js';
import { RecordedAgentHarnessSchema } from './harnessIdentity.js';
import { FileWithRevisionSchema, MessageAttachmentRefsSchema } from './files.js';
import { ActivityNativeIdentitySchema } from './activity.js';
import { TextTruncationSchema } from './activityText.js';

const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const MessageSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    requestId: IdSchema.optional(),
    /** Read projection of this message's immutable accepted turn configuration. */
    acceptedModel: z.object({ harness: RecordedAgentHarnessSchema, model: z.string().trim().min(1) }).strict().optional(),
    activityChannel: z.enum(["assistant", "user", "reasoning"]).optional(),
    activityNative: ActivityNativeIdentitySchema.optional(),
    revision: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    sequence: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    /** Exact admitted send source; displayed publications are never new send inputs. */
    originalInput: z.object({ requestId: IdSchema, content: z.string(), attachments: MessageAttachmentRefsSchema }).strict().nullable().optional(),
    nativeMessageId: IdSchema.optional(),
    /** OpenCode text-part identity is nativeMessageId; this is its assistant message. */
    nativeParentMessageId: IdSchema.optional(),
    nativeMessageComplete: z.boolean().optional(),
    truncation: TextTruncationSchema.optional(),
    afterActivitySequence: z.string().regex(/^[0-9]+$/).optional(),
    role: MessageRoleSchema,
    content: z.string(),
    /** Pinned input and published-output metadata. The ten-file limit applies to sends, not readback.
     * Lifecycle state is resolved at read time, not frozen on send. */
    attachments: z.array(FileWithRevisionSchema).optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const NativeSourceMessageSchema = MessageSchema.omit({ conversationId: true });
export type NativeSourceMessage = z.infer<typeof NativeSourceMessageSchema>;
