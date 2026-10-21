import { z } from 'zod'
import { CIRCLE_OPEN_SOURCE_MONTHLY_CREDITS } from '../circleCredits.js'
import { optionalCommandId } from './commands.js'

const credits = z.number().int().min(0).max(1_000_000_000)
/** Monthly compute reporting allowance per CircleCI organization; it does not control admission. */
export const CircleCreditAllowanceSchema = z.object({
  defaultMonthlyCredits: credits,
  accounts: z.record(z.string().trim().min(1).max(100), credits)
    .refine(value => Object.keys(value).length <= 64, 'Use at most 64 accounts.'),
}).strict()
export const DEFAULT_CIRCLE_CREDIT_ALLOWANCE = CircleCreditAllowanceSchema.parse({
  defaultMonthlyCredits: CIRCLE_OPEN_SOURCE_MONTHLY_CREDITS, accounts: {},
})
export const ManagedCircleCreditAllowanceSchema = z.object({
  value: CircleCreditAllowanceSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict()
export const CircleCreditAllowanceUpdateInputSchema = z.object({
  value: CircleCreditAllowanceSchema,
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
}).strict()
export const CircleCreditAllowanceUpdateResultSchema = z.object({
  value: ManagedCircleCreditAllowanceSchema,
  replayed: z.boolean(),
}).strict()
export type CircleCreditAllowance = z.infer<typeof CircleCreditAllowanceSchema>
export type CircleCreditAllowanceUpdateInput = z.infer<typeof CircleCreditAllowanceUpdateInputSchema>
