import { z } from 'zod'
import {
  ApprovalResponseSemanticSchema, InteractionStatusSchema, NativeDeliveryStateSchema,
  ReviewJobSchema, RunExecutionStateSchema, RunOutcomeSchema, TimestampSchema,
} from '../index.js'
import { ChoiceOutcomeSchema } from './currentResult.js'

export const RUN_GRAPH_PROTOCOL_VERSION = 1 as const
export const RUN_GRAPH_LIMITS = Object.freeze({
  eventBytes: 8192, batchEvents: 64, batchBytes: 65536,
  pageBatches: 16, pageBytes: 262144, catchupBatches: 2048,
  transactionSources: 4096, transactionBytes: 8 * 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024, nodes: 1000, relationships: 8000,
  exchanges: 2000,
})
export const GraphIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const GraphDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
/** Per-Run COMPLETE BATCH positions, not event/native/Activity sequence numbers. */
export const GraphSequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n, 'cursor exceeds PostgreSQL bigint')
export type GraphSequence = z.infer<typeof GraphSequenceSchema>
export const RunGraphScopeSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, runId: GraphIdSchema,
  workflowVersionId: GraphIdSchema, executionSemanticsVersion: z.literal(3),
}).strict()
export type RunGraphScope = z.infer<typeof RunGraphScopeSchema>
export const GraphEvidenceSchema = z.object({
  sourceKind: z.enum(['run', 'execution', 'native_event', 'node_resolution', 'input_binding', 'interaction', 'delivery', 'review', 'cleanup']),
  sourceId: GraphIdSchema, sourceRevision: GraphSequenceSchema,
}).strict()
export type GraphEvidence = z.infer<typeof GraphEvidenceSchema>
export const AgentGraphExecutionIdentitySchema = z.object({
  kind:z.literal('agent').optional(),
  workflowNodeId: GraphIdSchema, executionId: GraphIdSchema,
  agentId: GraphIdSchema, agentConfigurationVersionId: GraphIdSchema,
  attempt: z.number().int().min(1).max(2147483647),
}).strict()
export type AgentGraphExecutionIdentity=z.infer<typeof AgentGraphExecutionIdentitySchema>
export const JobGraphExecutionIdentitySchema=z.object({kind:z.literal('job'),workflowNodeId:GraphIdSchema,executionId:GraphIdSchema,
  jobDefinitionId:GraphIdSchema,jobDefinitionVersionId:GraphIdSchema,attempt:z.number().int().min(1).max(2147483647)}).strict()
export const GraphExecutionIdentitySchema=z.union([AgentGraphExecutionIdentitySchema,JobGraphExecutionIdentitySchema])
export function extendGraphExecutionIdentitySchema<T extends z.ZodRawShape>(shape:T) {
  return z.union([AgentGraphExecutionIdentitySchema.extend(shape).strict(),JobGraphExecutionIdentitySchema.extend(shape).strict()])
}
export type GraphExecutionIdentity = z.infer<typeof GraphExecutionIdentitySchema>

