import { z } from 'zod'
import { RepeatGraphSnapshotV3Schema, RepeatGraphPageV3Schema, RepeatGraphResetV3Schema } from './repeatGraphMetadata.js'
import { GraphSequenceSchema, RUN_GRAPH_LIMITS } from './graphPrimitives.js'
import { canonicalGraphJson, graphJsonBytes } from './json.js'
import {
  RepeatOccurrenceIdentityV1Schema, RepeatOccurrenceV1Schema,
  RepeatDecisionMetadataV1Schema, RepeatWorkflowVersionV1Schema,
} from './repeat.js'

/** Content-free read contracts for the publication owner to wire. These do not
 * extend the existing v1/v2 graph event/reducer union or enable a live feed.
 * A decision is evidence of a decision, NEVER of activation or native receipt. */
export const RepeatMetadataScopeV1Schema = RepeatOccurrenceIdentityV1Schema.shape.scope
const Item = z.object({
  occurrence: RepeatOccurrenceV1Schema, decision: RepeatDecisionMetadataV1Schema.nullable(),
}).strict().superRefine((item, context) => {
  if (item.decision && canonicalGraphJson(item.occurrence) !== canonicalGraphJson(item.decision.occurrence)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_METADATA_OCCURRENCE_MISMATCH' })
  }
})
const projectionShape = {
  contractVersion: z.literal(1), scope: RepeatMetadataScopeV1Schema,
  throughSequence: GraphSequenceSchema, headSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema,
  // Complete metadata, not a paginated result-detail window. Overflow requires
  // an explicit reset/unavailable response, never truncation labelled complete.
  complete: z.literal(true), items: z.array(Item).max(2000),
}
const Projection = z.object(projectionShape).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (![value.throughSequence, value.headSequence, value.retentionFloor].every((sequence) => GraphSequenceSchema.safeParse(sequence).success)) return
  if (value.throughSequence !== value.headSequence
    || BigInt(value.retentionFloor) > BigInt(value.throughSequence)) fail('REPEAT_METADATA_HEAD_MISMATCH')
  const ids = new Set<string>(), ordinals = new Set<string>(), bindings = new Set<string>()
  const decisions = new Set<string>(), executions = new Set<string>()
  for (const item of value.items) {
    const { identity, input } = item.occurrence
    const ordinal = `${identity.blockId}/${identity.occurrenceIndex}`
    if (canonicalGraphJson(identity.scope) !== canonicalGraphJson(value.scope)
      || ids.has(identity.occurrenceId) || ordinals.has(ordinal) || bindings.has(input.bindingId)) fail('REPEAT_METADATA_IDENTITY_CONFLICT')
    ids.add(identity.occurrenceId); ordinals.add(ordinal); bindings.add(input.bindingId)
    if (item.decision) {
      if (decisions.has(item.decision.decisionId) || executions.has(item.decision.exitExecution.executionId)) fail('REPEAT_METADATA_DECISION_CONFLICT')
      decisions.add(item.decision.decisionId); executions.add(item.decision.exitExecution.executionId)
    }
  }
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.snapshotBytes) fail('REPEAT_METADATA_SNAPSHOT_TOO_LARGE')
})
export const RepeatMetadataCurrentV1Schema = Projection.safeExtend({ kind: z.literal('current') })
export const RepeatMetadataSnapshotV1Schema = Projection.safeExtend({ kind: z.literal('snapshot') })
type RepeatMetadataSnapshotV1 = z.infer<typeof RepeatMetadataSnapshotV1Schema>

