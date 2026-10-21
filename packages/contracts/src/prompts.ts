import { z } from 'zod'

export const MAX_PROMPT_TEXT_LENGTH = 100_000
export const PromptTextSchema = z.object({ text: z.string().max(MAX_PROMPT_TEXT_LENGTH) }).strict()
export const DEFAULT_PROMPT_TEXT = { text: '' } as const

export const PromptSettingSnapshotSchema = z.object({
  value: PromptTextSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict()

export type PromptText = z.infer<typeof PromptTextSchema>
export type PromptSettingSnapshot = z.infer<typeof PromptSettingSnapshotSchema>
