import { optionalCommandId } from './commands.js'
import { z } from 'zod'

export const ThemeSchema = z.enum(['dark', 'light'])
export const GeneralSettingsSchema = z.object({ theme: ThemeSchema }).strict()
export const DEFAULT_GENERAL_SETTINGS = { theme: 'dark' } as const
export const ManagedGeneralSettingsSchema = z.object({
  value: GeneralSettingsSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict()
export const GeneralSettingsUpdateInputSchema = z.object({
  value: GeneralSettingsSchema,
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
}).strict()
export const GeneralSettingsUpdateResultSchema = z.object({
  value: ManagedGeneralSettingsSchema,
  replayed: z.boolean(),
}).strict()
export type Theme = z.infer<typeof ThemeSchema>
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>
export type ManagedGeneralSettings = z.infer<typeof ManagedGeneralSettingsSchema>
export type GeneralSettingsUpdateInput = z.infer<typeof GeneralSettingsUpdateInputSchema>
