import { WorkHandoffRoutingSchema, WorkHandoffDataSchema } from '../workflowHierarchy.js'
import { z } from 'zod'
import { ExecutionResultSchema } from '../index.js'
import { TimestampSchema } from '../schemaPrimitives.js'
import { GraphDigestSchema, GraphIdSchema, RunGraphScopeSchema } from './graphPrimitives.js'
import type { WorkflowDefinitionV3 } from './workflowShape.js'
import { canonicalGraphJson } from './json.js'
import {
  WorkflowArtifactOutputsV1Schema, WorkflowArtifactResultV1Schema,
  type WorkflowArtifactOutputsV1, type WorkflowArtifactResultV1,
} from '../workflowArtifactDeclarations.js'
export { WorkHandoffPolicyV1Schema } from './workflowShape.js'

const Count = z.number().int().min(0).max(2147483647)

/** Logical work is independent of native attempts, approval exchanges and turns. */
const WorkHandoffScopeSchema = RunGraphScopeSchema
export const WorkHandoffUsageSchema = z.object({
  scope: WorkHandoffScopeSchema, relationshipId: GraphIdSchema,
  used: Count, maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647).nullable(),
}).strict().refine((value) => value.maxWorkHandoffsPerRun === null || value.used <= value.maxWorkHandoffsPerRun,
  'HANDOFF_USAGE_EXCEEDS_LIMIT')
type WorkHandoffUsage = z.infer<typeof WorkHandoffUsageSchema>
export function canAdmitWorkHandoff(usage: WorkHandoffUsage): boolean {
  return usage.maxWorkHandoffsPerRun === null || usage.used < usage.maxWorkHandoffsPerRun
}

/** A saved execution edge is the sole authority for a business work route. */
export function workConnectionForRequest(definition: WorkflowDefinitionV3, requesterNodeId: string, destinationNodeId: string) {
  if (!definition.handoffs || requesterNodeId === destinationNodeId) return undefined
  return definition.edges.find((edge) => edge.kind === 'execution' && (
    edge.source === requesterNodeId && edge.target === destinationNodeId
    || edge.workRequestDirection === 'both' && edge.source === destinationNodeId && edge.target === requesterNodeId
  ))
}

export const WorkActivationIdentitySchema = z.object({
  scope: WorkHandoffScopeSchema, activationId: GraphIdSchema, workflowNodeId: GraphIdSchema,
  /** Stable root work item across review returns and sibling branches. */
  lineageId: GraphIdSchema,
  /** The exact accepted request, return or denial that caused this activation. */
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entry') }).strict(),
    z.object({ kind: z.literal('dependency'), resolutionId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('join'), joinId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('work_request'), requestId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('work_return'), returnId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('limit_denial'), denialId: GraphIdSchema }).strict(),
  ]),
}).strict()

export const WorkRequestSchema = z.object({
  scope: WorkHandoffScopeSchema, requestId: GraphIdSchema, relationshipId: GraphIdSchema,
  requesterActivationId: GraphIdSchema, requesterExecutionId: GraphIdSchema,
  destinationActivationId: GraphIdSchema,
  requesterNodeId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  payloadDigest: GraphDigestSchema, acceptedAt: TimestampSchema,
  /** One accepted request reserves exactly one slot, regardless of delivery outcome. */
  ordinal: z.number().int().min(1).max(2147483647),
}).strict().refine((value) => value.requesterNodeId !== value.destinationNodeId, 'HANDOFF_SELF_REQUEST')
export type WorkRequest = z.infer<typeof WorkRequestSchema>

export const WorkReturnSchema = z.object({
  scope: WorkHandoffScopeSchema, returnId: GraphIdSchema, requestId: GraphIdSchema,
  sourceActivationId: GraphIdSchema, sourceExecutionId: GraphIdSchema, requesterActivationId: GraphIdSchema,
  continuationActivationId: GraphIdSchema.optional(),
  acceptedResultDigest: GraphDigestSchema, outcome: z.enum(['accepted', 'needs_changes']),
  latestDeliverable: z.json(), remainingFindings: z.array(z.json()).max(1000), returnedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'needs_changes') !== (value.continuationActivationId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['continuationActivationId'], message: 'HANDOFF_RETURN_CONTINUATION_CONFLICT' })
  }
  if (value.latestDeliverable === null) context.addIssue({ code: 'custom', path: ['latestDeliverable'], message: 'HANDOFF_DELIVERABLE_REQUIRED' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'HANDOFF_RETURN_TOO_LARGE' }) }
})
export type WorkReturn = z.infer<typeof WorkReturnSchema>

