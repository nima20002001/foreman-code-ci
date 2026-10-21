import { canonicalGraphJson } from './json.js'
import { ActivitySnapshotV1Schema } from '../activity.js'
import { CiActivitySchema } from '../ciHost.js'
import { z } from 'zod'
import { GraphIdSchema, GraphSequenceSchema, RunGraphScopeSchema } from './graphPrimitives.js'
import { TimestampSchema } from '../schemaPrimitives.js'

export const RUN_ACTIVITIES_RETAINED = 1000
export const RUN_ACTIVITIES_PAGE_BYTES = 128 * 1024

/** One public, bounded Run history. The source activity payload is never part
 * of this wire contract; optional references are independently typed. */
export const RunActivitiesInputSchema = z.object({
  workspaceId: GraphIdSchema, runId: GraphIdSchema,
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()

export const RunActivityPublicKindSchema = z.enum([
  'run', 'stop', 'recovery', 'agent_work', 'job_work', 'tool_action', 'tool_log',
  'work_request', 'work_return', 'work_notice', 'reroute', 'needs_direction',
  'approval', 'review', 'error',
])
const RunActivityPublicStatusSchema = z.enum([
  'recorded', 'queued', 'starting', 'running', 'completed', 'accepted',
  'needs_changes', 'denied', 'pending', 'delivery_failed', 'delivered',
  'acknowledged', 'unknown', 'needs_direction', 'canceled', 'failed',
])
const RunActivityReferenceSchema = z.object({
  executionId: GraphIdSchema.optional(), activationId: GraphIdSchema.optional(),
  continuedFromExecutionId: GraphIdSchema.optional(),
  ciTicketId: CiActivitySchema.shape.id.optional(), ciGroupId: CiActivitySchema.shape.groupId.optional(),
  jobExecutionId: GraphIdSchema.optional(), jobAttemptId: GraphIdSchema.optional(),
  jobOperationId: GraphIdSchema.optional(), nodeExecutionId: GraphIdSchema.optional(),
  requestId: GraphIdSchema.optional(), returnId: GraphIdSchema.optional(),
  denialId: GraphIdSchema.optional(), noticeId: GraphIdSchema.optional(),
  unresolvedId: GraphIdSchema.optional(),
  relationshipId: GraphIdSchema.optional(), fromRelationshipId: GraphIdSchema.optional(),
  requesterNodeId: GraphIdSchema.optional(), destinationNodeId: GraphIdSchema.optional(),
  interactionId: GraphIdSchema.optional(), reviewJobId: GraphIdSchema.optional(),
  acknowledgementId: GraphIdSchema.optional(),
  technicalAttempt: z.number().int().positive().optional(),
  nativeEventSequence: z.number().int().nonnegative().optional(),
}).strict()
const RunActivityAgentSchema = z.object({
  agentId: GraphIdSchema, agentName: z.string().min(1).max(100),
  nodeId: GraphIdSchema, nodeName: z.string().min(1).max(100),
}).strict()
const RunActivityJobSchema = z.object({
  kind: z.literal('job'), nodeId: GraphIdSchema, nodeName: z.string().min(1).max(200),
  jobDefinitionId: GraphIdSchema, jobDefinitionRevision: z.number().int().positive(),
  jobDefinitionVersionId: GraphIdSchema,
}).strict()
const RunActivityWorkResultSchema = z.object({
  outcome: z.string().min(1).max(48),
  latestDeliverable: z.json(),
  remainingFindings: z.array(z.json()).max(1000),
}).strict().superRefine((value, context) => {
  try { canonicalGraphJson(value, 96 * 1024) } catch {
    context.addIssue({ code: 'custom', message: 'ACTIVITY_WORK_RESULT_TOO_LARGE' })
  }
})

export const RunActivityPublicSchema = z.object({
  id: GraphIdSchema, scope: RunGraphScopeSchema, sequence: GraphSequenceSchema,
  occurredAt: TimestampSchema,
  source: z.enum(['backend', 'langgraph', 'harness', 'operator']),
  kind: RunActivityPublicKindSchema, status: RunActivityPublicStatusSchema,
  severity: z.enum(['info', 'warning', 'error']),
  summary: z.string().min(1).max(240), detail: z.string().min(1).max(500).optional(),
  actor: z.union([RunActivityAgentSchema, RunActivityJobSchema]).optional(),
  subject: z.union([RunActivityAgentSchema, RunActivityJobSchema]).optional(),
  refs: RunActivityReferenceSchema,
  ci: CiActivitySchema.optional(),
  workResult: RunActivityWorkResultSchema.optional(),
  usage: z.object({ used: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable() }).strict()
    .refine((value) => value.limit === null || value.used <= value.limit,
      'ACTIVITY_USAGE_EXCEEDS_LIMIT').optional(),
}).strict()
export type RunActivityPublic = z.infer<typeof RunActivityPublicSchema>

export const RunActivitiesPageSchema = z.object({
  activitySnapshot: ActivitySnapshotV1Schema.optional(),
  scope: RunGraphScopeSchema, items: z.array(RunActivityPublicSchema).max(100),
  mode: z.enum(['initial', 'older', 'newer']),
  highWater: GraphSequenceSchema, retainedFrom: GraphSequenceSchema,
  nextCursor: z.string().min(1).max(1024), olderCursor: z.string().min(1).max(1024).nullable(),
  hasMore: z.boolean(),
}).strict().superRefine((page, context) => {
  let previous = 0n
  for (const [index, item] of page.items.entries()) {
    const sequence = BigInt(item.sequence)
    if (item.scope.runId !== page.scope.runId || item.scope.workspaceId !== page.scope.workspaceId
      || item.scope.workflowId !== page.scope.workflowId
      || item.scope.workflowVersionId !== page.scope.workflowVersionId
      || sequence <= previous || sequence < BigInt(page.retainedFrom)
      || sequence > BigInt(page.highWater)) {
      context.addIssue({ code: 'custom', path: ['items', index], message: 'ACTIVITY_PAGE_ORDER_OR_SCOPE_CONFLICT' })
    }
    previous = sequence
  }
})
export type RunActivitiesPage = z.infer<typeof RunActivitiesPageSchema>

export const RunHandoffsReadInputSchema = z.object({ workspaceId: GraphIdSchema,
  runId: GraphIdSchema }).strict()
const RunHandoffEndpointSchema = z.object({ nodeId: GraphIdSchema,
  nodeName: z.string().min(1).max(100), agentId: GraphIdSchema,
  agentName: z.string().min(1).max(100) }).strict()
const RunHandoffConnectionStateSchema = z.object({
  relationshipId: GraphIdSchema, source: RunHandoffEndpointSchema,
  target: RunHandoffEndpointSchema,
  workRequestDirection: z.enum(['source_to_target', 'both']),
  used: z.number().int().nonnegative(), limit: z.number().int().positive().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
}).strict()
const RunHandoffRouteSchema = z.object({
  requesterNodeId: GraphIdSchema, outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  relationshipId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  available: z.boolean(),
}).strict()
const RunHandoffNoticeStateSchema = z.object({
  noticeId: GraphIdSchema, cause: z.enum(['last_return', 'limit_denial']),
  requesterActivationId: GraphIdSchema, continuationActivationId: GraphIdSchema,
  relationshipId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  delivery: z.enum(['queued', 'pending', 'delivered', 'unknown', 'failed']),
  acknowledgementExecutionId: GraphIdSchema.optional(),
  remainingFindingsCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
}).strict()
const RunHandoffUnresolvedStateSchema = z.object({
  unresolvedId: GraphIdSchema, activationId: GraphIdSchema,
  executionId: GraphIdSchema, reason: z.enum(['finish_with_findings', 'repeated_exhausted_route']),
  relationshipId: GraphIdSchema.optional(), createdAt: TimestampSchema,
}).strict()
export const RunHandoffsReadSchema = z.object({
  scope: RunGraphScopeSchema, policy: z.enum(['work', 'not_configured']),
  runState: z.enum(['queued', 'running', 'waiting', 'interrupted', 'completed']),
  connections: z.array(RunHandoffConnectionStateSchema).max(8000),
  routes: z.array(RunHandoffRouteSchema).max(8000),
  notices: z.array(RunHandoffNoticeStateSchema).max(1000),
  unresolved: z.array(RunHandoffUnresolvedStateSchema).max(1000),
  directionWait: z.boolean(),
}).strict().refine((value) => value.policy === 'work'
  || !value.connections.length && !value.routes.length && !value.notices.length
    && !value.unresolved.length && !value.directionWait,
  'UNMARKED_RUN_HAS_HANDOFF_STATE')
export type RunHandoffsRead = z.infer<typeof RunHandoffsReadSchema>
