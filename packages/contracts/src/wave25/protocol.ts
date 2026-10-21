import { z } from 'zod'
import {
  GraphEvidenceSchema, GraphFactSchema, GraphSequenceSchema, PublicGraphProjectionSchema, PublicGraphTopologySchema,
  RUN_GRAPH_LIMITS, RunGraphScopeSchema, GraphIdSchema, GraphResetReasonSchema, sameGraphScope,
  type GraphExecutionIdentity,
} from './graphPrimitives.js'
import { graphJsonBytes } from './json.js'

/** Run graph event/snapshot wire envelopes. Shared primitives live only in graphPrimitives.ts. */
export const RunGraphEventContentSchema = z.object({
  eventId: z.string().uuid(), evidence: GraphEvidenceSchema, fact: GraphFactSchema,
}).strict().superRefine((value, context) => {
  const nativeRequired = value.fact.type === 'worker.resumed'
    || (value.fact.type === 'node.activity' && value.fact.activity.status === 'active' && value.fact.activity.action !== 'waiting_approval')
    || (value.fact.type === 'node.state' && value.fact.state.lifecycle === 'running')
    || (value.fact.type === 'review.state' && value.fact.review.state === 'acknowledged')
    || (value.fact.type === 'interaction.state' && value.fact.interaction.resumeState === 'acknowledged')
  if (value.fact.type === 'exchange.retired' && !['interaction', 'review', 'cleanup', 'native_event'].includes(value.evidence.sourceKind)) context.addIssue({ code: 'custom', message: 'current-window retirement requires durable settlement evidence' })
  if (nativeRequired && value.evidence.sourceKind !== 'native_event') context.addIssue({ code: 'custom', message: 'native acknowledgement, not a lease or decision, must support active native work' })
})
export const RunGraphEventSchema = RunGraphEventContentSchema.superRefine((value, context) => {
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.eventBytes) context.addIssue({ code: 'custom', message: 'event exceeds byte limit' })
})
export type RunGraphEvent = z.infer<typeof RunGraphEventSchema>
export const RunGraphBatchSchema = z.object({
  protocolVersion: z.literal(1), scope: RunGraphScopeSchema, batchId: z.string().uuid(),
  previousSequence: GraphSequenceSchema, sequence: GraphSequenceSchema,
  events: z.array(RunGraphEventSchema).min(1).max(RUN_GRAPH_LIMITS.batchEvents),
}).strict().superRefine((value, context) => {
  if (!GraphSequenceSchema.safeParse(value.sequence).success || !GraphSequenceSchema.safeParse(value.previousSequence).success) return
  if (BigInt(value.sequence) !== BigInt(value.previousSequence) + 1n) context.addIssue({ code: 'custom', message: 'batch must advance exactly one complete publication position' })
  if (new Set(value.events.map((event) => event.eventId)).size !== value.events.length) context.addIssue({ code: 'custom', message: 'event IDs must be unique within a batch' })
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.batchBytes) context.addIssue({ code: 'custom', message: 'batch exceeds byte limit' })
})
export type RunGraphBatch = z.infer<typeof RunGraphBatchSchema>
export const RunGraphPageSchema = z.object({
  kind: z.literal('page'), protocolVersion: z.literal(1), scope: RunGraphScopeSchema,
  baseSequence: GraphSequenceSchema, throughSequence: GraphSequenceSchema, headSequence: GraphSequenceSchema,
  /** Lowest valid AFTER cursor. Retained complete batches have sequence > retentionFloor. */
  retentionFloor: GraphSequenceSchema, hasMore: z.boolean(),
  batches: z.array(RunGraphBatchSchema).max(RUN_GRAPH_LIMITS.pageBatches),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (![value.baseSequence, value.throughSequence, value.headSequence, value.retentionFloor].every((cursor) => GraphSequenceSchema.safeParse(cursor).success)) return
  let cursor = value.baseSequence
  for (const batch of value.batches) {
    if (batch.previousSequence !== cursor || !sameGraphScope(batch.scope, value.scope)) fail('gap or scope mismatch')
    cursor = batch.sequence
  }
  if (cursor !== value.throughSequence || BigInt(cursor) > BigInt(value.headSequence)) fail('through/head mismatch')
  if (BigInt(value.baseSequence) < BigInt(value.retentionFloor)) fail('expired cursor')
  if (value.hasMore !== (BigInt(cursor) < BigInt(value.headSequence))) fail('hasMore must describe the captured head')
  if (value.hasMore && !value.batches.length) fail('a catch-up page must make progress or reset')
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.pageBytes) fail('page exceeds byte limit')
})
export type RunGraphPage = z.infer<typeof RunGraphPageSchema>
export const RunGraphResetSchema = z.object({
  kind: z.literal('reset'), protocolVersion: z.literal(1), scope: RunGraphScopeSchema,
  reason: GraphResetReasonSchema, requestedSequence: GraphSequenceSchema,
  headSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema, action: z.literal('fetch_snapshot'),
}).strict().superRefine((value, context) => {
  if (![value.retentionFloor, value.headSequence].every((cursor) => GraphSequenceSchema.safeParse(cursor).success)) return
  if (BigInt(value.retentionFloor) > BigInt(value.headSequence)) context.addIssue({ code: 'custom', message: 'retention floor exceeds head' })
})
export type RunGraphReset = z.infer<typeof RunGraphResetSchema>
export const RunGraphEventsResponseSchema = z.discriminatedUnion('kind', [RunGraphPageSchema, RunGraphResetSchema])
export const RunGraphSnapshotSchema = z.object({
  protocolVersion: z.literal(1), scope: RunGraphScopeSchema,
  asOfSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema,
  historyCoverage: z.enum(['from_admission', 'from_snapshot']), topology: PublicGraphTopologySchema, state: PublicGraphProjectionSchema,
}).strict().superRefine((value, context) => {
  if (![value.retentionFloor, value.asOfSequence].every((cursor) => GraphSequenceSchema.safeParse(cursor).success)) return
  if (BigInt(value.retentionFloor) > BigInt(value.asOfSequence)) context.addIssue({ code: 'custom', message: 'snapshot cursor predates retention floor' })
  const nodeIds = new Set(value.topology.nodes.map((node) => node.workflowNodeId))
  if (nodeIds.size !== value.state.nodes.length || value.state.nodes.some((node) => !nodeIds.has(node.state.workflowNodeId))) context.addIssue({ code: 'custom', message: 'snapshot must cover every node of the pinned topology' })
  const topology = new Map(value.topology.nodes.map((node) => [node.workflowNodeId, node]))
  const identities = [
    ...value.state.nodes.flatMap((node) => [node.state.execution, node.activity.execution, node.resolution?.execution].filter((item): item is GraphExecutionIdentity => item !== undefined)),
    ...value.state.inputBindings.flatMap((binding) => [binding.sender, binding.recipient]),
    ...value.state.interactions.flatMap((interaction) => [interaction.requester, ...(interaction.reviewer ? [interaction.reviewer] : [])]),
    ...value.state.reviews.flatMap((review) => [review.requester, review.reviewer]),
  ]
  for (const identity of identities) {
    const pinned = topology.get(identity.workflowNodeId)
    if (!pinned || (identity.kind==='job' ? pinned.kind!=='job'||pinned.jobDefinitionId!==identity.jobDefinitionId||pinned.jobDefinitionVersionId!==identity.jobDefinitionVersionId : pinned.kind==='job'||pinned.agentId!==identity.agentId||pinned.agentConfigurationVersionId!==identity.agentConfigurationVersionId)) context.addIssue({ code: 'custom', message: 'runtime identity conflicts with immutable topology' })
  }
  const relationships = new Map(value.topology.relationships.map((relationship) => [relationship.relationshipId, relationship]))
  for (const binding of value.state.inputBindings) {
    const relationship = relationships.get(binding.relationshipId)
    if (!relationship || relationship.kind !== 'execution' || relationship.source !== binding.sender.workflowNodeId || relationship.target !== binding.recipient.workflowNodeId) context.addIssue({ code: 'custom', message: 'handoff conflicts with immutable execution relationship' })
  }
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.snapshotBytes) context.addIssue({ code: 'custom', message: 'snapshot exceeds byte limit; do not truncate unresolved entities' })
})
export type RunGraphSnapshot = z.infer<typeof RunGraphSnapshotSchema>
export const RunGraphReadRequestSchema = z.object({ scope: RunGraphScopeSchema, protocolVersion: z.literal(1) }).strict()
export const RunGraphEventsRequestSchema = RunGraphReadRequestSchema.extend({ afterSequence: GraphSequenceSchema }).strict()
export const RunGraphHttpSnapshotQuerySchema = z.object({
  workflowVersionId: GraphIdSchema, executionSemanticsVersion: z.literal('3'),
}).strict()
export const RunGraphHttpEventsQuerySchema = RunGraphHttpSnapshotQuerySchema.extend({ afterSequence: GraphSequenceSchema }).strict()
