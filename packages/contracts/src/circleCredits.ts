import { z } from 'zod'

/**
 * CircleCI's Free plan grants each organization 400,000 credits per month for Linux open-source builds and refills
 * them at the start of the next month; CircleCI exposes no API for this balance:
 * https://circleci.com/docs/guides/plans-pricing/credits/
 */
export const CIRCLE_OPEN_SOURCE_MONTHLY_CREDITS = 400_000

/** An estimate: the organization's monthly allowance minus the credits CircleCI's usage export reports for this month. */
export const CircleCreditsSchema = z.object({
  /** The configured monthly allowance. */
  total: z.number().nonnegative(),
  /** Credits used this calendar month (UTC) according to CircleCI's usage export. */
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
}
