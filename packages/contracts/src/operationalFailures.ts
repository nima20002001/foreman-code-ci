import { z } from 'zod'

/** Process-local failure history since startup; native output and credentials are excluded. */
export const OperationalFailureSchema = z.object({
  component: z.string(), operation: z.string(), status: z.literal('degraded'), lastError: z.string(),
  failureCount: z.number().int().positive(), firstFailedAt: z.string().datetime(), lastFailedAt: z.string().datetime(),
  nextRetryAt: z.string().datetime().optional(), attempt: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  dataAgeMs: z.number().nonnegative().nullable().optional()
    .describe('Cached data age; null means the source does not report its cache timestamp.'),
  pendingBytes: z.number().int().nonnegative().nullable().optional()
    .describe('Unacknowledged bytes observed on the most recent failed spool flush; null when unreadable.'),
  pendingSince: z.string().datetime().nullable().optional(),
  selectedSource: z.string().max(80).optional(),
}).strict()
export type OperationalFailure = z.infer<typeof OperationalFailureSchema>
