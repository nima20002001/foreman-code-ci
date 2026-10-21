import { z } from 'zod'
import {
  GraphDigestSchema, GraphEvidenceSchema, extendGraphExecutionIdentitySchema, GraphIdSchema,
  GraphRunStateSchema, GraphSequenceSchema, NodeResolutionSchema, RUN_GRAPH_LIMITS,
  RunGraphScopeSchema, PublicGraphTopologySchema, PublicGraphProjectionSchema,
  GraphResetReasonSchema, RUN_GRAPH_ROUTES, RUN_GRAPH_MCP_TOOLS, GraphFactSchema,
  GraphEffectSchema, PublicGraphDeltaSchema, graphFactExecutions, type GraphFact, type GraphExecutionIdentity,
} from './graphPrimitives.js'
import {
  RepeatDecisionMetadataV1Schema, RepeatOccurrenceIdentityV1Schema, RepeatOccurrenceV1Schema, RepeatPlanV1Schema, type RepeatOccurrenceIdentityV1 } from './repeat.js'
import { WorkflowVersionV3Schema, type WorkflowVersionV3 } from './saved.js'
import { canonicalGraphJson, graphJsonBytes } from './json.js'
import { ChoiceOutcomeSchema, ChoiceTargetSchema } from './currentResult.js'

/** Semantics 3 on protocol 1 and the EXISTING per-Run complete-batch cursor.
 * Execution pins are V3-only. The graph wire protocol remains version 1.
 * These are metadata, not a second result, acknowledgement or execution API. */
export const RepeatGraphScopeV3Schema = RepeatOccurrenceIdentityV1Schema.shape.scope
export type RepeatGraphScopeV3 = z.infer<typeof RepeatGraphScopeV3Schema>
export const CanonicalRunGraphScopeSchema = RunGraphScopeSchema
export type CanonicalRunGraphScope = z.infer<typeof CanonicalRunGraphScopeSchema>
export function sameCanonicalGraphScope(a: CanonicalRunGraphScope, b: CanonicalRunGraphScope): boolean {
  return a.workspaceId === b.workspaceId && a.workflowId === b.workflowId && a.runId === b.runId
    && a.workflowVersionId === b.workflowVersionId && a.executionSemanticsVersion === b.executionSemanticsVersion
}
export const REPEAT_GRAPH_LIMITS = Object.freeze({
  occurrences: 2000, executions: 16000, resolutions: 16000, bindings: 16001, decisions: 2000,
})
const RepeatGraphRefV3Schema = z.object({
  nodeId: GraphIdSchema, occurrence: RepeatOccurrenceIdentityV1Schema.nullable(),
}).strict()
export const RepeatGraphExecutionIdentityV3Schema = extendGraphExecutionIdentitySchema({
  // Null is the outside DAG. Never replace it with a technical-attempt ordinal.
  occurrence: RepeatOccurrenceIdentityV1Schema.nullable(),
})
type RepeatGraphExecutionIdentityV3 = z.infer<typeof RepeatGraphExecutionIdentityV3Schema>
const RepeatGraphRunStateV3Schema = GraphRunStateSchema
export const RepeatGraphExecutionV3Schema = z.object({
  identity: RepeatGraphExecutionIdentityV3Schema, inputDigest: GraphDigestSchema,
  /** Present only for the new versioned work-handoff policy. */
  workActivationId: GraphIdSchema.optional(),
  /** Present only for an interval check of its node; checks never route the graph. */
  tickIndex: z.number().int().positive().optional(),
  previousExecutionId: GraphIdSchema.nullable(),
  continuedFromExecutionId: GraphIdSchema.optional(),
  // Observed durable lifecycle only. No native-active/acknowledged inference.
  state: z.enum(['queued', 'starting', 'running', 'waiting', 'completed']),
  resultOutcome: z.enum(['succeeded', 'failed', 'canceled']).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.state === 'completed') !== (value.resultOutcome !== null)
    || (value.identity.attempt === 1) !== (value.previousExecutionId === null)
    || value.previousExecutionId === value.identity.executionId
    || value.workActivationId !== undefined && value.identity.occurrence !== null
    || value.tickIndex !== undefined && (value.identity.occurrence !== null || value.workActivationId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_EXECUTION_CONFLICT' })
  }
})
export type RepeatGraphExecutionV3 = z.infer<typeof RepeatGraphExecutionV3Schema>
export const RepeatGraphResolutionV3Schema = z.object({
  ref: RepeatGraphRefV3Schema, value: NodeResolutionSchema,
  deferredRelationshipIds: z.array(GraphIdSchema).max(RUN_GRAPH_LIMITS.relationships),
  // A final export retains the exit's occurrence but has the outside namespace.
  outside: z.boolean(),
}).strict().superRefine((value, context) => {
  const all = [...value.value.selectedRelationshipIds, ...value.value.unselectedRelationshipIds, ...value.deferredRelationshipIds]
  if (value.ref.nodeId !== value.value.workflowNodeId || !value.outside && value.ref.occurrence === null
    || new Set(all).size !== all.length || value.outside && value.deferredRelationshipIds.length !== 0) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_RESOLUTION_CONFLICT' })
  }
})
export type RepeatGraphResolutionV3 = z.infer<typeof RepeatGraphResolutionV3Schema>
export function repeatGraphResolutionKey(value: RepeatGraphResolutionV3): string {
  return canonicalGraphJson([value.outside ? null : value.ref.occurrence?.occurrenceId, value.ref.nodeId])
}
export const RepeatGraphBindingV3Schema = z.object({
  bindingId: GraphIdSchema, recipient: RepeatGraphExecutionIdentityV3Schema,
  sender: RepeatGraphExecutionIdentityV3Schema, acceptedResultDigest: GraphDigestSchema,
  inputDigest: GraphDigestSchema, ordinal: z.number().int().min(0).max(16000),
  kind: z.enum(['predecessor', 'external', 'carry']),
  relationshipId: GraphIdSchema.nullable(), decisionId: GraphIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.recipient.executionId === value.sender.executionId
    || (value.kind === 'carry' ? value.relationshipId !== null || value.decisionId === null
      : value.relationshipId === null || value.decisionId !== null)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_BINDING_CONFLICT' })
  }
})
export type RepeatGraphBindingV3 = z.infer<typeof RepeatGraphBindingV3Schema>
const RepeatGraphResultV3Schema = z.object({
  execution: RepeatGraphExecutionIdentityV3Schema, resultDigest: GraphDigestSchema,
}).strict()
export const RepeatGraphFactV3Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('repeat.run.state'), state: RepeatGraphRunStateV3Schema }).strict(),
  z.object({ type: z.literal('repeat.occurrence'), occurrence: RepeatOccurrenceV1Schema }).strict(),
  z.object({ type: z.literal('repeat.decision'), decision: RepeatDecisionMetadataV1Schema }).strict(),
  z.object({ type: z.literal('repeat.execution'), execution: RepeatGraphExecutionV3Schema }).strict(),
  z.object({ type: z.literal('repeat.node.resolved'), resolution: RepeatGraphResolutionV3Schema }).strict(),
  z.object({ type: z.literal('repeat.result.accepted'), result: RepeatGraphResultV3Schema }).strict(),
  z.object({ type: z.literal('repeat.input.bound'), binding: RepeatGraphBindingV3Schema }).strict(),
])
export type RepeatGraphFactV3 = z.infer<typeof RepeatGraphFactV3Schema>
export const RepeatGraphEffectV3Schema = z.object({
  identity: z.object({
    kind: z.enum(['input.bind', 'result.accept', 'route.resolve', 'execution.launch']),
    entityId: GraphIdSchema,
  }).strict(), digest: GraphDigestSchema,
  operation: z.enum(['occurrence.create', 'input.bind', 'terminal.accept', 'node.inactive', 'run.complete', 'execution.launch']),
  subjectId: GraphIdSchema,
}).strict().superRefine((value, context) => {
  const storage = { 'occurrence.create': 'input.bind', 'input.bind': 'input.bind',
    'terminal.accept': 'result.accept', 'node.inactive': 'route.resolve',
    'run.complete': 'route.resolve', 'execution.launch': 'execution.launch' } as const
  if (storage[value.operation] !== value.identity.kind || value.operation === 'execution.launch' && value.subjectId !== value.identity.entityId) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_EFFECT_IDENTITY_CONFLICT' })
  }
})
export type RepeatGraphEffectV3 = z.infer<typeof RepeatGraphEffectV3Schema>
export const RepeatGraphEventContentV3Schema = z.object({
  eventId: z.string().uuid(), evidence: GraphEvidenceSchema, sourceDigest: GraphDigestSchema,
  semanticDigest: GraphDigestSchema, effect: z.union([RepeatGraphEffectV3Schema, GraphEffectSchema]).nullable(),
  fact: z.union([RepeatGraphFactV3Schema, GraphFactSchema,
    z.object({ type: z.literal('workflow.presentation'), delta: PublicGraphDeltaSchema }).strict()]),
}).strict().superRefine((value, context) => {
  const fact = value.fact
  const nativeRequired = fact.type === 'worker.resumed'
    || fact.type === 'node.activity' && fact.activity.status === 'active' && fact.activity.action !== 'waiting_approval'
    || fact.type === 'node.state' && fact.state.lifecycle === 'running'
    || fact.type === 'review.state' && fact.review.state === 'acknowledged'
    || fact.type === 'interaction.state' && fact.interaction.resumeState === 'acknowledged'
  if (nativeRequired && value.evidence.sourceKind !== 'native_event') {
    context.addIssue({ code: 'custom', message: 'Active native work requires original native acknowledgement evidence.' })
  }
  if (fact.type === 'exchange.retired' && !['interaction', 'review', 'cleanup', 'native_event'].includes(value.evidence.sourceKind)) {
    context.addIssue({ code: 'custom', message: 'Exchange retirement requires durable settlement evidence.' })
  }
})
const RepeatGraphEventV3Schema = RepeatGraphEventContentV3Schema.superRefine((event, context) => {
  if (graphJsonBytes(event) > RUN_GRAPH_LIMITS.eventBytes) context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_EVENT_TOO_LARGE' })
})
export type RepeatGraphEventV3 = z.infer<typeof RepeatGraphEventV3Schema>