export const WorkLimitDenialSchema = z.object({
  scope: WorkHandoffScopeSchema, denialId: GraphIdSchema, requestId: GraphIdSchema,
  relationshipId: GraphIdSchema, requesterActivationId: GraphIdSchema,
  requesterExecutionId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  payloadDigest: GraphDigestSchema, used: z.number().int().min(1).max(2147483647),
  maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647), deniedAt: TimestampSchema,
}).strict().refine((value) => value.used === value.maxWorkHandoffsPerRun, 'HANDOFF_DENIAL_NOT_EXHAUSTED')
export type WorkLimitDenial = z.infer<typeof WorkLimitDenialSchema>

export const WorkAlternativeSchema = z.object({
  relationshipId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  destinationAgentId: GraphIdSchema, destinationName: z.string().trim().min(1).max(200),
  outcomes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)).max(16),
  used: Count, maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647).nullable(),
}).strict().refine((value) => value.maxWorkHandoffsPerRun === null
  || value.used < value.maxWorkHandoffsPerRun, 'WORK_ALTERNATIVE_EXHAUSTED')
export type WorkAlternative = z.infer<typeof WorkAlternativeSchema>

export function workLimitNoticeText(destinationName: string, used: number, maximum: number): string {
  return `The maximum number of work handoffs to agent ${destinationName} has been reached (${used} of ${maximum} for this Run). Choose another available agent or finish with the remaining findings.`
}
export const WorkNoticeSchema = z.object({
  scope: WorkHandoffScopeSchema, noticeId: GraphIdSchema, requesterActivationId: GraphIdSchema,
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('last_return'), returnId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('limit_denial'), denialId: GraphIdSchema }).strict(),
  ]),
  continuationActivationId: GraphIdSchema,
  relationshipId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  destinationAgentId: GraphIdSchema, destinationName: z.string().trim().min(1).max(200),
  used: z.number().int().min(1).max(2147483647),
  maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647),
  latestDeliverable: z.json(), remainingFindings: z.array(z.json()).max(1000),
  alternatives: z.array(WorkAlternativeSchema).max(1000), message: z.string().min(1).max(1024),
  delivery: z.enum(['queued', 'pending', 'delivered', 'unknown', 'failed']),
  acknowledgementId: GraphIdSchema.optional(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if ((value.delivery === 'delivered') !== (value.acknowledgementId !== undefined)) fail('HANDOFF_NOTICE_ACKNOWLEDGEMENT_CONFLICT')
  if (value.used !== value.maxWorkHandoffsPerRun || value.latestDeliverable === null
    || value.message !== workLimitNoticeText(value.destinationName, value.used, value.maxWorkHandoffsPerRun)) {
    fail('HANDOFF_NOTICE_CONTENT_CONFLICT')
  }
  const seen = new Set<string>()
  for (const alternative of value.alternatives) {
    if (alternative.relationshipId === value.relationshipId || alternative.destinationNodeId === value.destinationNodeId
      || seen.has(alternative.relationshipId)) fail('HANDOFF_NOTICE_ALTERNATIVE_CONFLICT')
    seen.add(alternative.relationshipId)
  }
  try { canonicalGraphJson(value, 64 * 1024) } catch { fail('HANDOFF_NOTICE_TOO_LARGE') }
})
export type WorkNotice = z.infer<typeof WorkNoticeSchema>

/** Frozen private native input for one logical activation. Public projections
 * expose references and safe summaries, never this source result payload. */
