import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { RepeatWorkflowVersionV1Schema } from './repeat.js'
import { RunGraphScopeSchema, RUN_GRAPH_LIMITS } from './graphPrimitives.js'
import {
  CanonicalRunGraphScopeSchema, RepeatGraphFactV3Schema, RepeatGraphSnapshotV3Schema, RepeatGraphPageV3Schema,
  RepeatGraphStateV3Schema, repeatGraphTopologyV3, reduceRepeatGraphPageV3, sortRepeatGraphState,
  type RepeatGraphFactV3, type RepeatGraphScopeV3, type RepeatGraphSnapshotV3,
} from './repeatGraphMetadata.js'
import { repeatMetadataSnapshotFromCanonicalV3, repeatMetadataCurrentFromCanonicalV3, repeatMetadataDeltaFromCanonicalV3,
  repeatMetadataResetFromCanonicalV3 } from './repeatMetadata.js'

const digest = `sha256:${'a'.repeat(64)}`, time = '2026-09-25T00:00:00.000Z'
function fixture() {
  const base = makeCurrentWorkflowFixture('eng04-projection'), [entry, exit] = base.version.definition.nodes
  assert.ok(entry && exit)
  const version = RepeatWorkflowVersionV1Schema.parse({ ...base.version, id: `${base.version.id}-v3`, executionSemanticsVersion: 3,
    definition: { ...base.version.definition, executionSemanticsVersion: 3, nodes: [entry, { ...exit, choice: { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] } }], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, repeat: { contractVersion: 1, blocks: [{ id: 'repair',
      nodeIds: [entry.id, exit.id], entryNodeId: entry.id, exitNodeId: exit.id, maxOccurrences: 3,
      repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] } } })
  const scope: RepeatGraphScopeV3 = { workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowVersionId: version.id, runId: base.run.id, executionSemanticsVersion: 3 }
  const occurrence = { contractVersion: 1 as const, identity: { scope, blockId: 'repair', occurrenceId: 'occ-1', occurrenceIndex: 1 },
    input: { bindingId: 'entry-input-1', inputDigest: digest, previous: null } }
  const identity = { workflowNodeId: exit.id, agentId: exit.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[exit.agentId]!,
    executionId: 'exit-execution-1', attempt: 1, occurrence: occurrence.identity }
  const snapshot = RepeatGraphSnapshotV3Schema.parse({ kind: 'snapshot', protocolVersion: 1, scope, asOfSequence: '1', retentionFloor: '0',
    historyCoverage: 'from_admission', topology: repeatGraphTopologyV3(version), state: {
      run: { executionState: 'running', outcome: 'pending', stopRequested: false,
        cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
      nodes: version.definition.nodes.map((node) => ({ state: { workflowNodeId: node.id, lifecycle: 'not_activated' },
        activity: { workflowNodeId: node.id, status: 'none' }, attention: { workflowNodeId: node.id,
          pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'current' } })),
      inputBindings: [], interactions: [], reviews: [], occurrences: [occurrence],
      executions: [{ identity, inputDigest: digest, previousExecutionId: null, state: 'completed', resultOutcome: 'succeeded' }],
      resolutions: [], results: [], bindings: [], decisions: [],
    } })
  const decision = { contractVersion: 1 as const, decisionId: 'decision-1', occurrence, exitExecution: identity,
    acceptedResultDigest: digest, outcome: 'issues', reason: 'repeat' as const,
    target: { kind: 'next_occurrence' as const, entryNodeId: entry.id, occurrenceIndex: 2 }, decidedAt: time }
  const next = { contractVersion: 1 as const, identity: { ...occurrence.identity, occurrenceId: 'occ-2', occurrenceIndex: 2 },
    input: { bindingId: 'entry-input-2', inputDigest: digest, previous: { occurrenceId: 'occ-1', occurrenceIndex: 1,
      decisionId: decision.decisionId, acceptedResultDigest: digest } } }
  const { occurrence: _occurrence, ...bare } = identity; void _occurrence
  const facts: RepeatGraphFactV3[] = [
    { type: 'repeat.result.accepted', result: { execution: identity, resultDigest: digest } },
    { type: 'repeat.node.resolved', resolution: { ref: { nodeId: exit.id, occurrence: occurrence.identity }, outside: false,
      deferredRelationshipIds: [], value: { workflowNodeId: exit.id, execution: bare, resolution: 'succeeded', acceptedResultDigest: digest,
        branchEnded: false, selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: time } } },
    { type: 'repeat.decision', decision }, { type: 'repeat.occurrence', occurrence: next },
  ]
  return { scope, snapshot, facts, occurrence, identity }
}
function page(snapshot: RepeatGraphSnapshotV3, facts: RepeatGraphFactV3[]) {
  return RepeatGraphPageV3Schema.parse({ kind: 'page', protocolVersion: 1, scope: snapshot.scope,
    baseSequence: '1', throughSequence: '2', headSequence: '2', retentionFloor: '0', hasMore: false,
    batches: [{ protocolVersion: 1, scope: snapshot.scope, batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '1', sequence: '2',
      events: facts.map((fact, i) => ({ eventId: `00000000-0000-4000-8000-${String(i+2).padStart(12,'0')}`,
        evidence: { sourceKind: 'node_resolution', sourceId: 'terminal-1', sourceRevision: '1' }, sourceDigest: digest,
        semanticDigest: digest, effect: null, fact })) }] })
}
describe('ENG04 explicit v3 graph metadata contracts', () => {
  it('reduces decision/result/resolution/successor atomically, retaining occurrence 1', () => {
    const f = fixture(), after = reduceRepeatGraphPageV3(f.snapshot, page(f.snapshot, f.facts))
    assert.equal(after.asOfSequence, '2'); assert.equal(after.state.occurrences.length, 2)
    assert.equal(after.state.decisions.length, 1); assert.equal(after.state.results.length, 1)
    assert.equal(f.snapshot.state.decisions.length, 0)
  })
  it('complete snapshot/current and the projected delta agree on one canonical head', () => {
    const f = fixture(), delta = page(f.snapshot, f.facts), after = reduceRepeatGraphPageV3(f.snapshot, delta)
    const snapshot = repeatMetadataSnapshotFromCanonicalV3(after), current = repeatMetadataCurrentFromCanonicalV3(after)
    assert.deepEqual({ ...current, kind: 'snapshot' }, snapshot)
    assert.equal(snapshot.throughSequence, '2'); assert.equal(snapshot.items[1]!.decision, null)
    assert.equal(repeatMetadataDeltaFromCanonicalV3(delta).batches[0]!.events.length, 2)
  })
  it('does not drop non-occurrence complete publication positions', () => {
    const f = fixture(), delta = page(f.snapshot, [{ type: 'repeat.run.state', state: f.snapshot.state.run }])
    const result = repeatMetadataDeltaFromCanonicalV3(delta)
    assert.equal(result.throughSequence, '2'); assert.equal(result.batches.length, 1); assert.deepEqual(result.batches[0]!.events, [])
  })
  it('duplicate page, order reversal and scope drift leave prior state unchanged', () => {
    const f = fixture(), delta = page(f.snapshot, f.facts), original = structuredClone(f.snapshot)
    const after = reduceRepeatGraphPageV3(f.snapshot, delta)
    assert.throws(() => reduceRepeatGraphPageV3(after, delta))
    assert.throws(() => reduceRepeatGraphPageV3(f.snapshot, { ...delta, baseSequence: '0' }))
    assert.throws(() => reduceRepeatGraphPageV3(f.snapshot, { ...delta, scope: { ...f.scope, runId: 'other' } }))
    assert.deepEqual(f.snapshot, original)
  })
  it('rejects foreign occurrence scope, missing accepted sender and duplicate ordinals', () => {
    const f = fixture(), after = reduceRepeatGraphPageV3(f.snapshot, page(f.snapshot, f.facts))
    const bad = structuredClone(after); bad.state.occurrences[0]!.identity.scope.runId = 'other'
    assert.equal(RepeatGraphSnapshotV3Schema.safeParse(bad).success, false)
    const duplicate = structuredClone(after.state); duplicate.occurrences.push(duplicate.occurrences[0]!)
    assert.equal(RepeatGraphStateV3Schema.safeParse(duplicate).success, false)
    const binding = { bindingId: 'binding', recipient: f.identity, sender: { ...f.identity, executionId: 'missing' },
      acceptedResultDigest: digest, inputDigest: digest, ordinal: 0, kind: 'predecessor', relationshipId: 'edge', decisionId: null }
    assert.equal(RepeatGraphStateV3Schema.safeParse({ ...after.state, bindings: [binding, { ...binding, bindingId: 'second' }] }).success, false)
  })
  it('strict metadata rejects private bodies and native/session/path fields', () => {
    const f = fixture()
    for (const secret of ['resultData', 'prompt', 'rawNativePayload', 'runtimeDirectory', 'credentials']) {
      assert.equal(RepeatGraphFactV3Schema.safeParse({ ...f.facts[0], [secret]: '/private-or-secret' }).success, false)
    }
    assert.equal(RepeatGraphFactV3Schema.safeParse({ ...f.facts[2], decision: { ...(f.facts[2] as Extract<RepeatGraphFactV3,{type:'repeat.decision'}>).decision,
      resultData: { latestDeliverable: 'private', remainingFindings: [] } } }).success, false)
  })
  it('shares the current graph scope and rejects retired or unknown semantics', () => {
    const f = fixture()
    assert.equal(RunGraphScopeSchema.safeParse(f.scope).success, true)
    assert.equal(CanonicalRunGraphScopeSchema.safeParse({ ...f.scope, executionSemanticsVersion: 4 }).success, false)
    for (const executionSemanticsVersion of [1,2]) assert.equal(CanonicalRunGraphScopeSchema.safeParse({ ...f.scope, executionSemanticsVersion }).success, false)
  })
  it('a retained reset is an instruction to fetch a snapshot, not a reducer event', () => {
    const f = fixture(), reset = { kind: 'reset', protocolVersion: 1, scope: f.scope, requestedSequence: '0', headSequence: '2',
      retentionFloor: '1', reason: 'history_expired', action: 'fetch_snapshot' }
    assert.throws(() => reduceRepeatGraphPageV3(f.snapshot, reset))
    assert.equal(repeatMetadataResetFromCanonicalV3(reset).reason, 'retention')
  })
  it('deterministic presentation order is independent of SQL row order', () => {
    const f = fixture(), state = reduceRepeatGraphPageV3(f.snapshot, page(f.snapshot, f.facts)).state
    const shuffled = { ...state, occurrences: [...state.occurrences].reverse() }
    assert.deepEqual(sortRepeatGraphState(shuffled), state)
  })
  it('oversized wire pages are rejected instead of truncated', () => {
    const f = fixture(), delta = page(f.snapshot, f.facts)
    assert.equal(RepeatGraphPageV3Schema.safeParse({ ...delta, batches: Array(RUN_GRAPH_LIMITS.pageBatches+1).fill(delta.batches[0]) }).success, false)
  })
})