function repeatGraphFactIdentities(fact: RepeatGraphFactV3 | GraphFact | { type: 'workflow.presentation'; delta: z.infer<typeof PublicGraphDeltaSchema> }): RepeatGraphExecutionIdentityV3[] {
  switch (fact.type) {
    case 'repeat.execution': return [fact.execution.identity]
    case 'repeat.result.accepted': return [fact.result.execution]
    case 'repeat.input.bound': return [fact.binding.sender, fact.binding.recipient]
    case 'repeat.decision': return [fact.decision.exitExecution]
    case 'repeat.node.resolved': return fact.resolution.value.execution
      ? [{ ...fact.resolution.value.execution, occurrence: fact.resolution.ref.occurrence }] : []
    default: return []
  }
}
export function assertRepeatGraphFactScope(scope: RepeatGraphScopeV3, fact: RepeatGraphFactV3 | GraphFact | { type: 'workflow.presentation'; delta: z.infer<typeof PublicGraphDeltaSchema> }): void {
  const occurrences: (RepeatOccurrenceIdentityV1 | null)[] = repeatGraphFactIdentities(fact).map((identity) => identity.occurrence)
  if (fact.type === 'repeat.occurrence') occurrences.push(fact.occurrence.identity)
  if (fact.type === 'repeat.decision') occurrences.push(fact.decision.occurrence.identity)
  if (fact.type === 'repeat.node.resolved') occurrences.push(fact.resolution.ref.occurrence)
  if (occurrences.some((occurrence) => occurrence && !sameCanonicalGraphScope(occurrence.scope, scope))) {
    throw new Error('REPEAT_GRAPH_SCOPE_CONFLICT')
  }
}
export const RepeatGraphBatchV3Schema = z.object({
  protocolVersion: z.literal(1), scope: RepeatGraphScopeV3Schema, batchId: z.string().uuid(),
  previousSequence: GraphSequenceSchema, sequence: GraphSequenceSchema,
  events: z.array(RepeatGraphEventV3Schema).min(1).max(RUN_GRAPH_LIMITS.batchEvents),
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_BATCH_CONFLICT' })
  if (!GraphSequenceSchema.safeParse(value.sequence).success || !GraphSequenceSchema.safeParse(value.previousSequence).success) return
  if (BigInt(value.sequence) !== BigInt(value.previousSequence) + 1n
    || new Set(value.events.map((event) => event.eventId)).size !== value.events.length) fail()
  const sources = new Map<string, string>()
  for (const event of value.events) {
    try { assertRepeatGraphFactScope(value.scope, event.fact) } catch { fail() }
    const key = canonicalGraphJson(event.evidence)
    const receipt = canonicalGraphJson([event.sourceDigest, event.semanticDigest, event.effect])
    if (sources.has(key) && sources.get(key) !== receipt) fail()
    sources.set(key, receipt)
  }
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.batchBytes) fail()
})
export type RepeatGraphBatchV3 = z.infer<typeof RepeatGraphBatchV3Schema>
export const RepeatGraphPageV3Schema = z.object({
  kind: z.literal('page'), protocolVersion: z.literal(1), scope: RepeatGraphScopeV3Schema,
  baseSequence: GraphSequenceSchema, throughSequence: GraphSequenceSchema, headSequence: GraphSequenceSchema,
  retentionFloor: GraphSequenceSchema, hasMore: z.boolean(),
  batches: z.array(RepeatGraphBatchV3Schema).max(RUN_GRAPH_LIMITS.pageBatches),
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_PAGE_CONFLICT' })
  if (![value.baseSequence, value.throughSequence, value.headSequence, value.retentionFloor]
    .every((sequence) => GraphSequenceSchema.safeParse(sequence).success)) return
  let cursor = value.baseSequence
  const sources = new Set<string>()
  for (const batch of value.batches) {
    if (batch.previousSequence !== cursor || !sameCanonicalGraphScope(batch.scope, value.scope)) fail()
    cursor = batch.sequence
    const batchSources = new Set(batch.events.map((event) => canonicalGraphJson(event.evidence)))
    for (const source of batchSources) { if (sources.has(source)) fail(); sources.add(source) }
  }
  if (cursor !== value.throughSequence || BigInt(cursor) > BigInt(value.headSequence)
    || BigInt(value.baseSequence) < BigInt(value.retentionFloor)
    || value.hasMore !== (BigInt(cursor) < BigInt(value.headSequence))
    || value.hasMore && value.batches.length === 0 || graphJsonBytes(value) > RUN_GRAPH_LIMITS.pageBytes) fail()
})
export type RepeatGraphPageV3 = z.infer<typeof RepeatGraphPageV3Schema>
export const RepeatGraphResetV3Schema = z.object({
  kind: z.literal('reset'), protocolVersion: z.literal(1), scope: RepeatGraphScopeV3Schema,
  reason: GraphResetReasonSchema, requestedSequence: GraphSequenceSchema,
  headSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema, action: z.literal('fetch_snapshot'),
}).strict().superRefine((value, context) => {
  if (GraphSequenceSchema.safeParse(value.retentionFloor).success && GraphSequenceSchema.safeParse(value.headSequence).success
    && BigInt(value.retentionFloor) > BigInt(value.headSequence)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_RESET_CONFLICT' })
  }
})
export type RepeatGraphResetV3 = z.infer<typeof RepeatGraphResetV3Schema>
const RepeatGraphEventsResponseV3Schema = z.discriminatedUnion('kind', [RepeatGraphPageV3Schema, RepeatGraphResetV3Schema])
export const RepeatGraphReadRequestV3Schema = z.object({ protocolVersion: z.literal(1), scope: RepeatGraphScopeV3Schema }).strict()
export const RepeatGraphEventsRequestV3Schema = RepeatGraphReadRequestV3Schema.extend({ afterSequence: GraphSequenceSchema }).strict()
const RepeatGraphHttpSnapshotQueryV3Schema = z.object({ workflowVersionId: GraphIdSchema, executionSemanticsVersion: z.literal('3') }).strict()
const RepeatGraphHttpEventsQueryV3Schema = RepeatGraphHttpSnapshotQueryV3Schema.extend({ afterSequence: GraphSequenceSchema }).strict()

