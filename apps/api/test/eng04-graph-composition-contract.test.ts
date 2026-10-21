import { describe, expect, it } from 'vitest'
import {
  makeCurrentWorkflowFixture, WorkflowVersionV3Schema, repeatGraphTopologyV3,
  RepeatGraphSnapshotV3Schema, RepeatGraphCurrentV3Schema, RepeatGraphFactV3Schema,
  RepeatGraphPageV3Schema, RepeatGraphBatchV3Schema, reduceRepeatGraphPageV3,
  CanonicalRunGraphReadRequestSchema, CanonicalRunGraphEventsRequestSchema,
  CanonicalRunGraphHttpSnapshotQuerySchema, CanonicalRunGraphHttpEventsQuerySchema,
  type RepeatGraphSnapshotV3, type RepeatGraphBatchV3,
} from '@foreman-code/contracts/wave25'
import { graphSourceDigest, repeatGraphBatchReceipt } from '../src/modules/run-graph/publication.js'

/** Pure actual shared-schema/reducer tests. Not PG, HTTP authentication, native
 * provider or browser evidence. No mock contract implementation is used. */
function fixture(): RepeatGraphSnapshotV3 {
  const f = makeCurrentWorkflowFixture('eng04-graph-contract')
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = WorkflowVersionV3Schema.parse({ ...f.version, executionSemanticsVersion: 3,
    definition: { ...f.version.definition, executionSemanticsVersion: 3,
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  return RepeatGraphSnapshotV3Schema.parse({ kind: 'snapshot', protocolVersion: 1,
    scope: { ...f.scope, executionSemanticsVersion: 3 }, asOfSequence: '1', retentionFloor: '0', historyCoverage: 'from_admission',
    topology: repeatGraphTopologyV3(version), state: { run: { executionState: 'queued', outcome: 'pending', stopRequested: false,
      cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
      nodes: [], inputBindings: [], interactions: [], reviews: [],
      occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [] },
  })
}
function batch(snapshot: RepeatGraphSnapshotV3, sequence: number, state = snapshot.state.run): RepeatGraphBatchV3 {
  const fact = { type: 'repeat.run.state' as const, state }
  return RepeatGraphBatchV3Schema.parse({ protocolVersion: 1, scope: snapshot.scope,
    batchId: `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`,
    previousSequence: String(sequence - 1), sequence: String(sequence), events: [{
      eventId: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
      evidence: { sourceKind: 'run', sourceId: snapshot.scope.runId, sourceRevision: String(sequence) },
      sourceDigest: graphSourceDigest({ sequence, state }), semanticDigest: graphSourceDigest([fact]), effect: null, fact,
    }],
  })
}
function page(snapshot: RepeatGraphSnapshotV3, batches: RepeatGraphBatchV3[]) {
  const through = batches.at(-1)?.sequence ?? snapshot.asOfSequence
  return { kind: 'page' as const, protocolVersion: 1 as const, scope: snapshot.scope, baseSequence: snapshot.asOfSequence,
    throughSequence: through, headSequence: through, retentionFloor: snapshot.retentionFloor, hasMore: false, batches }
}

describe('ENG04 graph composition / shared contracts', () => {
  it('accepts only current scope tags and rejects private extra fields', () => {
    const snapshot = fixture(), request = { protocolVersion: 1, scope: snapshot.scope }
    expect(CanonicalRunGraphReadRequestSchema.safeParse(request).success).toBe(true)
    for (const executionSemanticsVersion of [0, 1, 2, 4, 3.1, '3', null, undefined]) {
      expect(CanonicalRunGraphReadRequestSchema.safeParse({ ...request, scope: { ...request.scope, executionSemanticsVersion } }).success).toBe(false)
    }
    expect(CanonicalRunGraphReadRequestSchema.safeParse({ ...request, privatePayload: {} }).success).toBe(false)
  })
  it('accepts only literal HTTP semantics and canonical bounded decimal cursors', () => {
    const snapshot = fixture()
    for (const executionSemanticsVersion of ['3']) {
      expect(CanonicalRunGraphHttpSnapshotQuerySchema.safeParse({ workflowVersionId: snapshot.scope.workflowVersionId, executionSemanticsVersion }).success).toBe(true)
    }
    for (const executionSemanticsVersion of ['1', '2', '03', '3.0', '4', 3]) {
      expect(CanonicalRunGraphHttpSnapshotQuerySchema.safeParse({ workflowVersionId: snapshot.scope.workflowVersionId, executionSemanticsVersion }).success).toBe(false)
    }
    for (const afterSequence of ['01', '-1', '1e0', '9223372036854775808', 1]) {
      expect(CanonicalRunGraphEventsRequestSchema.safeParse({ protocolVersion: 1, scope: snapshot.scope, afterSequence }).success).toBe(false)
      expect(CanonicalRunGraphHttpEventsQuerySchema.safeParse({ workflowVersionId: snapshot.scope.workflowVersionId,
        executionSemanticsVersion: '3', afterSequence }).success).toBe(false)
    }
  })
  it('keeps current and snapshot wire tags explicit', () => {
    const snapshot = fixture(), current = { ...snapshot, kind: 'current' }
    expect(RepeatGraphCurrentV3Schema.parse(current)).toEqual(current)
    expect(RepeatGraphSnapshotV3Schema.safeParse(current).success).toBe(false)
  })
  it('reduces complete batches atomically and never labels an unfinished empty page complete', () => {
    const snapshot = fixture(), running = { ...snapshot.state.run, executionState: 'running' as const }
    const value = page(snapshot, [batch(snapshot, 2, running), batch(snapshot, 3, { ...running, executionState: 'waiting' })])
    expect(reduceRepeatGraphPageV3(snapshot, value)).toEqual({ ...snapshot, asOfSequence: '3',
      state: { ...snapshot.state, run: { ...running, executionState: 'waiting' } } })
    expect(snapshot.state.run.executionState).toBe('queued')
    expect(RepeatGraphPageV3Schema.safeParse({ ...page(snapshot, []), headSequence: '2' }).success).toBe(false)
    expect(RepeatGraphPageV3Schema.safeParse({ ...page(snapshot, []), headSequence: '2', hasMore: true }).success).toBe(false)
  })
  it('rejects a gap, reordered complete batches and scope drift without mutating the original cut', () => {
    const snapshot = fixture(), original = structuredClone(snapshot), two = batch(snapshot, 2), three = batch(snapshot, 3)
    for (const value of [page(snapshot, [three]), page(snapshot, [three, two]),
      { ...page(snapshot, [two]), scope: { ...snapshot.scope, runId: 'another-run' } }]) {
      expect(() => reduceRepeatGraphPageV3(snapshot, value)).toThrow()
      expect(snapshot).toEqual(original)
    }
  })
  it('rejects Stop reversal and changes to a completed Run', () => {
    const snapshot = fixture()
    const stopped = { ...snapshot, state: { ...snapshot.state, run: { ...snapshot.state.run, stopRequested: true } } }
    expect(RepeatGraphSnapshotV3Schema.safeParse(stopped).success).toBe(true)
    expect(() => reduceRepeatGraphPageV3(stopped, page(stopped, [batch(stopped, 2, snapshot.state.run)]))).toThrow()
    const terminal = { ...snapshot, state: { ...snapshot.state, run: {
      ...snapshot.state.run, executionState: 'completed' as const, outcome: 'succeeded' as const, stopRequested: false,
    } } }
    expect(RepeatGraphSnapshotV3Schema.safeParse(terminal).success).toBe(true)
    expect(() => reduceRepeatGraphPageV3(terminal, page(terminal, [batch(terminal, 2, snapshot.state.run)]))).toThrow()
  })
  it('rejects private input/result/native fields instead of stripping them into public facts', () => {
    const snapshot = fixture(), fact = { type: 'repeat.run.state', state: snapshot.state.run }
    for (const field of ['input', 'result', 'nativeSessionId', 'providerPayload', 'workingDirectory']) {
      expect(RepeatGraphFactV3Schema.safeParse({ ...fact, [field]: 'private-canary' }).success).toBe(false)
      expect(RepeatGraphFactV3Schema.safeParse({ ...fact, state: { ...fact.state, [field]: 'private-canary' } }).success).toBe(false)
    }
  })
  it('binds source-group order and exact event identity in the permanent complete-envelope digest', () => {
    const snapshot = fixture(), first = batch(snapshot, 2), second = batch(snapshot, 3)
    const together = { ...first, events: [first.events[0]!, second.events[0]!] }
    const swapped = { ...together, events: [...together.events].reverse() }
    // Both still pass the structural batch schema. Permanent proof distinguishes them.
    expect(RepeatGraphBatchV3Schema.safeParse(together).success).toBe(true)
    expect(RepeatGraphBatchV3Schema.safeParse(swapped).success).toBe(true)
    expect(repeatGraphBatchReceipt(together).sourceDigest).not.toBe(repeatGraphBatchReceipt(swapped).sourceDigest)
    expect(repeatGraphBatchReceipt(structuredClone(together))).toEqual(repeatGraphBatchReceipt(together))
  })
})