export const NodeResolutionSchema = z.object({
  workflowNodeId: GraphIdSchema,
  resolution: z.enum(['succeeded', 'failed', 'canceled', 'skipped', 'excluded']),
  execution: GraphExecutionIdentitySchema.optional(), acceptedResultDigest: GraphDigestSchema.optional(),
  outcome: ChoiceOutcomeSchema.optional(), branchEnded: z.boolean(),
  selectedRelationshipIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.relationships),
  unselectedRelationshipIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.relationships),
  resolvedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  const inactive = value.resolution === 'skipped' || value.resolution === 'excluded'
  if (inactive ? value.execution !== undefined : value.execution === undefined) fail('only actually activated nodes have an execution')
  if (value.execution && value.execution.workflowNodeId !== value.workflowNodeId) fail('execution/node identity mismatch')
  if ((value.resolution === 'succeeded') !== (value.acceptedResultDigest !== undefined)) fail('only a successful resolution binds an accepted result')
  if (value.resolution !== 'succeeded' && (value.outcome !== undefined || value.branchEnded || value.selectedRelationshipIds.length)) fail('unsuccessful/unactivated nodes cannot select routes or outcomes')
  const all = [...value.selectedRelationshipIds, ...value.unselectedRelationshipIds]
  if (new Set(all).size !== all.length) fail('selected/unselected relationship identities must be unique and disjoint')
})
export type NodeResolution = z.infer<typeof NodeResolutionSchema>
export const InputBindingSchema = z.object({
  bindingId: GraphIdSchema, relationshipId: GraphIdSchema,
  sender: GraphExecutionIdentitySchema, recipient: GraphExecutionIdentitySchema,
  acceptedResultDigest: GraphDigestSchema, recipientInputDigest: GraphDigestSchema,
  inputOrdinal: z.number().int().nonnegative().max(16000),
  boundAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.sender.workflowNodeId === value.recipient.workflowNodeId || value.sender.executionId === value.recipient.executionId) {
    context.addIssue({ code: 'custom', message: 'input binding requires distinct sender and recipient' })
  }
})
export type InputBinding = z.infer<typeof InputBindingSchema>
export const GraphNodeStateSchema = z.object({
  workflowNodeId: GraphIdSchema,
  lifecycle: z.enum(['not_activated', 'queued', 'starting', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'skipped', 'interrupted', 'uncertain', 'unknown']),
  execution: GraphExecutionIdentitySchema.optional(),
}).strict().superRefine((value, context) => {
  const inactive = value.lifecycle === 'not_activated' || value.lifecycle === 'skipped'
  const unknown = value.lifecycle === 'unknown'
  if (!unknown && (inactive ? value.execution !== undefined : value.execution === undefined)) context.addIssue({ code: 'custom', message: 'lifecycle requires a matching activation identity' })
  if (value.execution && value.execution.workflowNodeId !== value.workflowNodeId) context.addIssue({ code: 'custom', message: 'execution/node identity mismatch' })
})
export const GraphActivitySchema = z.object({
  workflowNodeId: GraphIdSchema, status: z.enum(['unknown', 'none', 'active', 'stale']),
  action: z.enum(['working', 'reading_file', 'writing_file', 'creating_folder', 'using_tool', 'using_app_mcp', 'spawning_subagent', 'reviewing', 'waiting_approval']).optional(),
  execution: GraphExecutionIdentitySchema.optional(), correlationId: GraphIdSchema.optional(),
  acknowledgementId: GraphIdSchema.optional(), interactionId: GraphIdSchema.optional(), reviewJobId: GraphIdSchema.optional(),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (value.status === 'active' || value.status === 'stale') {
    if (!value.action || !value.execution) fail('activity requires an execution and action')
    if (value.action === 'waiting_approval') {
      if (!value.interactionId) fail('waiting requires a durable interaction identity')
    } else if (!value.acknowledgementId || !value.correlationId) fail('native activity requires exact acknowledgement and correlation')
  } else if (value.action || value.acknowledgementId || value.correlationId || value.reviewJobId || value.interactionId) fail('unknown/none cannot invent activity')
  if (value.action === 'reviewing' && (!value.reviewJobId || !value.interactionId)) fail('review work needs its independent review and interaction identity')
  if (value.execution && value.execution.workflowNodeId !== value.workflowNodeId) fail('execution/node identity mismatch')
})
export type GraphActivity = z.infer<typeof GraphActivitySchema>
export const GraphAttentionSchema = z.object({
  workflowNodeId: GraphIdSchema, pendingInteractionCount: z.number().int().min(0).max(100000),
  unsettledReviewCount: z.number().int().min(0).max(100000), cleanupPending: z.boolean(),
  telemetry: z.enum(['current', 'unknown', 'stale']),
}).strict()
export type GraphAttention = z.infer<typeof GraphAttentionSchema>
export const GraphRunStateSchema = z.object({
  executionState: RunExecutionStateSchema, outcome: RunOutcomeSchema,
  /** Durable Stop intent, never inferred from cleanup or process absence. */
  stopRequested: z.boolean(),
  cleanupPending: z.boolean(), unsettledReviewCount: z.number().int().min(0).max(100000),
  pendingInteractionCount: z.number().int().min(0).max(100000),
}).strict().superRefine((value, context) => {
  if ((value.executionState === 'completed') === (value.outcome === 'pending')) context.addIssue({ code: 'custom', message: 'Run lifecycle and outcome disagree' })
})
export const GraphInteractionSchema = z.object({
  interactionId: GraphIdSchema, revision: GraphSequenceSchema,
  requester: GraphExecutionIdentitySchema, reviewer: GraphExecutionIdentitySchema.optional(),
  approvalRelationshipId: GraphIdSchema.optional(), handler: z.enum(['user', 'operator', 'orchestrator']),
  status: InteractionStatusSchema, deliveryState: NativeDeliveryStateSchema,
  resumeState: z.enum(['not_started', 'pending', 'acknowledged', 'unknown']),
  resumeAcknowledgementId: GraphIdSchema.optional(),
  selectedOptionId: GraphIdSchema.optional(), decision: ApprovalResponseSemanticSchema.optional(),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (value.handler === 'orchestrator' ? !value.reviewer || !value.approvalRelationshipId : value.reviewer !== undefined || value.approvalRelationshipId !== undefined) fail('review identities must match the explicit handler')
  if (value.resumeState === 'acknowledged' ? !value.resumeAcknowledgementId || value.deliveryState !== 'delivered' : value.resumeAcknowledgementId !== undefined) fail('Worker resumption requires independent native acknowledgement after delivery')
  const decided = value.decision !== undefined && value.selectedOptionId !== undefined
  if ((value.decision !== undefined) !== (value.selectedOptionId !== undefined)) fail('decision/option must be complete')
  if (value.status === 'pending' && decided) fail('pending is not decided')
  if (!['pending', 'canceled'].includes(value.status) && !decided) fail('decision required')
  const allowed: Record<typeof value.status, readonly typeof value.deliveryState[]> = {
    pending: ['not_started'], decided: ['not_started'], delivery_pending: ['pending', 'submitted', 'uncertain'],
    delivered: ['delivered'], delivery_failed: ['failed'], canceled: ['not_started', 'delivered', 'failed', 'uncertain'],
  }
  if (!allowed[value.status]?.includes(value.deliveryState)) fail('delivery is independent but must not contradict interaction lifecycle')
})
export const GraphReviewSchema = z.object({
  reviewJobId: GraphIdSchema, interactionId: GraphIdSchema, relationshipId: GraphIdSchema,
  requester: GraphExecutionIdentitySchema, reviewer: GraphExecutionIdentitySchema,
  revision: GraphSequenceSchema, leaseAttempt: z.number().int().min(0).max(2147483647),
  state: ReviewJobSchema.shape.state,
  nativeCleanup: z.enum(['pending', 'not_started', 'terminal', 'closed']),
  credentialCleanup: z.enum(['pending', 'revoked', 'not_required']),
  acknowledgementId: GraphIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.state === 'acknowledged' && !value.acknowledgementId) context.addIssue({ code: 'custom', message: 'acknowledged review requires native evidence' })
  if (value.state === 'completed' && (value.nativeCleanup === 'pending' || value.credentialCleanup === 'pending')) context.addIssue({ code: 'custom', message: 'completed review cannot retain unresolved settlement' })
})
export const GraphFactSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.state'), state: GraphRunStateSchema }).strict(),
  z.object({ type: z.literal('node.state'), state: GraphNodeStateSchema }).strict(),
  z.object({ type: z.literal('node.activity'), activity: GraphActivitySchema }).strict(),
  z.object({ type: z.literal('node.attention'), attention: GraphAttentionSchema }).strict(),
  z.object({ type: z.literal('result.accepted'), execution: GraphExecutionIdentitySchema, resultDigest: GraphDigestSchema }).strict(),
  z.object({ type: z.literal('node.resolved'), resolution: NodeResolutionSchema }).strict(),
  z.object({ type: z.literal('input.bound'), binding: InputBindingSchema }).strict(),
  z.object({ type: z.literal('interaction.state'), interaction: GraphInteractionSchema }).strict(),
  z.object({ type: z.literal('review.state'), review: GraphReviewSchema }).strict(),
  // Retires a SETTLED exchange from the compact current projection, never from domain history.
  z.object({ type: z.literal('exchange.retired'), exchangeKind: z.enum(['interaction', 'review']), exchangeId: GraphIdSchema, finalRevision: GraphSequenceSchema }).strict(),
  z.object({ type: z.literal('worker.resumed'), interactionId: GraphIdSchema, requester: GraphExecutionIdentitySchema, acknowledgementId: GraphIdSchema }).strict(),
])
export type GraphFact = z.infer<typeof GraphFactSchema>
export const GraphResetReasonSchema = z.enum(['history_expired', 'cursor_ahead', 'gap', 'catchup_limit', 'atomic_change_too_large', 'schema_changed'])
export const PublicGraphProjectionSchema = z.object({
  run: GraphRunStateSchema,
  nodes: z.array(z.object({
    state: GraphNodeStateSchema, activity: GraphActivitySchema, attention: GraphAttentionSchema,
    resolution: NodeResolutionSchema.optional(), acceptedResultDigest: GraphDigestSchema.optional(),
  }).strict().superRefine((node, context) => {
    const id = node.state.workflowNodeId
    if (node.activity.workflowNodeId !== id || node.attention.workflowNodeId !== id || (node.resolution && node.resolution.workflowNodeId !== id)) context.addIssue({ code: 'custom', message: 'snapshot node identities disagree' })
  })).max(RUN_GRAPH_LIMITS.nodes),
  inputBindings: z.array(InputBindingSchema).max(RUN_GRAPH_LIMITS.relationships),
  interactions: z.array(GraphInteractionSchema).max(RUN_GRAPH_LIMITS.exchanges),
  reviews: z.array(GraphReviewSchema).max(RUN_GRAPH_LIMITS.exchanges),
}).strict().superRefine((state, context) => {
  for (const ids of [state.nodes.map((node) => node.state.workflowNodeId), state.inputBindings.map((binding) => binding.bindingId), state.interactions.map((interaction) => interaction.interactionId), state.reviews.map((review) => review.reviewJobId)]) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'snapshot entity identities must be unique' })
  }
})
export type PublicGraphProjection = z.infer<typeof PublicGraphProjectionSchema>
export const PublicGraphTopologySchema = z.object({
  entryNodeId: GraphIdSchema,
  nodes: z.array(z.union([z.object({
    kind:z.literal('agent').optional(),workflowNodeId: GraphIdSchema, agentId: GraphIdSchema, agentConfigurationVersionId: GraphIdSchema,
    productRole: z.enum(['master', 'orchestrator', 'coder', 'unknown']),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
    width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
  }).strict(),z.object({kind:z.literal('job'),workflowNodeId:GraphIdSchema,jobDefinitionId:GraphIdSchema,jobDefinitionVersionId:GraphIdSchema,
    position:z.object({x:z.number().finite(),y:z.number().finite()}).strict().optional(),
    width:z.number().finite().positive().optional(),height:z.number().finite().positive().optional(),
  }).strict()])).min(1).max(RUN_GRAPH_LIMITS.nodes),
  relationships: z.array(z.object({
    relationshipId: GraphIdSchema, kind: z.enum(['execution', 'approval']), source: GraphIdSchema, target: GraphIdSchema,
  }).strict()).max(RUN_GRAPH_LIMITS.relationships),
}).strict().superRefine((value, context) => {
  const nodes = new Set(value.nodes.map((node) => node.workflowNodeId))
  if (nodes.size !== value.nodes.length || !nodes.has(value.entryNodeId)
    || new Set(value.relationships.map((edge) => edge.relationshipId)).size !== value.relationships.length
    || value.relationships.some((edge) => !nodes.has(edge.source) || !nodes.has(edge.target))) {
    context.addIssue({ code: 'custom', message: 'immutable topology identities disagree' })
  }
})
export type PublicGraphTopology = z.infer<typeof PublicGraphTopologySchema>
export const RunGraphErrorCodeSchema = z.enum([
  'GRAPH_INVALID_CURSOR', 'GRAPH_UNSUPPORTED_PROTOCOL', 'GRAPH_SCOPE_MISMATCH', 'GRAPH_NOT_INITIALIZED',
  'GRAPH_SOURCE_CONFLICT', 'GRAPH_TRANSACTION_CLOSED', 'GRAPH_TRANSACTION_NESTED', 'GRAPH_TRANSACTION_CONCURRENT',
  'GRAPH_TRANSACTION_FAILED', 'GRAPH_TRANSACTION_LIMIT', 'GRAPH_SEQUENCE_EXHAUSTED', 'GRAPH_SNAPSHOT_TOO_LARGE',
  'GRAPH_INVALID_FACT', 'GRAPH_READ_ACCESS_DENIED', 'GRAPH_INVARIANT_VIOLATION', 'GRAPH_OWNER_LOST',
  'GRAPH_EFFECT_CONFLICT', 'GRAPH_AUTHORITY_INVALID', 'GRAPH_STALE_FENCE', 'GRAPH_STALE_GENERATION',
  'GRAPH_EFFECT_ACCESS_DENIED', 'GRAPH_SECURITY_UNQUALIFIED', 'GRAPH_SUBMISSION_NOT_REPLAYABLE',
  'GRAPH_TERMINAL_CONFLICT', 'GRAPH_STOP_CONFLICT', 'GRAPH_EVIDENCE_TOO_LARGE', 'GRAPH_EVIDENCE_INVALID',
  'EXECUTION_SEMANTICS_RETIRED', 'EXECUTION_SEMANTICS_UNSUPPORTED',
])
export type RunGraphErrorCode = z.infer<typeof RunGraphErrorCodeSchema>
export const RunGraphErrorResponseSchema = z.object({
  error: z.object({ code: RunGraphErrorCodeSchema, message: z.string().max(160) }).strict(),
}).strict()
export const RunGraphCapabilitiesSchema = z.object({
  capabilityVersion: z.literal(1), protocolVersions: z.array(z.literal(1)).max(1),
  executionSemanticsVersions: z.array(z.literal(3)).max(1),
  authoringSemanticsVersions: z.array(z.literal(3)).max(1), admissionEnabled: z.boolean(),
  transport: z.literal('http_poll'), activePollMs: z.literal(1000),
}).strict()
export const DISABLED_RUN_GRAPH_CAPABILITIES = RunGraphCapabilitiesSchema.parse({
  capabilityVersion: 1, protocolVersions: [], executionSemanticsVersions: [], authoringSemanticsVersions: [], admissionEnabled: false,
  transport: 'http_poll', activePollMs: 1000,
})
export const RUN_GRAPH_ROUTES = Object.freeze({
  capabilities: '/api/capabilities/run-graph/v1',
  snapshot: '/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/snapshot',
  events: '/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/events',
})
export const RUN_GRAPH_MCP_TOOLS = Object.freeze({
  capabilities: 'run_graph_capabilities_v1', snapshot: 'run_graph_snapshot_v1', events: 'run_graph_events_v1',
})
export function sameGraphScope(a: RunGraphScope, b: RunGraphScope): boolean {
  return a.workspaceId === b.workspaceId && a.workflowId === b.workflowId && a.runId === b.runId
    && a.workflowVersionId === b.workflowVersionId && a.executionSemanticsVersion === b.executionSemanticsVersion
}

