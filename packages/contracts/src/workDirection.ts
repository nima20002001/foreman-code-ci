import { z } from 'zod'

export const WorkDirectionRequestSchema = z.object({
  message: z.string().min(1),
  unresolved: z.array(z.object({
    unresolvedId: z.string().min(1),
    executionId: z.string().min(1),
    reason: z.enum(['finish_with_findings', 'repeated_exhausted_route']),
    latestDeliverable: z.json(),
    remainingFindings: z.array(z.json()),
  }).strict()).min(1).max(1000),
}).strict()

export const WorkDirectionResponseSchema = z.object({
  direction: z.string().trim().min(1).max(16000),
}).strict()
