import { describe, expect, it } from 'vitest'
import { makeSharedV3Fixture } from './eng04-shared-fixture.js'
import {
  RepeatMetadataSnapshotV1Schema, RepeatMetadataCurrentV1Schema, RepeatMetadataDeltaV1Schema,
  RepeatMetadataEventV1Schema, RepeatMetadataReadV1Schema, validateRepeatMetadataSnapshotV1,
} from './repeatMetadata.js'
import { RepeatOccurrenceV1Schema, RepeatDecisionMetadataV1Schema } from './repeat.js'
import { RunGraphScopeSchema } from './graphPrimitives.js'

function metadata() {
  const f = makeSharedV3Fixture('eng04-shared-metadata'), digest = `sha256:${'b'.repeat(64)}`
  const first = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
    identity: { scope: f.scope, blockId: 'repair', occurrenceId: 'occurrence-1', occurrenceIndex: 1 },
    input: { bindingId: 'input-1', inputDigest: digest, previous: null } })
  const decision = RepeatDecisionMetadataV1Schema.parse({ contractVersion: 1, decisionId: 'decision-1', occurrence: first,
    exitExecution: { ...f.identities[1]!, occurrence: first.identity }, acceptedResultDigest: digest,
    outcome: 'issues', reason: 'repeat', target: { kind: 'next_occurrence', entryNodeId: f.version.entryNodeId, occurrenceIndex: 2 },
    decidedAt: f.createdAt })
  const second = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
    identity: { ...first.identity, occurrenceId: 'occurrence-2', occurrenceIndex: 2 },
    input: { bindingId: 'input-2', inputDigest: digest, previous: { occurrenceId: 'occurrence-1', occurrenceIndex: 1,
      decisionId: 'decision-1', acceptedResultDigest: digest } } })
  const snapshot = RepeatMetadataSnapshotV1Schema.parse({ kind: 'snapshot', contractVersion: 1, scope: f.scope,
    throughSequence: '2', headSequence: '2', retentionFloor: '0', complete: true,
    items: [{ occurrence: first, decision }, { occurrence: second, decision: null }] })
  return { f, first, second, decision, snapshot }
}