export const RepeatMetadataEventV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('repeat.occurrence'), occurrence: RepeatOccurrenceV1Schema }).strict(),
  z.object({ type: z.literal('repeat.decision'), decision: RepeatDecisionMetadataV1Schema }).strict(),
]).superRefine((value, context) => {
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.eventBytes) context.addIssue({ code: 'custom', message: 'REPEAT_METADATA_EVENT_TOO_LARGE' })
})
const RepeatMetadataBatchV1Schema = z.object({
  scope: RepeatMetadataScopeV1Schema, previousSequence: GraphSequenceSchema, sequence: GraphSequenceSchema,
  // This is a projection of a COMPLETE existing publication batch. Empty means
  // that batch changed only non-repeat facts; it does not skip a journal position.
  events: z.array(RepeatMetadataEventV1Schema).max(RUN_GRAPH_LIMITS.batchEvents),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (![value.sequence, value.previousSequence].every((sequence) => GraphSequenceSchema.safeParse(sequence).success)) return
  if (BigInt(value.sequence) !== BigInt(value.previousSequence) + 1n) fail('REPEAT_METADATA_BATCH_GAP')
  const sources = new Set<string>()
  for (const event of value.events) {
    const occurrence = event.type === 'repeat.occurrence' ? event.occurrence : event.decision.occurrence
    const id = event.type === 'repeat.occurrence' ? occurrence.identity.occurrenceId : event.decision.decisionId
    const source = `${event.type}/${id}`
    if (canonicalGraphJson(occurrence.identity.scope) !== canonicalGraphJson(value.scope) || sources.has(source)) fail('REPEAT_METADATA_SOURCE_CONFLICT')
    sources.add(source)
  }
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.batchBytes) fail('REPEAT_METADATA_BATCH_TOO_LARGE')
})
export const RepeatMetadataDeltaV1Schema = z.object({
  kind: z.literal('delta'), contractVersion: z.literal(1), scope: RepeatMetadataScopeV1Schema,
  baseSequence: GraphSequenceSchema, throughSequence: GraphSequenceSchema,
  headSequence: GraphSequenceSchema, retentionFloor: GraphSequenceSchema, hasMore: z.boolean(),
  batches: z.array(RepeatMetadataBatchV1Schema).max(RUN_GRAPH_LIMITS.pageBatches),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (![value.baseSequence, value.throughSequence, value.headSequence, value.retentionFloor].every((sequence) => GraphSequenceSchema.safeParse(sequence).success)) return
  if (BigInt(value.baseSequence) < BigInt(value.retentionFloor)
    || BigInt(value.baseSequence) > BigInt(value.throughSequence)
    || BigInt(value.throughSequence) > BigInt(value.headSequence)
    || value.hasMore !== (BigInt(value.throughSequence) < BigInt(value.headSequence))) fail('REPEAT_METADATA_CURSOR_INVALID')
  let previous = value.baseSequence
  const sources = new Set<string>()
  for (const batch of value.batches) {
    if (batch.previousSequence !== previous || canonicalGraphJson(batch.scope) !== canonicalGraphJson(value.scope)) fail('REPEAT_METADATA_DELTA_GAP_OR_SCOPE')
    previous = batch.sequence
    for (const event of batch.events) {
      const id = event.type === 'repeat.occurrence' ? event.occurrence.identity.occurrenceId : event.decision.decisionId
      const source = `${event.type}/${id}`
      if (sources.has(source)) fail('REPEAT_METADATA_DUPLICATE_IMMUTABLE_SOURCE')
      sources.add(source)
    }
  }
  if (previous !== value.throughSequence || (value.hasMore && value.batches.length === 0)) fail('REPEAT_METADATA_INCOMPLETE_PAGE')
  if (graphJsonBytes(value) > RUN_GRAPH_LIMITS.pageBytes) fail('REPEAT_METADATA_PAGE_TOO_LARGE')
})
type RepeatMetadataDeltaV1 = z.infer<typeof RepeatMetadataDeltaV1Schema>
const RepeatMetadataResetV1Schema = z.object({
  kind: z.literal('reset'), contractVersion: z.literal(1), scope: RepeatMetadataScopeV1Schema,
  reason: z.enum(['retention', 'snapshot_required', 'capacity']),
  retentionFloor: GraphSequenceSchema, headSequence: GraphSequenceSchema,
}).strict().superRefine((value, context) => {
  if (![value.retentionFloor, value.headSequence].every((sequence) => GraphSequenceSchema.safeParse(sequence).success)) return
  if (BigInt(value.retentionFloor) > BigInt(value.headSequence)) context.addIssue({ code: 'custom', message: 'REPEAT_METADATA_CURSOR_INVALID' })
})
export const RepeatMetadataReadV1Schema = z.union([
  RepeatMetadataCurrentV1Schema, RepeatMetadataSnapshotV1Schema, RepeatMetadataDeltaV1Schema, RepeatMetadataResetV1Schema,
])

/** Check complete metadata against the exact loaded immutable version. This
 * cannot prove an accepted result digest's backing row or native closure.
 * No private result is accepted, fetched, manufactured, or returned here. */
