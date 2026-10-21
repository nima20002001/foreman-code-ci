import { z } from 'zod'

import { CompatibilityHarnessSchema } from './harnessCompatibility.js'

/**
 * A harness version is usable when it is a built-in baseline or when the app's own
 * qualification suite passed against that exact binary. Each usable version runs
 * with the behavior profile of the baseline it was qualified against.
 */
const HarnessProfileIdSchema = z.enum(['codex-0.154', 'codex-0.156'])
export type HarnessProfileId = z.infer<typeof HarnessProfileIdSchema>

const HarnessQualificationStatusSchema = z.enum(['baseline', 'qualified', 'qualifying', 'failed', 'unqualified'])

const HarnessQualificationCheckSchema = z.object({
  id: z.string().min(1).max(80),
  passed: z.boolean(),
  detail: z.string().max(500).nullable(),
}).strict()
export type HarnessQualificationCheck = z.infer<typeof HarnessQualificationCheckSchema>

export const HarnessQualificationSchema = z.object({
  harness: CompatibilityHarnessSchema,
  /** Normalized release version, e.g. `0.158.0` or `1.18.33`. */
  version: z.string().min(1).max(64),
  binarySha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  status: HarnessQualificationStatusSchema,
  profile: HarnessProfileIdSchema.nullable(),
  suiteRevision: z.string().min(1).max(80),
  checks: z.array(HarnessQualificationCheckSchema).max(50),
  failureReason: z.string().max(500).nullable(),
  startedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime().nullable(),
}).strict()
export type HarnessQualification = z.infer<typeof HarnessQualificationSchema>

/** Immutable accepted records keep the provider and profile originally qualified. */
export const RecordedHarnessQualificationSchema = HarnessQualificationSchema.extend({
  harness: z.enum(['codex', 'opencode']),
  profile: z.enum(['codex-0.154', 'codex-0.156', 'opencode-1.18.31']).nullable(),
})

export const HarnessQualificationListSchema = z.object({ qualifications: z.array(HarnessQualificationSchema) }).strict()
export const HarnessQualificationRunParamsSchema = z.object({ harness: CompatibilityHarnessSchema }).strict()
