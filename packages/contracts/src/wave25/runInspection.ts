import { z } from 'zod'
import {
  ExecutionResultSchema, HarnessExecutionStateSchema, RunExecutionStateSchema, RunOutcomeSchema,
  RunInputSchema, RunStopCauseSchema, TimestampSchema,
} from '../index.js'
import { GraphDigestSchema, GraphExecutionIdentitySchema, extendGraphExecutionIdentitySchema, GraphIdSchema } from './graphPrimitives.js'
import { AcceptedCurrentNodeResultSchema, CurrentRunScopeSchema } from './currentWorkflowFoundation.js'
import { RepeatExecutionIdentityV1Schema, RepeatOccurrenceIdentityV1Schema, RepeatOccurrenceV1Schema } from './repeat.js'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from './saved.js'
import { canonicalGraphJson } from './json.js'
import { WorkActivationInputSchema } from './handoffs.js'
import { IntervalCheckAcceptedInputSchema } from './intervalAcceptedInput.js'

/** Private, authenticated inspection. These bodies NEVER enter graph snapshots/deltas. */
export const RUN_INSPECTION_TOOLS = {
  record: 'run_record_get',
  executions: 'run_executions_list', execution: 'run_execution_get',
  bindings: 'run_execution_bindings_list', version: 'run_version_get',
} as const
export const RunInspectionToolNameSchema = z.enum(Object.values(RUN_INSPECTION_TOOLS))
export type RunInspectionToolName = z.infer<typeof RunInspectionToolNameSchema>
export const RUN_INSPECTION_LIMITS = {
  executions: 100, bindings: 25, inputBytes: 4 * 1024 * 1024,
  resultBytes: 64 * 1024, responseBytes: 6 * 1024 * 1024, cursorCharacters: 4096,
} as const
const Cursor = z.string().min(1).max(RUN_INSPECTION_LIMITS.cursorCharacters)
const RunRequest = z.object({ workspaceId: GraphIdSchema, runId: GraphIdSchema }).strict()
export const RunExecutionsListInputSchema = RunRequest.extend({
  workflowNodeId: GraphIdSchema.optional(), occurrenceId: GraphIdSchema.optional(),
  cursor: Cursor.optional(), limit: z.number().int().min(1).max(RUN_INSPECTION_LIMITS.executions).default(25),
}).strict()
export const RunExecutionGetInputSchema = RunRequest.extend({ executionId: GraphIdSchema }).strict()
export const RunExecutionBindingsListInputSchema = RunExecutionGetInputSchema.extend({
  cursor: Cursor.optional(), limit: z.number().int().min(1).max(RUN_INSPECTION_LIMITS.bindings).default(10),
}).strict()
export const RunRecordGetInputSchema = RunRequest
export const RunVersionGetInputSchema = RunRequest
export type RunExecutionsListInput = z.infer<typeof RunExecutionsListInputSchema>

/** Explicit private Run disclosure, independent of execution/activity history.
 * Retains exact Run input/result and immutable pins. Principal identity is never
 * disclosed; executionLocation is present only with live location-read grants.
 * Stop acceptance and cleanup settlement are distinct, required persisted facts.
 * Oversized records fail as a whole; no truncated input is usable for a new Run. */
export const RunRecordDetailSchema = z.object({
  run: WorkflowRunV3Schema, stopRequested: z.boolean(), cleanupPending: z.boolean(),
}).strict().superRefine((value, context) => {
  try { canonicalGraphJson(value, RUN_INSPECTION_LIMITS.responseBytes) }
  catch { context.addIssue({ code: 'custom', message: 'Run record exceeds its exact-value bound.' }) }
})
export type RunRecordDetail = z.infer<typeof RunRecordDetailSchema>

/** Refreshable lifecycle metadata; no input, output, native/session or location paths. */
export const RunInspectionRunSchema = CurrentRunScopeSchema.extend({
  executionState: RunExecutionStateSchema, outcome: RunOutcomeSchema,
  createdAt: TimestampSchema, startedAt: TimestampSchema.optional(), finishedAt: TimestampSchema.optional(),
  stopCause: RunStopCauseSchema.optional(), cleanupPending: z.boolean(),
  failure: ExecutionResultSchema.shape.error,
}).strict()
export const RunExecutionSummarySchema = extendGraphExecutionIdentitySchema({
  state: HarnessExecutionStateSchema,
  continuedFromExecutionId: GraphIdSchema.optional(),
  failure: ExecutionResultSchema.shape.error,
  createdAt: TimestampSchema, startedAt: TimestampSchema.optional(), finishedAt: TimestampSchema.optional(),
  /** Omitted outside a REAL configured repeat occurrence; attempt is not occurrenceIndex. */
  occurrence: RepeatOccurrenceIdentityV1Schema.optional(),
  /** Present only for an interval check of its node; checks never route the graph. */
  tickIndex: z.number().int().positive().optional(),
  /** Discovery only. The exact detail verifies the accepted result and canonical receipt. */
  acceptedResultAvailable: z.boolean(),
  /** The Agent's own branch of the workspace repository (names only, never a path). */
  worktree: z.object({ repository: z.string().max(200), branch: z.string().max(255) }).strict().optional(),
})
export type RunExecutionSummary = z.infer<typeof RunExecutionSummarySchema>
const PageInfo = z.object({ nextCursor: Cursor.nullable() }).strict()
export const RunExecutionsPageSchema = z.object({
  run: RunInspectionRunSchema, items: z.array(RunExecutionSummarySchema).max(RUN_INSPECTION_LIMITS.executions),
  pageInfo: PageInfo,
}).strict()

