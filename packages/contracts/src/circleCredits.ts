import { z } from 'zod'

/**
 * CircleCI advertises 400,000 monthly credits for Linux open-source builds. This is a reporting estimate,
 * not an admission limit: Free-plan open-source builds continue when the credit balance is exhausted.
 * https://circleci.com/docs/guides/plans-pricing/credits/
 */
export const CIRCLE_OPEN_SOURCE_MONTHLY_CREDITS = 400_000

/** Reporting only: the configured allowance minus monthly compute usage, not CircleCI's available balance. */
export const CircleCreditsSchema = z.object({
  /** The configured monthly allowance. */
  total: z.number().nonnegative(),
  /** Compute credits used this calendar month (UTC), excluding storage and other charges. */
  used: z.number().nonnegative(),
  remaining: z.number().nonnegative(),
  /** When the usage was read from CircleCI. */
  asOf: z.string().datetime(),
}).strict()
export type CircleCredits = z.infer<typeof CircleCreditsSchema>

/** Spread into a CircleCI account's readback; `credits` is null with a short reason when the usage could not be read. */
export const circleCreditsShape = {
  credits: CircleCreditsSchema.nullable().optional(),
  creditsUnavailable: z.string().max(300).optional(),
}

/** Missing login identity on a saved reference always denotes the original primary login. */
export const DEFAULT_CIRCLE_ACCOUNT_ID = 'default'
export const CircleAccountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/,
  'Use 1-32 lowercase letters, digits or dashes.')
export const CircleAccountRoleSchema = z.enum(['primary', 'standby'])
export const CircleSchedulingRoleSchema = z.enum(['active', 'standby', 'exhausted'])
export type CircleAccountRole = z.infer<typeof CircleAccountRoleSchema>
export type CircleSchedulingRole = z.infer<typeof CircleSchedulingRoleSchema>
export const circleSchedulingShape = {
  schedulingRole: CircleSchedulingRoleSchema.optional(),
  schedulingReason: z.string().max(300).optional(),
  /** One recovery build may be admitted while this organization remains exhausted. */
  creditProbeAvailable: z.boolean().optional(),
}
