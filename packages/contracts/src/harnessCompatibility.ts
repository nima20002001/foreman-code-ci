import { z } from 'zod'

/** Diagnostics only. These types deliberately cannot represent execution authorization. */
export const CompatibilityHarnessSchema = z.enum(['codex'])
export type CompatibilityHarness = z.infer<typeof CompatibilityHarnessSchema>
const HarnessCompatibilityStatusSchema = z.enum([
  'not-checked', 'checking', 'probe-passed', 'probe-failed', 'unavailable',
])
export const HarnessCompatibilityReasonSchema = z.object({
  code: z.string().regex(/^[A-Z_]+$/).max(100),
  message: z.string().min(1).max(1000),
}).strict()
export const HarnessCompatibilitySchema = z.object({
  harness: CompatibilityHarnessSchema,
  checkId: z.string().uuid(),
  installedVersion: z.string().min(1).max(100).nullable(),
  status: HarnessCompatibilityStatusSchema,
  checkedAt: z.string().datetime().nullable(),
  source: z.enum(['none', 'local-probe', 'cache']),
  checkerRevision: z.string().min(1).max(100),
  reason: HarnessCompatibilityReasonSchema.nullable(),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  cacheWarning: z.string().max(1000).nullable(),
  scope: z.literal('protocol-settings-diagnostic-only'),
}).strict()
export type HarnessCompatibility = z.infer<typeof HarnessCompatibilitySchema>
export const HarnessCompatibilityListSchema = z.object({
  canRetry: z.boolean(),
  harnesses: z.array(HarnessCompatibilitySchema).length(1),
}).strict()
export const HarnessCompatibilityRetryParamsSchema = z.object({ harness: CompatibilityHarnessSchema }).strict()
