import { z } from 'zod'

/** A failed read retains ownership, but does not confirm the underlying activity or computer state. */
export const ReadObservationSchema = z.object({
  status: z.enum(['available', 'unavailable']),
  lastError: z.string().max(500).nullable(),
  failedAt: z.string().datetime().nullable(),
  lastSuccess: z.string().datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
}).strict()
export type ReadObservation = z.infer<typeof ReadObservationSchema>
