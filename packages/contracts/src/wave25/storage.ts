import { z } from 'zod'
import { GraphActivitySchema, AgentGraphExecutionIdentitySchema, GraphIdSchema, GraphSequenceSchema } from './graphPrimitives.js'

/** INTERNAL storage contracts: never embed these native identifiers into wire snapshots/events. */
export const NativeGraphProjectionKeySchema = z.object({
  execution: AgentGraphExecutionIdentitySchema, workKind: z.enum(['workflow', 'review']), workId: GraphIdSchema,
}).strict().superRefine((value, context) => {
  if (value.workKind === 'workflow' && value.workId !== value.execution.executionId) context.addIssue({ code: 'custom', message: 'workflow activity is keyed by its host execution' })
})
export type NativeGraphProjectionKey = z.infer<typeof NativeGraphProjectionKeySchema>
export const NativeGraphActivityRecordSchema = z.object({
  key: NativeGraphProjectionKeySchema, projectionRevision: GraphSequenceSchema,
  lastNativeSequence: GraphSequenceSchema.nullable(), terminalNativeSequence: GraphSequenceSchema.nullable(),
  activity: GraphActivitySchema,
}).strict().superRefine((value, context) => {
  if (value.activity.workflowNodeId !== value.key.execution.workflowNodeId) context.addIssue({ code: 'custom', message: 'activity scope mismatch' })
  if (value.terminalNativeSequence !== null && GraphSequenceSchema.safeParse(value.terminalNativeSequence).success && (value.lastNativeSequence === null || !GraphSequenceSchema.safeParse(value.lastNativeSequence).success || BigInt(value.terminalNativeSequence) > BigInt(value.lastNativeSequence))) context.addIssue({ code: 'custom', message: 'terminal fence must be in ingested history' })
  if (value.key.workKind === 'review' && value.activity.reviewJobId !== undefined && value.activity.reviewJobId !== value.key.workId) context.addIssue({ code: 'custom', message: 'review host correlation mismatch' })
  if (value.terminalNativeSequence !== null && value.activity.status === 'active') context.addIssue({ code: 'custom', message: 'a terminal work item cannot be currently active' })
})
export type NativeGraphActivityRecord = z.infer<typeof NativeGraphActivityRecordSchema>
export const NativeGraphCorrelationRecordSchema = z.object({
  key: NativeGraphProjectionKeySchema, correlationKey: GraphIdSchema,
  provider: z.enum(['codex', 'opencode', 'claude']), nativeSessionId: z.string().min(1).max(1000),
  connectionId: z.string().min(1).max(1000).nullable(), connectionGeneration: z.number().int().min(0).max(2147483647),
  nativeTurnId: z.string().min(1).max(1000).nullable(), nativeRequestId: z.string().min(1).max(1000).nullable(),
  interactionId: GraphIdSchema.nullable(), reviewJobId: GraphIdSchema.nullable(),
  firstNativeSequence: GraphSequenceSchema, lastNativeSequence: GraphSequenceSchema,
  terminalNativeSequence: GraphSequenceSchema.nullable(), metadataRevision: GraphSequenceSchema,
}).strict().superRefine((value, context) => {
  const valid = [value.firstNativeSequence, value.lastNativeSequence, value.terminalNativeSequence].filter((sequence) => sequence !== null).every((sequence) => GraphSequenceSchema.safeParse(sequence).success)
  if (!valid) return
  if (BigInt(value.firstNativeSequence) > BigInt(value.lastNativeSequence)
    || (value.terminalNativeSequence !== null && (BigInt(value.terminalNativeSequence) < BigInt(value.firstNativeSequence) || BigInt(value.terminalNativeSequence) > BigInt(value.lastNativeSequence)))) context.addIssue({ code: 'custom', message: 'native sequence fence/order mismatch' })
  if (value.key.workKind === 'workflow' ? value.reviewJobId !== null : value.reviewJobId !== value.key.workId || value.interactionId === null) context.addIssue({ code: 'custom', message: 'workflow and independent review correlations must not alias' })
})
export type NativeGraphCorrelationRecord = z.infer<typeof NativeGraphCorrelationRecordSchema>
