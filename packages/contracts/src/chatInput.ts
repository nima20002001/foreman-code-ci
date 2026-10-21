import { z } from 'zod'

export const WORKER_CHAT_MAX_JSON_BYTES = 1024 * 1024
export const CHAT_MAX_MESSAGE_CHARACTERS = 1_000_000
// Leave room for native session, configuration and conversation metadata in Worker requests.
export const CHAT_MAX_MESSAGE_JSON_BYTES = 768 * 1024

export function chatJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

const messageSizeError = 'Message and metadata must fit within 768 KiB of UTF-8 JSON. Shorten the message or send the content as an attachment.'

export const ChatMessageContentSchema = z.string().trim().max(CHAT_MAX_MESSAGE_CHARACTERS)
  .refine(value => chatJsonBytes(value) <= CHAT_MAX_MESSAGE_JSON_BYTES, messageSizeError)
  .describe('Message text, up to 768 KiB as UTF-8 JSON. Saved context and configuration also count toward the Worker 1 MiB request limit.')

export function refineChatMessageSize(value: unknown, context: z.RefinementCtx): void {
  if (chatJsonBytes(value) > CHAT_MAX_MESSAGE_JSON_BYTES) {
    context.addIssue({ code: 'custom', path: ['content'], message: messageSizeError })
  }
}
