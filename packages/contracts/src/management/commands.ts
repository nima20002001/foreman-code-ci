import { z } from 'zod'

export const CommandIdSchema = z.string().trim().min(8).max(200)
export const ExpectedRevisionSchema = z.number().int().nonnegative()

/** Omission starts a new command; a supplied identity keeps retry replay unchanged. */
export function optionalCommandId(schema: z.ZodType<string, string>) {
  return schema.default(() => globalThis.crypto.randomUUID())
    .describe('Optional retry identity; generated when omitted. Supply the same ID and input for replay.')
}