export const RepeatGraphStateV3Schema = z.object({
  ...PublicGraphProjectionSchema.shape,
  run: RepeatGraphRunStateV3Schema,
  occurrences: z.array(RepeatOccurrenceV1Schema).max(REPEAT_GRAPH_LIMITS.occurrences),
  executions: z.array(RepeatGraphExecutionV3Schema).max(REPEAT_GRAPH_LIMITS.executions),
  resolutions: z.array(RepeatGraphResolutionV3Schema).max(REPEAT_GRAPH_LIMITS.resolutions),
  results: z.array(RepeatGraphResultV3Schema).max(REPEAT_GRAPH_LIMITS.executions),
  bindings: z.array(RepeatGraphBindingV3Schema).max(REPEAT_GRAPH_LIMITS.bindings),
  decisions: z.array(RepeatDecisionMetadataV1Schema).max(REPEAT_GRAPH_LIMITS.decisions),
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_STATE_CONFLICT' })
  const ids = [value.occurrences.map((item) => item.identity.occurrenceId),
    value.occurrences.map((item) => canonicalGraphJson([item.identity.blockId, item.identity.occurrenceIndex])),
    value.executions.map((item) => item.identity.executionId), value.resolutions.map(repeatGraphResolutionKey),
    value.results.map((item) => item.execution.executionId), value.bindings.map((item) => item.bindingId),
    value.bindings.map((item) => canonicalGraphJson([item.recipient.executionId, item.ordinal])),
    value.decisions.map((item) => item.decisionId), value.decisions.map((item) => item.occurrence.identity.occurrenceId)]
  if (ids.some((keys) => new Set(keys).size !== keys.length)) fail()
  const occurrences = new Map(value.occurrences.map((item) => [item.identity.occurrenceId, item]))
  const executions = new Map(value.executions.map((item) => [item.identity.executionId, item]))
  const results = new Map(value.results.map((item) => [item.execution.executionId, item]))
  const decisions = new Map(value.decisions.map((item) => [item.decisionId, item]))
  const same = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
  if (!PublicGraphProjectionSchema.safeParse({ run: value.run, nodes: value.nodes,
    inputBindings: value.inputBindings, interactions: value.interactions, reviews: value.reviews }).success) fail()
  for (const node of value.nodes) {
    if (node.state.execution) {
      const actual = executions.get(node.state.execution.executionId)
      const bare = actual && (({ occurrence, ...identity }) => { void occurrence; return identity })(actual.identity)
      if (!bare || !same(node.state.execution, bare)) fail()
    }
    if (node.resolution) {
      const matched = value.resolutions.find((item) => same(item.value, node.resolution))
      if (!matched || node.acceptedResultDigest !== node.resolution.acceptedResultDigest) fail()
    }
  }
  for (const binding of value.inputBindings) {
    const actual = value.bindings.find((item) => item.bindingId === binding.bindingId)
    if (!actual || actual.relationshipId !== binding.relationshipId
      || actual.sender.executionId !== binding.sender.executionId || actual.recipient.executionId !== binding.recipient.executionId
      || actual.inputDigest !== binding.recipientInputDigest || actual.acceptedResultDigest !== binding.acceptedResultDigest) fail()
  }
  for (const fact of publicProjectionFacts(value)) {
    for (const identity of graphFactExecutions(fact)) {
      const actual = executions.get(identity.executionId)
      const bare = actual && (({ occurrence, ...value }) => { void occurrence; return value })(actual.identity)
      if (!bare || !same(bare, identity)) fail()
    }
  }
  for (const execution of value.executions) {
    const { identity } = execution
    if (identity.occurrence && !same(occurrences.get(identity.occurrence.occurrenceId)?.identity ?? null, identity.occurrence)) fail()
    if (execution.previousExecutionId) {
      const previous = executions.get(execution.previousExecutionId)
      if (!previous || previous.identity.attempt !== identity.attempt - 1 || previous.identity.workflowNodeId !== identity.workflowNodeId
        || !same(previous.identity.occurrence, identity.occurrence) || previous.inputDigest !== execution.inputDigest
        || previous.state !== 'completed' || previous.resultOutcome === 'succeeded') fail()
    }
  }
  for (const result of value.results) {
    const execution = executions.get(result.execution.executionId)
    if (!execution || !same(execution.identity, result.execution) || execution.resultOutcome !== 'succeeded' || execution.state !== 'completed') fail()
  }
  for (const binding of value.bindings) {
    const recipient = executions.get(binding.recipient.executionId), sender = results.get(binding.sender.executionId)
    if (!recipient || !same(recipient.identity, binding.recipient) || recipient.inputDigest !== binding.inputDigest
      || !sender || !same(sender.execution, binding.sender) || sender.resultDigest !== binding.acceptedResultDigest) fail()
    if (binding.kind === 'carry') {
      const decision = binding.decisionId ? decisions.get(binding.decisionId) : undefined
      if (!decision || !same(decision.exitExecution, binding.sender) || decision.acceptedResultDigest !== binding.acceptedResultDigest
        || decision.reason !== 'repeat' || !binding.recipient.occurrence
        || binding.recipient.occurrence.blockId !== decision.occurrence.identity.blockId
        || binding.recipient.occurrence.occurrenceIndex !== decision.occurrence.identity.occurrenceIndex + 1) fail()
    }
  }
  for (const resolution of value.resolutions) {
    const execution = resolution.value.execution
    if (execution) {
      const stored = executions.get(execution.executionId)
      if (!stored || !same(stored.identity, { ...execution, occurrence: resolution.ref.occurrence }) || stored.state !== 'completed') fail()
      if (resolution.value.acceptedResultDigest && results.get(execution.executionId)?.resultDigest !== resolution.value.acceptedResultDigest) fail()
    }
  }
  for (const occurrence of value.occurrences) {
    const previous = occurrence.input.previous
    if (previous) {
      const decision = decisions.get(previous.decisionId)
      if (!decision || decision.reason !== 'repeat' || decision.acceptedResultDigest !== previous.acceptedResultDigest
        || decision.occurrence.identity.occurrenceId !== previous.occurrenceId
        || decision.occurrence.identity.occurrenceIndex !== previous.occurrenceIndex
        || decision.occurrence.identity.blockId !== occurrence.identity.blockId) fail()
    }
  }
  for (const decision of value.decisions) {
    if (!same(occurrences.get(decision.occurrence.identity.occurrenceId) ?? null, decision.occurrence)
      || !same(results.get(decision.exitExecution.executionId)?.execution ?? null, decision.exitExecution)
      || results.get(decision.exitExecution.executionId)?.resultDigest !== decision.acceptedResultDigest) fail()
  }
})
export type RepeatGraphStateV3 = z.infer<typeof RepeatGraphStateV3Schema>
const RepeatGraphTopologyV3Schema = PublicGraphTopologySchema.safeExtend({
  repeat: RepeatPlanV1Schema.optional(),
  nodes: z.array(z.union(PublicGraphTopologySchema.shape.nodes.element.options.map(schema=>schema.extend({
    choice: z.object({ outcomes: z.array(z.object({ outcome: ChoiceOutcomeSchema, target: ChoiceTargetSchema }).strict())
      .min(1).max(RUN_GRAPH_LIMITS.relationships) }).strict().optional(),
  })))).min(1).max(RUN_GRAPH_LIMITS.nodes),
}).superRefine((value, context) => {
  const nodes = new Set(value.nodes.map((node) => node.workflowNodeId))
  if ((value.repeat?.blocks ?? []).some((block) => block.nodeIds.some((id) => !nodes.has(id)))) {
    context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_TOPOLOGY_CONFLICT' })
  }
})
type RepeatGraphTopologyV3 = z.infer<typeof RepeatGraphTopologyV3Schema>
const RepeatGraphSnapshotBaseV3Schema = z.object({
  kind: z.enum(['snapshot', 'current']), protocolVersion: z.literal(1), scope: RepeatGraphScopeV3Schema,
  asOfSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema,
  historyCoverage: z.enum(['from_admission', 'from_snapshot']),
  topology: RepeatGraphTopologyV3Schema, state: RepeatGraphStateV3Schema,
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'REPEAT_GRAPH_SNAPSHOT_CONFLICT' })
  if (GraphSequenceSchema.safeParse(value.retentionFloor).success && GraphSequenceSchema.safeParse(value.asOfSequence).success
    && BigInt(value.retentionFloor) > BigInt(value.asOfSequence)) fail()
  for (const fact of [...repeatGraphStateFacts(value.state), ...publicProjectionFacts(value.state)]) {
    try { assertRepeatGraphFactScope(value.scope, fact); assertTopologyFact(value.topology, fact) } catch { fail() }
  }
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.snapshotBytes) fail()
})
export const RepeatGraphSnapshotV3Schema = RepeatGraphSnapshotBaseV3Schema.safeExtend({ kind: z.literal('snapshot') })
export type RepeatGraphSnapshotV3 = z.infer<typeof RepeatGraphSnapshotV3Schema>
export const RepeatGraphCurrentV3Schema = RepeatGraphSnapshotBaseV3Schema.safeExtend({ kind: z.literal('current') })

