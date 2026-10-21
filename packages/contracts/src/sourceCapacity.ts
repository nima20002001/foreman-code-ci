import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Capacity diagnostics contain host identifiers and measurements, never filesystem paths. */
export const SourceCapacityErrorDetailsSchema = z.object({
  scopeId: z.string().min(1).max(512),
  retryable: z.boolean(),
  pool: z.enum(['ordinary', 'verification']).optional(),
  exhausted: z.array(z.enum(['retained_bytes', 'available_bytes', 'preparations', 'materializations'])).min(1).max(4),
  usage: z.object({
    usedBytes: count,
    retainedBytes: count,
    pendingBytes: count,
    preparing: count,
    activeMaterializations: count,
    requestedBytes: count,
  }).strict(),
  limits: z.object({ bytes: count, availableBytes: count, preparing: count, materializations: count }).strict(),
  measured: z.object({
    cpuCount: count.positive(),
    availableMemoryBytes: count,
    observedAt: z.string().datetime(),
  }).strict(),
}).strict()
export type SourceCapacityErrorDetails = z.infer<typeof SourceCapacityErrorDetailsSchema>