const ReportedResult = ExecutionResultSchema.superRefine((value, context) => {
  try { canonicalGraphJson(value, RUN_INSPECTION_LIMITS.resultBytes) }
  catch { context.addIssue({ code: 'custom', message: 'Inspection result exceeds its exact-value bound.' }) }
})

export const RunInputSourceSchema = z.object({
  relationshipId: GraphIdSchema, execution: GraphExecutionIdentitySchema,
  occurrence: RepeatOccurrenceIdentityV1Schema.nullable(),
  acceptedResultDigest: GraphDigestSchema, acceptedResult: AcceptedCurrentNodeResultSchema,
}).strict()
const RunInputCarrySchema = z.object({
  decisionId: GraphIdSchema, execution: RepeatExecutionIdentityV1Schema,
  acceptedResultDigest: GraphDigestSchema, acceptedResult: AcceptedCurrentNodeResultSchema,
}).strict()
/** The exact non-recursive input snapshot already accepted by the current engine. */
const RepeatInspectionInputSchema = z.object({
  executionSemanticsVersion: z.literal(3), runInput: RunInputSchema,
  occurrence: RepeatOccurrenceV1Schema.nullable(),
  entry: z.object({ runInput: RunInputSchema, external: z.array(RunInputSourceSchema).max(8000),
    carry: RunInputCarrySchema.nullable() }).strict().nullable(),
  predecessors: z.array(RunInputSourceSchema).max(8000),
}).strict()
export const RunAcceptedInputValueSchema = z.union([
  RepeatInspectionInputSchema,
  IntervalCheckAcceptedInputSchema,
  WorkActivationInputSchema.safeExtend({ runInput: RunInputSchema }),
]).superRefine((value, context) => {
  try { canonicalGraphJson(value, RUN_INSPECTION_LIMITS.inputBytes) }
  catch { context.addIssue({ code: 'custom', message: 'Inspection input exceeds its exact-value bound.' }) }
})
export const RunExecutionDetailSchema = z.object({
  run: RunInspectionRunSchema, execution: RunExecutionSummarySchema,
  acceptedInput: z.object({ digest: GraphDigestSchema, value: RunAcceptedInputValueSchema }).strict(),
  acceptedResult: z.discriminatedUnion('status', [
    z.object({ status: z.literal('accepted'), digest: GraphDigestSchema, value: AcceptedCurrentNodeResultSchema }).strict(),
    z.object({ status: z.literal('not_accepted') }).strict(),
  ]),
  /** A native terminal report, including failure, is NOT an accepted predecessor result. */
  reportedResult: ReportedResult.optional(),
}).strict()


const Binding = z.object({
  bindingId: GraphIdSchema, recipient: GraphExecutionIdentitySchema,
  recipientOccurrence: RepeatOccurrenceIdentityV1Schema.nullable(), inputDigest: GraphDigestSchema,
  ordinal: z.number().int().min(0).max(16000),
}).strict()
export const RunExecutionBindingSchema = z.discriminatedUnion('kind', [
  Binding.extend({ kind: z.literal('predecessor'), source: RunInputSourceSchema }).strict(),
  Binding.extend({ kind: z.literal('external'), source: RunInputSourceSchema }).strict(),
  Binding.extend({ kind: z.literal('carry'), source: RunInputCarrySchema }).strict(),
])
export type RunExecutionBinding = z.infer<typeof RunExecutionBindingSchema>
export const RunExecutionBindingsPageSchema = z.object({
  scope: CurrentRunScopeSchema, executionId: GraphIdSchema, inputDigest: GraphDigestSchema,
  items: z.array(RunExecutionBindingSchema).max(RUN_INSPECTION_LIMITS.bindings), pageInfo: PageInfo,
}).strict()
export const RunVersionDetailSchema = z.object({ scope: CurrentRunScopeSchema, version: WorkflowVersionV3Schema }).strict()
  .superRefine(({ scope, version }, context) => {
    if (scope.workspaceId !== version.workspaceId || scope.workflowId !== version.workflowId
      || scope.workflowVersionId !== version.id || scope.executionSemanticsVersion !== version.executionSemanticsVersion) {
      context.addIssue({ code: 'custom', message: 'RUN_VERSION_SNAPSHOT_PIN_MISMATCH' })
    }
  })
export type RunExecutionsPage = z.infer<typeof RunExecutionsPageSchema>
export type RunExecutionDetail = z.infer<typeof RunExecutionDetailSchema>
export type RunExecutionBindingsPage = z.infer<typeof RunExecutionBindingsPageSchema>
export type RunVersionDetail = z.infer<typeof RunVersionDetailSchema>