/** A stable presentation order, independent of SQL row order or page boundaries. */
export function sortRepeatGraphState(state: RepeatGraphStateV3): RepeatGraphStateV3 {
  const by = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => {
    const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0
  })
  return { run: state.run, nodes: by(state.nodes, (item) => item.state.workflowNodeId),
    inputBindings: by(state.inputBindings, (item) => item.bindingId),
    interactions: by(state.interactions, (item) => item.interactionId), reviews: by(state.reviews, (item) => item.reviewJobId), occurrences: by(state.occurrences, (item) => item.identity.occurrenceId),
    executions: by(state.executions, (item) => item.identity.executionId),
    resolutions: by(state.resolutions, repeatGraphResolutionKey),
    results: by(state.results, (item) => item.execution.executionId), bindings: by(state.bindings, (item) => item.bindingId),
    decisions: by(state.decisions, (item) => item.decisionId) }
}
export function repeatGraphStateFacts(state: RepeatGraphStateV3): RepeatGraphFactV3[] {
  return [{ type: 'repeat.run.state', state: state.run },
    ...state.occurrences.map((occurrence): RepeatGraphFactV3 => ({ type: 'repeat.occurrence', occurrence })),
    ...state.executions.map((execution): RepeatGraphFactV3 => ({ type: 'repeat.execution', execution })),
    ...state.resolutions.map((resolution): RepeatGraphFactV3 => ({ type: 'repeat.node.resolved', resolution })),
    ...state.results.map((result): RepeatGraphFactV3 => ({ type: 'repeat.result.accepted', result })),
    ...state.bindings.map((binding): RepeatGraphFactV3 => ({ type: 'repeat.input.bound', binding })),
    ...state.decisions.map((decision): RepeatGraphFactV3 => ({ type: 'repeat.decision', decision }))]
}
function assertTopologyFact(topology: RepeatGraphTopologyV3, fact: RepeatGraphFactV3 | GraphFact | { type: 'workflow.presentation'; delta: z.infer<typeof PublicGraphDeltaSchema> }): void {
  const fail = (): never => { throw new Error('REPEAT_GRAPH_PIN_CONFLICT') }
  const ref = (nodeId: string, occurrence: RepeatOccurrenceIdentityV1 | null) => {
    const node = topology.nodes.find((item) => item.workflowNodeId === nodeId)
    const block = topology.repeat?.blocks.find((item) => item.nodeIds.includes(nodeId))
    if (!node || (block ? !occurrence || occurrence.blockId !== block.id || occurrence.occurrenceIndex > block.maxOccurrences : occurrence !== null)) fail()
    return node!
  }
  if (GraphFactSchema.safeParse(fact).success) {
    for (const identity of graphFactExecutions(fact as GraphFact)) {
      const node = topology.nodes.find((item) => item.workflowNodeId === identity.workflowNodeId)
      if (!node || (identity.kind==='job'?node.kind!=='job'||node.jobDefinitionId!==identity.jobDefinitionId||node.jobDefinitionVersionId!==identity.jobDefinitionVersionId:node.kind==='job'||node.agentId!==identity.agentId||node.agentConfigurationVersionId!==identity.agentConfigurationVersionId)) fail()
    }
    if (fact.type === 'input.bound') {
      const edge = topology.relationships.find((item) => item.relationshipId === fact.binding.relationshipId)
      if (!edge || edge.kind !== 'execution' || edge.source !== fact.binding.sender.workflowNodeId || edge.target !== fact.binding.recipient.workflowNodeId) fail()
    }
    return
  }
  for (const identity of repeatGraphFactIdentities(fact)) {
    const node = ref(identity.workflowNodeId, identity.occurrence)
    if ((identity.kind==='job'?node.kind!=='job'||node.jobDefinitionId!==identity.jobDefinitionId||node.jobDefinitionVersionId!==identity.jobDefinitionVersionId:node.kind==='job'||node.agentId!==identity.agentId||node.agentConfigurationVersionId!==identity.agentConfigurationVersionId)) fail()
  }
  if (fact.type === 'repeat.occurrence' || fact.type === 'repeat.decision') {
    const occurrence = fact.type === 'repeat.occurrence' ? fact.occurrence : fact.decision.occurrence
    const block = topology.repeat?.blocks.find((item) => item.id === occurrence.identity.blockId)
    if (!block || occurrence.identity.occurrenceIndex > block.maxOccurrences) fail()
    if (fact.type === 'repeat.decision') {
      const decision = fact.decision
      if (decision.exitExecution.workflowNodeId !== block!.exitNodeId) fail()
      const early = decision.outcome === block!.earlyExitOutcome
      if (!early && decision.outcome !== block!.repeatOutcome) fail()
      const reason = early ? 'early_exit' : occurrence.identity.occurrenceIndex < block!.maxOccurrences ? 'repeat' : 'limit_exit'
      if (decision.reason !== reason) fail()
      if (reason === 'repeat' && (decision.target.kind !== 'next_occurrence'
        || decision.target.entryNodeId !== block!.entryNodeId || decision.target.occurrenceIndex !== occurrence.identity.occurrenceIndex + 1)) fail()
      if (reason === 'limit_exit' && canonicalGraphJson(decision.target) !== canonicalGraphJson(block!.limitExit)) fail()
      if (reason === 'early_exit') {
        const target = topology.nodes.find((node) => node.workflowNodeId === block!.exitNodeId)?.choice?.outcomes
          .find((item) => item.outcome === block!.earlyExitOutcome)?.target
        if (!target || canonicalGraphJson(decision.target) !== canonicalGraphJson(target)) fail()
      }
    }
  }
  if (fact.type === 'repeat.node.resolved') {
    const value = fact.resolution
    // An inactive outside block placeholder may have no occurrence at all.
    const block = topology.repeat?.blocks.find((item) => item.nodeIds.includes(value.ref.nodeId))
    if (!topology.nodes.some((node) => node.workflowNodeId === value.ref.nodeId)) fail()
    if (!(value.outside && value.ref.occurrence === null && !value.value.execution)) ref(value.ref.nodeId, value.ref.occurrence)
    if (value.outside && value.ref.occurrence && (!block || block.exitNodeId !== value.ref.nodeId)) fail()
    for (const id of [...value.value.selectedRelationshipIds, ...value.value.unselectedRelationshipIds, ...value.deferredRelationshipIds]) {
      const edge = topology.relationships.find((item) => item.relationshipId === id)
      if (!edge || edge.kind !== 'execution' || edge.source !== value.ref.nodeId) fail()
    }
  }
  if (fact.type === 'repeat.input.bound' && fact.binding.relationshipId) {
    const { binding } = fact
    const edge = topology.relationships.find((item) => item.relationshipId === binding.relationshipId)
    if (!edge || edge.kind !== 'execution' || edge.source !== binding.sender.workflowNodeId || edge.target !== binding.recipient.workflowNodeId) fail()
    if (binding.kind === 'predecessor' && binding.sender.occurrence && binding.recipient.occurrence
      && binding.sender.occurrence.blockId === binding.recipient.occurrence.blockId
      && binding.sender.occurrence.occurrenceId !== binding.recipient.occurrence.occurrenceId) fail()
  }
}
export function repeatGraphTopologyV3(versionValue: unknown): RepeatGraphTopologyV3 {
  const version = WorkflowVersionV3Schema.parse(versionValue)
  return RepeatGraphTopologyV3Schema.parse({
    entryNodeId: version.entryNodeId, ...(version.definition.repeat ? { repeat: version.definition.repeat } : {}),
    nodes: version.definition.nodes.map((node) => node.kind==='job'?{kind:'job',workflowNodeId:node.id,jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,...(node.choice?{choice:node.choice}:{})}:({ workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId], productRole: 'unknown',
      ...(node.choice ? { choice: node.choice } : {}) })),
    relationships: version.definition.edges.map((edge) => ({ relationshipId: edge.id, kind: edge.kind, source: edge.source, target: edge.target })),
  })
}
export function validateRepeatGraphFactsV3(version: WorkflowVersionV3, scope: RepeatGraphScopeV3,
  facts: readonly (RepeatGraphFactV3 | GraphFact)[]): void {
  const topology = repeatGraphTopologyV3(version)
  if (version.workspaceId !== scope.workspaceId || version.workflowId !== scope.workflowId || version.id !== scope.workflowVersionId) {
    throw new Error('REPEAT_GRAPH_PIN_CONFLICT')
  }
  for (const fact of facts) {
    assertRepeatGraphFactScope(scope, fact); assertTopologyFact(topology, fact)
    if (fact.type === 'repeat.decision' && fact.decision.reason === 'early_exit') {
      const exit = version.definition.nodes.find((node) => node.id === fact.decision.exitExecution.workflowNodeId)
      const target = exit?.choice?.outcomes.find((item) => item.outcome === fact.decision.outcome)?.target
      if (!target || canonicalGraphJson(target) !== canonicalGraphJson(fact.decision.target)) throw new Error('REPEAT_GRAPH_PIN_CONFLICT')
    }
  }
}
export function validateRepeatGraphSnapshotV3(versionValue: unknown, snapshotValue: unknown): RepeatGraphSnapshotV3 {
  const version = WorkflowVersionV3Schema.parse(versionValue), snapshot = RepeatGraphSnapshotV3Schema.parse(snapshotValue)
  if (canonicalGraphJson(snapshot.topology) !== canonicalGraphJson(repeatGraphTopologyV3(version))) throw new Error('REPEAT_GRAPH_PIN_CONFLICT')
  validateRepeatGraphFactsV3(version, snapshot.scope, repeatGraphStateFacts(snapshot.state))
  return snapshot
}