export const WorkActivationInputSchema = z.object({
  executionSemanticsVersion: z.literal(3), runInput: z.json(),
  occurrence: z.null(), entry: z.null(), predecessors: z.tuple([]),
  parentRequest: WorkRequestSchema.optional(),
  work: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entry'), activation: WorkActivationIdentitySchema }).strict(),
    z.object({ kind: z.literal('work_request'), activation: WorkActivationIdentitySchema,
      request: WorkRequestSchema, acceptedSourceResult: ExecutionResultSchema }).strict(),
    z.object({ kind: z.literal('work_return'), activation: WorkActivationIdentitySchema,
      returned: WorkReturnSchema, acceptedSourceResult: ExecutionResultSchema,
      returns: z.array(z.object({ returned: WorkReturnSchema, acceptedSourceResult: ExecutionResultSchema,
        notice: WorkNoticeSchema.optional() }).strict()).min(1).max(1000).optional(),
      failures: z.array(z.object({ request: WorkRequestSchema, result: ExecutionResultSchema }).strict())
        .max(1000).optional(),
      notice: WorkNoticeSchema.optional() }).strict(),
    z.object({ kind: z.literal('limit_denial'), activation: WorkActivationIdentitySchema,
      denial: WorkLimitDenialSchema, acceptedSourceResult: ExecutionResultSchema,
      notice: WorkNoticeSchema }).strict(),
    z.object({ kind: z.literal('join'), activation: WorkActivationIdentitySchema,
      sources: z.array(z.object({ request: WorkRequestSchema,
        acceptedSourceResult: ExecutionResultSchema }).strict()).min(1).max(1000) }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const { work } = value
  if (value.parentRequest && (value.parentRequest.destinationNodeId !== work.activation.workflowNodeId
    || canonicalGraphJson(value.parentRequest.scope) !== canonicalGraphJson(work.activation.scope))) {
    context.addIssue({ code: 'custom', path: ['parentRequest'], message: 'WORK_PARENT_REQUEST_CONFLICT' })
  }
  if (work.activation.cause.kind !== work.kind
    || work.kind === 'work_request' && (work.activation.cause.kind !== 'work_request'
      || work.activation.cause.requestId !== work.request.requestId
      || work.activation.activationId !== work.request.destinationActivationId)
    || work.kind === 'work_return' && (work.activation.cause.kind !== 'work_return'
      || work.activation.cause.returnId !== work.returned.returnId
      || work.activation.activationId !== work.returned.continuationActivationId
      || work.notice !== undefined && (work.notice.cause.kind !== 'last_return'
        || work.notice.cause.returnId !== work.returned.returnId
        || work.notice.continuationActivationId !== work.activation.activationId))
    || work.kind === 'limit_denial' && (work.activation.cause.kind !== 'limit_denial'
      || work.activation.cause.denialId !== work.denial.denialId
      || work.notice.cause.kind !== 'limit_denial'
      || work.notice.cause.denialId !== work.denial.denialId
      || work.notice.continuationActivationId !== work.activation.activationId)
    || work.kind === 'join' && (work.activation.cause.kind !== 'join'
      || work.activation.cause.joinId !== work.activation.activationId
      || new Set(work.sources.map((item) => item.request.relationshipId)).size !== work.sources.length
      || work.sources.some((item) => item.request.destinationActivationId !== work.activation.activationId))) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'WORK_ACTIVATION_INPUT_ANCESTRY_CONFLICT' })
  }
  if (work.kind !== 'entry' && work.kind !== 'join' && work.acceptedSourceResult.outcome !== 'succeeded'
    || work.kind === 'join' && work.sources.some((item) => item.acceptedSourceResult.outcome !== 'succeeded')) {
    context.addIssue({ code: 'custom', path: ['work', 'acceptedSourceResult'], message: 'WORK_INPUT_SOURCE_NOT_ACCEPTED' })
  }
  if (work.kind === 'work_return' && work.returns) {
    const invalid = work.returns.some(item => item.acceptedSourceResult.outcome !== 'succeeded'
      || canonicalGraphJson(item.returned.scope) !== canonicalGraphJson(work.activation.scope)
      || item.returned.outcome === 'needs_changes'
        && item.returned.continuationActivationId !== work.activation.activationId
      || item.notice && (item.notice.cause.kind !== 'last_return'
        || item.notice.cause.returnId !== item.returned.returnId
        || item.notice.continuationActivationId !== work.activation.activationId))
    if (invalid || new Set(work.returns.map(item => item.returned.requestId)).size !== work.returns.length
      || !work.returns.some(item => canonicalGraphJson(item.returned) === canonicalGraphJson(work.returned)
        && canonicalGraphJson(item.acceptedSourceResult) === canonicalGraphJson(work.acceptedSourceResult))) {
      context.addIssue({ code: 'custom', path: ['work', 'returns'], message: 'WORK_RETURN_GROUP_CONFLICT' })
    }
  }
  if (work.kind === 'work_return' && work.failures?.some(item =>
    item.request.requesterNodeId !== work.activation.workflowNodeId
    || canonicalGraphJson(item.request.scope) !== canonicalGraphJson(work.activation.scope)
    || item.result.outcome !== 'failed' && item.result.outcome !== 'canceled')) {
    context.addIssue({ code: 'custom', path: ['work', 'failures'], message: 'WORK_RETURN_GROUP_CONFLICT' })
  }
  try { canonicalGraphJson(value, 4 * 1024 * 1024) }
  catch { context.addIssue({ code: 'custom', message: 'WORK_ACTIVATION_INPUT_TOO_LARGE' }) }
})
export type WorkActivationInput = z.infer<typeof WorkActivationInputSchema>

