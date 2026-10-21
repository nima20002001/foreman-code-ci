import { z } from 'zod'

export const ExecutionQueueReasonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host_capacity'),
    hostKey: z.string().min(1),
    limit: z.number().int().positive(),
    since: z.iso.datetime(),
  }).strict(),
  z.object({
    kind: z.literal('workflow_parallelism'),
    limit: z.number().int().positive(),
    since: z.iso.datetime(),
  }).strict(),
])
export type ExecutionQueueReason = z.infer<typeof ExecutionQueueReasonSchema>

export const ExecutionQueueEntrySchema = z.object({
  executionId: z.string().min(1),
  workflowNodeId: z.string().min(1),
  reason: ExecutionQueueReasonSchema,
}).strict()
export type ExecutionQueueEntry = z.infer<typeof ExecutionQueueEntrySchema>

export function executionQueueReasonLabel(reason: ExecutionQueueReason): string {
  if (reason.kind === 'host_capacity') {
    return `Waiting for a startup slot on this computer (limit ${reason.limit})`
  }
  return `Waiting for this workflow's parallelism slot (limit ${reason.limit})`
}