/** COMPLETE page reduction is atomic. A gap, scope drift, changed immutable row,
 * backwards terminal or unknown schema leaves the caller's prior state intact.
 * The caller must fetch a new snapshot on reset; it cannot skip a reset cursor. */
export function reduceRepeatGraphPageV3(snapshotValue: unknown, pageValue: unknown): RepeatGraphSnapshotV3 {
  const snapshot = RepeatGraphSnapshotV3Schema.parse(snapshotValue), page = RepeatGraphPageV3Schema.parse(pageValue)
  if (!sameCanonicalGraphScope(snapshot.scope, page.scope) || page.baseSequence !== snapshot.asOfSequence) {
    throw new Error('REPEAT_GRAPH_REPLAY_GAP_OR_SCOPE')
  }
  const state = structuredClone(snapshot.state)
  const put = <T>(items: T[], value: T, key: (item: T) => string, mutable = false) => {
    const at = items.findIndex((item) => key(item) === key(value))
    if (at < 0) items.push(value)
    else if (!mutable && canonicalGraphJson(items[at]) !== canonicalGraphJson(value)) throw new Error('REPEAT_GRAPH_IMMUTABLE_CONFLICT')
    else items[at] = value
  }
  for (const batch of page.batches) {
    for (const { fact } of batch.events) {
      switch (fact.type) {
        case 'repeat.run.state':
          if ((state.run.stopRequested && !fact.state.stopRequested)
            || state.run.executionState === 'completed' && (fact.state.executionState !== 'completed' || state.run.outcome !== fact.state.outcome)) {
            throw new Error('REPEAT_GRAPH_TERMINAL_CONFLICT')
          }
          state.run = fact.state; break
        case 'repeat.occurrence': put(state.occurrences, fact.occurrence, (item) => item.identity.occurrenceId); break
        case 'repeat.decision': put(state.decisions, fact.decision, (item) => item.decisionId); break
        case 'repeat.node.resolved': put(state.resolutions, fact.resolution, repeatGraphResolutionKey); break
        case 'repeat.result.accepted': put(state.results, fact.result, (item) => item.execution.executionId); break
        case 'repeat.input.bound': put(state.bindings, fact.binding, (item) => item.bindingId); break
        case 'repeat.execution': {
          const previous = state.executions.find((item) => item.identity.executionId === fact.execution.identity.executionId)
          if (previous && (canonicalGraphJson(previous.identity) !== canonicalGraphJson(fact.execution.identity)
            || previous.inputDigest !== fact.execution.inputDigest || previous.previousExecutionId !== fact.execution.previousExecutionId
            || previous.state === 'completed' && canonicalGraphJson(previous) !== canonicalGraphJson(fact.execution))) {
            throw new Error('REPEAT_GRAPH_EXECUTION_CONFLICT')
          }
          put(state.executions, fact.execution, (item) => item.identity.executionId, true); break
        }
        case 'workflow.presentation': {
          const delta = fact.delta
          if (delta.run) applyPublicProjectionFact(state, { type: 'run.state', state: delta.run })
          // Whole node rows also remove an older attempt's digest/resolution.
          for (const row of delta.nodes) put(state.nodes, row, (item) => item.state.workflowNodeId, true)
          for (const row of delta.inputBindings) put(state.inputBindings, row, (item) => item.bindingId)
          for (const row of delta.interactions) put(state.interactions, row, (item) => item.interactionId, true)
          for (const row of delta.reviews) put(state.reviews, row, (item) => item.reviewJobId, true)
          state.inputBindings = state.inputBindings.filter((item) => !delta.retiredInputBindingIds.includes(item.bindingId))
          state.interactions = state.interactions.filter((item) => !delta.retiredInteractionIds.includes(item.interactionId))
          state.reviews = state.reviews.filter((item) => !delta.retiredReviewIds.includes(item.reviewJobId))
          break
        }
        default: applyPublicProjectionFact(state, fact)
      }
    }
    // A source may emit a decision and its successor together. Never validate an
    // intermediate event as a complete cut, but every committed batch must be one.
    RepeatGraphSnapshotV3Schema.parse({ ...snapshot, asOfSequence: batch.sequence, state })
  }
  return RepeatGraphSnapshotV3Schema.parse({ ...snapshot, asOfSequence: page.throughSequence,
    retentionFloor: page.retentionFloor, state: sortRepeatGraphState(state) })
}

