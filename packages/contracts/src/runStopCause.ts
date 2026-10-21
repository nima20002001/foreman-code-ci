import { z } from 'zod'

/** Why supervision requested Stop. This is not proof that native work exited. */
export const RunStopCauseSchema = z.object({
  kind: z.literal('review_failure'),
  interactionId: z.string().min(1),
  reviewJobId: z.string().min(1).optional(),
  error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) }).strict(),
  recordedAt: z.string().datetime({ offset: true }),
}).strict()