export function validateRepeatMetadataSnapshotV1(versionValue: unknown, snapshotValue: unknown): RepeatMetadataSnapshotV1 {
  const version = RepeatWorkflowVersionV1Schema.parse(versionValue)
  const snapshot = RepeatMetadataSnapshotV1Schema.parse(snapshotValue)
  const fail = (): never => { throw new Error('REPEAT_METADATA_VERSION_OR_LINEAGE_MISMATCH') }
  if (snapshot.scope.workspaceId !== version.workspaceId || snapshot.scope.workflowId !== version.workflowId
    || snapshot.scope.workflowVersionId !== version.id) return fail()
  const byId = new Map(snapshot.items.map((item) => [item.occurrence.identity.occurrenceId, item]))
  for (const { occurrence, decision } of snapshot.items) {
    const { identity, input } = occurrence
    const block = version.definition.repeat?.blocks.find((item) => item.id === identity.blockId)
    if (!block || identity.occurrenceIndex > block.maxOccurrences) return fail()
    if (input.previous) {
      const previous = byId.get(input.previous.occurrenceId)
      if (!previous?.decision || previous.occurrence.identity.blockId !== identity.blockId
        || previous.occurrence.identity.occurrenceIndex !== input.previous.occurrenceIndex
        || previous.decision.decisionId !== input.previous.decisionId
        || previous.decision.acceptedResultDigest !== input.previous.acceptedResultDigest
        || previous.decision.reason !== 'repeat') return fail()
    }
    if (!decision) continue
    const exit = version.definition.nodes.find((node) => node.id === block.exitNodeId)!
    if (decision.exitExecution.workflowNodeId !== exit.id || (decision.exitExecution.kind==='job'
      ? exit.kind!=='job'||decision.exitExecution.jobDefinitionId!==exit.jobDefinitionId||decision.exitExecution.jobDefinitionVersionId!==exit.jobDefinitionVersionId
      : exit.kind==='job'||decision.exitExecution.agentId!==exit.agentId||decision.exitExecution.agentConfigurationVersionId!==version.agentConfigurationVersionIds[exit.agentId])
      || ![block.repeatOutcome, block.earlyExitOutcome].includes(decision.outcome)) return fail()
    const early = decision.outcome === block.earlyExitOutcome
    const reason = early ? 'early_exit' : identity.occurrenceIndex === block.maxOccurrences ? 'limit_exit' : 'repeat'
    const target = early ? exit.choice!.outcomes.find((item) => item.outcome === block.earlyExitOutcome)!.target
      : reason === 'limit_exit' ? block.limitExit
        : { kind: 'next_occurrence', entryNodeId: block.entryNodeId, occurrenceIndex: identity.occurrenceIndex + 1 }
    if (decision.reason !== reason || canonicalGraphJson(decision.target) !== canonicalGraphJson(target)) return fail()
  }
  return snapshot
}

type RepeatMetadataCurrentV1 = z.infer<typeof RepeatMetadataCurrentV1Schema>
type RepeatMetadataResetV1 = z.infer<typeof RepeatMetadataResetV1Schema>

// Explicit v3 arm. Do not widen or retag the legacy protocol schemas.
export * from './repeatGraphMetadata.js'

/** Both public occurrence-only views derive from ONE verified canonical cut.
 * The API supplies readRepeatGraphSnapshot's result; this pure conversion does
 * not create a receipt, read a second head or promote a partial page to current. */
export function repeatMetadataSnapshotFromCanonicalV3(value: unknown): RepeatMetadataSnapshotV1 {
  const snapshot = RepeatGraphSnapshotV3Schema.parse(value)
  const decisions = new Map(snapshot.state.decisions.map((decision) => [decision.occurrence.identity.occurrenceId, decision]))
  return RepeatMetadataSnapshotV1Schema.parse({ kind: 'snapshot', contractVersion: 1, scope: snapshot.scope,
    throughSequence: snapshot.asOfSequence, headSequence: snapshot.asOfSequence, retentionFloor: snapshot.retentionFloor, complete: true,
    items: snapshot.state.occurrences.map((occurrence) => ({ occurrence, decision: decisions.get(occurrence.identity.occurrenceId) ?? null })) })
}
export function repeatMetadataCurrentFromCanonicalV3(value: unknown): RepeatMetadataCurrentV1 {
  return RepeatMetadataCurrentV1Schema.parse({ ...repeatMetadataSnapshotFromCanonicalV3(value), kind: 'current' })
}
export function repeatMetadataDeltaFromCanonicalV3(value: unknown): RepeatMetadataDeltaV1 {
  const page = RepeatGraphPageV3Schema.parse(value)
  return RepeatMetadataDeltaV1Schema.parse({ kind: 'delta', contractVersion: 1, scope: page.scope,
    baseSequence: page.baseSequence, throughSequence: page.throughSequence, headSequence: page.headSequence,
    retentionFloor: page.retentionFloor, hasMore: page.hasMore,
    // An empty projection STILL carries its complete publication position.
    batches: page.batches.map((batch) => ({ scope: batch.scope, previousSequence: batch.previousSequence, sequence: batch.sequence,
      events: batch.events.flatMap(({ fact }) => fact.type === 'repeat.occurrence' || fact.type === 'repeat.decision' ? [fact] : []) })) })
}
export function repeatMetadataResetFromCanonicalV3(value: unknown): RepeatMetadataResetV1 {
  const reset = RepeatGraphResetV3Schema.parse(value)
  return RepeatMetadataResetV1Schema.parse({ kind: 'reset', contractVersion: 1, scope: reset.scope,
    retentionFloor: reset.retentionFloor, headSequence: reset.headSequence,
    reason: reset.reason === 'history_expired' ? 'retention'
      : ['atomic_change_too_large', 'catchup_limit'].includes(reset.reason) ? 'capacity' : 'snapshot_required' })
}