/** Intentionally enumerated identity surfaces; no generic occurrence/activation traversal. */
export function graphFactExecutions(fact: GraphFact): GraphExecutionIdentity[] {
  switch (fact.type) {
    case 'node.state': return fact.state.execution ? [fact.state.execution] : []
    case 'node.activity': return fact.activity.execution ? [fact.activity.execution] : []
    case 'result.accepted': return [fact.execution]
    case 'node.resolved': return fact.resolution.execution ? [fact.resolution.execution] : []
    case 'input.bound': return [fact.binding.sender, fact.binding.recipient]
    case 'interaction.state': return [fact.interaction.requester, ...(fact.interaction.reviewer ? [fact.interaction.reviewer] : [])]
    case 'review.state': return [fact.review.requester, fact.review.reviewer]
    case 'worker.resumed': return [fact.requester]
    default: return []
  }
}
/** Internal operation identity, independent of observation, reconnect, owner and lease attempt. */
export const GraphEffectIdentitySchema = z.object({
  kind: z.enum(['execution.launch', 'result.accept', 'route.resolve', 'input.bind', 'approval.decide',
    'approval.deliver', 'graph.resume', 'review.settle', 'run.stop']),
  entityId: GraphIdSchema,
}).strict()
export type GraphEffectIdentity = z.infer<typeof GraphEffectIdentitySchema>
export const GraphEffectSchema = z.object({ identity: GraphEffectIdentitySchema, digest: GraphDigestSchema }).strict()
export type GraphEffect = z.infer<typeof GraphEffectSchema>


/** A derived public read-model delta. It neither authorizes native work nor
 * acknowledges delivery; its source is the current G1 projection readback. */
export const PublicGraphDeltaSchema = z.object({
  run: GraphRunStateSchema.optional(),
  nodes: PublicGraphProjectionSchema.shape.nodes,
  inputBindings: PublicGraphProjectionSchema.shape.inputBindings,
  interactions: PublicGraphProjectionSchema.shape.interactions,
  reviews: PublicGraphProjectionSchema.shape.reviews,
  retiredInputBindingIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.relationships),
  retiredInteractionIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.exchanges),
  retiredReviewIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.exchanges),
}).strict().superRefine((value, context) => {
  for (const ids of [value.nodes.map((item) => item.state.workflowNodeId),
    [...value.inputBindings.map((item) => item.bindingId), ...value.retiredInputBindingIds],
    [...value.interactions.map((item) => item.interactionId), ...value.retiredInteractionIds],
    [...value.reviews.map((item) => item.reviewJobId), ...value.retiredReviewIds]]) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Public projection delta identities must be unique.' })
  }
})
export type PublicGraphDelta = z.infer<typeof PublicGraphDeltaSchema>