describe('ENG04 shared content-free occurrence/decision metadata', () => {
  it('gives current and snapshot the same complete committed head and exact records', () => {
    const { f, snapshot } = metadata()
    expect(validateRepeatMetadataSnapshotV1(f.version, snapshot)).toEqual(snapshot)
    const current = RepeatMetadataCurrentV1Schema.parse({ ...snapshot, kind: 'current' })
    expect({ ...current, kind: 'snapshot' }).toEqual(snapshot)
    expect(RunGraphScopeSchema.safeParse(f.scope).success).toBe(true)
  })
  it('accepts contiguous complete-batch deltas, including batches without repeat facts', () => {
    const { f, first, second, decision, snapshot } = metadata()
    const delta = RepeatMetadataDeltaV1Schema.parse({ kind: 'delta', contractVersion: 1, scope: f.scope,
      baseSequence: '0', throughSequence: '3', headSequence: '3', retentionFloor: '0', hasMore: false,
      batches: [
        { scope: f.scope, previousSequence: '0', sequence: '1', events: [{ type: 'repeat.occurrence', occurrence: first }, { type: 'repeat.decision', decision }] },
        { scope: f.scope, previousSequence: '1', sequence: '2', events: [] },
        { scope: f.scope, previousSequence: '2', sequence: '3', events: [{ type: 'repeat.occurrence', occurrence: second }] },
      ] })
    // Synthetic projection equality, not a claim about a database/public reader.
    const occurrences = delta.batches.flatMap((batch) => batch.events).filter((event) => event.type === 'repeat.occurrence')
    expect(occurrences.map((event) => event.occurrence)).toEqual(snapshot.items.map((item) => item.occurrence))
    expect(delta.batches.flatMap((batch) => batch.events).find((event) => event.type === 'repeat.decision')).toEqual({ type: 'repeat.decision', decision })
  })
  it('rejects gaps, mixed scope, duplicated immutable source and incomplete pages', () => {
    const { f, first } = metadata()
    const batch = { scope: f.scope, previousSequence: '0', sequence: '1', events: [{ type: 'repeat.occurrence', occurrence: first }] }
    const delta = { kind: 'delta', contractVersion: 1, scope: f.scope, baseSequence: '0', throughSequence: '1',
      headSequence: '1', retentionFloor: '0', hasMore: false, batches: [batch] }
    for (const value of [
      { ...delta, baseSequence: '1' }, { ...delta, throughSequence: '0' }, { ...delta, headSequence: '0' },
      { ...delta, retentionFloor: '1' }, { ...delta, hasMore: true }, { ...delta, batches: [] },
      { ...delta, batches: [{ ...batch, sequence: '2' }] },
      { ...delta, batches: [{ ...batch, scope: { ...f.scope, runId: 'other' } }] },
      { ...delta, batches: [{ ...batch, events: [...batch.events, ...batch.events] }] },
    ]) expect(RepeatMetadataDeltaV1Schema.safeParse(value).success).toBe(false)
  })
  it.each(['-1', '00', '1.5', 'not-a-sequence', '9223372036854775808'])('returns validation failure, not an exception, for cursor %s', (sequence) => {
    const { snapshot } = metadata()
    expect(RepeatMetadataSnapshotV1Schema.safeParse({ ...snapshot, throughSequence: sequence }).success).toBe(false)
  })
  it('requires explicit reset instead of a stale cursor or truncated snapshot', () => {
    const { f, snapshot } = metadata()
    expect(RepeatMetadataReadV1Schema.safeParse({ kind: 'reset', contractVersion: 1, scope: f.scope,
      reason: 'retention', retentionFloor: '10', headSequence: '12' }).success).toBe(true)
    expect(RepeatMetadataSnapshotV1Schema.safeParse({ ...snapshot, complete: false }).success).toBe(false)
    expect(RepeatMetadataSnapshotV1Schema.safeParse({ ...snapshot, headSequence: '3' }).success).toBe(false)
    expect(RepeatMetadataSnapshotV1Schema.safeParse({ ...snapshot, items: Array(2001).fill(snapshot.items[0]) }).success).toBe(false)
  })
  it('rejects private result, prompt, input body, native session, path and credential fields at every boundary', () => {
    const { first, decision, snapshot } = metadata()
    for (const field of ['resultData', 'latestDeliverable', 'remainingFindings', 'request', 'nativeSessionId', 'rootPath', 'credential']) {
      expect(RepeatMetadataEventV1Schema.safeParse({ type: 'repeat.decision', decision: { ...decision, [field]: 'PRIVATE' } }).success).toBe(false)
      expect(RepeatMetadataSnapshotV1Schema.safeParse({ ...snapshot, [field]: 'PRIVATE' }).success).toBe(false)
    }
    expect(RepeatMetadataEventV1Schema.safeParse({ type: 'repeat.occurrence', occurrence: {
      ...first, input: { ...first.input, data: 'PRIVATE' },
    } }).success).toBe(false)
    expect(RepeatMetadataEventV1Schema.safeParse({ type: 'worker.resumed', decision }).success).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
  })
  it('rejects version/cap/exit/configuration and predecessor decision substitutions', () => {
    const { f, second, snapshot, decision } = metadata()
    for (const value of [
      { ...snapshot, scope: { ...snapshot.scope, workflowVersionId: 'other' } },
      { ...snapshot, items: [snapshot.items[1]] },
      { ...snapshot, items: [snapshot.items[0], { occurrence: { ...second, input: { ...second.input,
        previous: { ...second.input.previous!, decisionId: 'other' } } }, decision: null }] },
      { ...snapshot, items: [{ occurrence: decision.occurrence, decision: { ...decision,
        exitExecution: { ...decision.exitExecution, agentConfigurationVersionId: 'other' } } }] },
      { ...snapshot, items: [{ occurrence: decision.occurrence, decision: { ...decision, reason: 'limit_exit', target: { kind: 'branch_end' } } }] },
    ]) expect(() => validateRepeatMetadataSnapshotV1(f.version, value)).toThrow()
    const capped = { ...f.version, definition: { ...f.version.definition, repeat: { contractVersion: 1,
      blocks: f.version.definition.repeat!.blocks.map((block) => ({ ...block, maxOccurrences: 1 })) } } }
    expect(() => validateRepeatMetadataSnapshotV1(capped, snapshot)).toThrow()
  })
  it('accepts explicit early and cap exits but never treats them as native activation', () => {
    const { f, first, decision, snapshot } = metadata()
    const early = { ...decision, reason: 'early_exit', outcome: 'pass', target: { kind: 'branch_end' } }
    expect(validateRepeatMetadataSnapshotV1(f.version, { ...snapshot, items: [{ occurrence: first, decision: early }] }).items).toHaveLength(1)
    const version = { ...f.version, definition: { ...f.version.definition, repeat: { contractVersion: 1,
      blocks: f.version.definition.repeat!.blocks.map((block) => ({ ...block, maxOccurrences: 1 })) } } }
    const limit = { ...decision, reason: 'limit_exit', target: { kind: 'branch_end' } }
    expect(validateRepeatMetadataSnapshotV1(version, { ...snapshot, items: [{ occurrence: first, decision: limit }] }).items[0]!.decision!.reason).toBe('limit_exit')
  })
})