/** Explicit conversion; never parse a bare v2 identity as occurrence-qualified. */
export function qualifyRepeatGraphExecution(identity: GraphExecutionIdentity, occurrence: RepeatOccurrenceIdentityV1 | null): RepeatGraphExecutionIdentityV3 {
  return RepeatGraphExecutionIdentityV3Schema.parse({ ...identity, occurrence })
}

/** Current aliases all refer to the same literal-3 schemas. No compatibility union. */
export const CanonicalRunGraphSnapshotSchema = RepeatGraphSnapshotV3Schema
export const CanonicalRunGraphEventsResponseSchema = RepeatGraphEventsResponseV3Schema
export const CanonicalRunGraphReadRequestSchema = RepeatGraphReadRequestV3Schema
export const CanonicalRunGraphEventsRequestSchema = RepeatGraphEventsRequestV3Schema
export const CanonicalRunGraphHttpSnapshotQuerySchema = RepeatGraphHttpSnapshotQueryV3Schema
export const CanonicalRunGraphHttpEventsQuerySchema = RepeatGraphHttpEventsQueryV3Schema
export const CanonicalRunGraphCurrentSchema = RepeatGraphCurrentV3Schema
export type RepeatGraphCurrentV3 = z.infer<typeof RepeatGraphCurrentV3Schema>
export const CANONICAL_RUN_GRAPH_ROUTES = Object.freeze({ ...RUN_GRAPH_ROUTES,
  readCapabilities: '/api/capabilities/run-graph/reads/v1',
  current: '/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/current',
})
export const CANONICAL_RUN_GRAPH_MCP_TOOLS = Object.freeze({ ...RUN_GRAPH_MCP_TOOLS,
  readCapabilities: 'run_graph_read_capabilities_v1', current: 'run_graph_current_v1',
})
export const CanonicalRunGraphReadCapabilitiesSchema = z.object({
  capabilityVersion: z.literal(1), protocolVersions: z.array(z.literal(1)).max(1),
  readSemanticsVersions: z.array(z.literal(3)).max(1), transport: z.literal('http_poll'), activePollMs: z.literal(1000),
  semantics3: z.object({ persistedReads: z.boolean(), payload: z.literal('metadata_only'),
    runtimeAdmission: z.boolean(), meaningfulEdit: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  if ((value.protocolVersions.length > 0) !== (value.readSemanticsVersions.length > 0)
    || value.semantics3.persistedReads !== value.readSemanticsVersions.includes(3)) {
    context.addIssue({ code: 'custom', message: 'GRAPH_READ_CAPABILITIES_CONFLICT' })
  }
})
export type CanonicalRunGraphReadCapabilities = z.infer<typeof CanonicalRunGraphReadCapabilitiesSchema>

function publicProjectionFacts(state: z.infer<typeof PublicGraphProjectionSchema>): GraphFact[] {
  return [{ type: 'run.state', state: state.run }, ...state.nodes.flatMap((node): GraphFact[] => [
    { type: 'node.state', state: node.state }, { type: 'node.activity', activity: node.activity },
    { type: 'node.attention', attention: node.attention },
    ...(node.resolution ? [{ type: 'node.resolved' as const, resolution: node.resolution }] : []),
    ...(node.acceptedResultDigest && node.state.execution ? [{ type: 'result.accepted' as const,
      execution: node.state.execution, resultDigest: node.acceptedResultDigest }] : []),
  ]), ...state.inputBindings.map((binding): GraphFact => ({ type: 'input.bound', binding })),
  ...state.interactions.map((interaction): GraphFact => ({ type: 'interaction.state', interaction })),
  ...state.reviews.map((review): GraphFact => ({ type: 'review.state', review }))]
}

/** Exact public projection changes, applied only as part of the same complete G1 batch. */
function applyPublicProjectionFact(state: RepeatGraphStateV3, fact: GraphFact): void {
  const same = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
  const replace = <T>(items: T[], value: T, key: (item: T) => string) => {
    const at = items.findIndex((item) => key(item) === key(value))
    if (at < 0) items.push(value); else items[at] = value
  }
  const node = (id: string) => {
    const value = state.nodes.find((item) => item.state.workflowNodeId === id)
    if (!value) throw new Error('GRAPH_UNKNOWN_NODE')
    return value
  }
  switch (fact.type) {
    case 'run.state':
      if (state.run.stopRequested && !fact.state.stopRequested || state.run.executionState === 'completed'
        && (fact.state.executionState !== 'completed' || fact.state.outcome !== state.run.outcome)) throw new Error('GRAPH_TERMINAL_CONFLICT')
      state.run = fact.state; return
    case 'node.state': {
      const current = node(fact.state.workflowNodeId)
      if (current.state.execution?.executionId !== fact.state.execution?.executionId) {
        delete current.resolution; delete current.acceptedResultDigest
      }
      current.state = fact.state; return
    }
    case 'node.activity': node(fact.activity.workflowNodeId).activity = fact.activity; return
    case 'node.attention': node(fact.attention.workflowNodeId).attention = fact.attention; return
    case 'node.resolved': {
      const current = node(fact.resolution.workflowNodeId)
      if (current.state.execution && fact.resolution.execution?.executionId !== current.state.execution.executionId) return
      current.resolution = fact.resolution
      if (fact.resolution.acceptedResultDigest) current.acceptedResultDigest = fact.resolution.acceptedResultDigest
      return
    }
    case 'result.accepted': {
      const current = node(fact.execution.workflowNodeId)
      if (current.state.execution?.executionId !== fact.execution.executionId) return
      if (current.acceptedResultDigest && current.acceptedResultDigest !== fact.resultDigest) throw new Error('GRAPH_IMMUTABLE_RESULT')
      current.acceptedResultDigest = fact.resultDigest; return
    }
    case 'input.bound': {
      const prior = state.inputBindings.find((item) => item.bindingId === fact.binding.bindingId)
      if (prior && !same(prior, fact.binding)) throw new Error('GRAPH_IMMUTABLE_INPUT')
      replace(state.inputBindings, fact.binding, (item) => item.bindingId); return
    }
    case 'interaction.state': {
      const prior = state.interactions.find((item) => item.interactionId === fact.interaction.interactionId)
      if (prior && (BigInt(prior.revision) > BigInt(fact.interaction.revision)
        || prior.revision === fact.interaction.revision && !same(prior, fact.interaction))) throw new Error('GRAPH_REVISION_CONFLICT')
      replace(state.interactions, fact.interaction, (item) => item.interactionId); return
    }
    case 'review.state': {
      const prior = state.reviews.find((item) => item.reviewJobId === fact.review.reviewJobId)
      if (prior && (BigInt(prior.revision) > BigInt(fact.review.revision)
        || prior.revision === fact.review.revision && !same(prior, fact.review))) throw new Error('GRAPH_REVISION_CONFLICT')
      replace(state.reviews, fact.review, (item) => item.reviewJobId); return
    }
    case 'worker.resumed': {
      const current = state.interactions.find((item) => item.interactionId === fact.interactionId)
      if (!current || current.deliveryState !== 'delivered' || !same(current.requester, fact.requester)) throw new Error('GRAPH_ACKNOWLEDGEMENT_CONFLICT')
      if (current.resumeAcknowledgementId && current.resumeAcknowledgementId !== fact.acknowledgementId) throw new Error('GRAPH_ACKNOWLEDGEMENT_CONFLICT')
      current.resumeState = 'acknowledged'; current.resumeAcknowledgementId = fact.acknowledgementId; return
    }
    case 'exchange.retired': {
      if (fact.exchangeKind === 'interaction') {
        const current = state.interactions.find((item) => item.interactionId === fact.exchangeId)
        if (current && (current.revision !== fact.finalRevision || !['delivered', 'canceled'].includes(current.status))) throw new Error('GRAPH_RETIREMENT_CONFLICT')
        state.interactions = state.interactions.filter((item) => item.interactionId !== fact.exchangeId)
      } else {
        const current = state.reviews.find((item) => item.reviewJobId === fact.exchangeId)
        if (current && (current.revision !== fact.finalRevision || !['completed', 'failed'].includes(current.state))) throw new Error('GRAPH_RETIREMENT_CONFLICT')
        state.reviews = state.reviews.filter((item) => item.reviewJobId !== fact.exchangeId)
      }
    }
  }
}
