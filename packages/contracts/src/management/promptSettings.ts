import { optionalCommandId } from './commands.js'
import { z } from 'zod'
import { PromptTextSchema, PromptSettingSnapshotSchema } from '../prompts.js'
export {
  PromptTextSchema, DEFAULT_PROMPT_TEXT, MAX_PROMPT_TEXT_LENGTH, PromptSettingSnapshotSchema,
} from '../prompts.js'
export type { PromptText, PromptSettingSnapshot } from '../prompts.js'

export const ManagedPromptSettingSchema = PromptSettingSnapshotSchema

export const PromptSettingUpdateInputSchema = z.object({
  value: PromptTextSchema,
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
}).strict()

export const PromptSettingUpdateResultSchema = z.object({
  value: ManagedPromptSettingSchema,
  replayed: z.boolean(),
}).strict()

export type PromptSettingUpdateInput = z.infer<typeof PromptSettingUpdateInputSchema>