/** A typed native decision; the server resolves and validates saved routes. */
export const WorkHandoffResultSchema = z.object({
  routing: WorkHandoffRoutingSchema,
  data: WorkHandoffDataSchema,
  artifactOutputs: WorkflowArtifactResultV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.data.latestDeliverable === null) context.addIssue({ code: 'custom', path: ['data', 'latestDeliverable'], message: 'HANDOFF_DELIVERABLE_REQUIRED' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'HANDOFF_RESULT_TOO_LARGE' }) }
})
export type WorkHandoffResult = z.infer<typeof WorkHandoffResultSchema>

/** Parse only the exact native result carrier; route IDs are resolved server-side. */
export function parseWorkHandoffResult(result: unknown): WorkHandoffResult {
  const accepted = ExecutionResultSchema.parse(result)
  if (accepted.outcome !== 'succeeded') throw new Error('HANDOFF_RESULT_NOT_SUCCESSFUL')
  let output: unknown = accepted.output
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') output = output.text
  if (typeof output === 'string') {
    if (new TextEncoder().encode(output).byteLength > 64 * 1024) throw new Error('HANDOFF_RESULT_TOO_LARGE')
    output = JSON.parse(output)
  }
  return WorkHandoffResultSchema.parse(output)
}

/** Artifact associations share the handoff envelope; publication is checked separately. */
export function parseWorkHandoffArtifactResult(result: unknown, declaration: WorkflowArtifactOutputsV1):
  WorkHandoffResult & { artifactOutputs: WorkflowArtifactResultV1 } {
  const accepted = ExecutionResultSchema.parse(result)
  const output = accepted.output
  if (accepted.outcome !== 'succeeded' || !output || typeof output !== 'object' || Array.isArray(output)
    || Object.keys(output).length !== 1 || !('text' in output) || typeof output.text !== 'string') {
    throw new Error('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED')
  }
  const envelope = parseWorkHandoffResult(accepted)
  const artifactOutputs = WorkflowArtifactResultV1Schema.parse(envelope.artifactOutputs)
  const saved = WorkflowArtifactOutputsV1Schema.parse(declaration)
  const keys = new Set(artifactOutputs.outputs.map((item) => item.outputKey))
  if (keys.size !== saved.outputKeys.length || saved.outputKeys.some((key) => !keys.has(key))) {
    throw new Error('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH')
  }
  return { ...envelope, artifactOutputs }
}

type WorkHandoffOperationKind =
  | 'work_request'
  | 'work_return'
  | 'permission_exchange'
  | 'approval_exchange'
  | 'technical_retry'
  | 'replay'
  | 'progress'
  | 'system_notice'
  | 'delivery_acknowledgement'
export function consumesWorkHandoffSlot(kind: WorkHandoffOperationKind): boolean {
  return kind === 'work_request'
}
