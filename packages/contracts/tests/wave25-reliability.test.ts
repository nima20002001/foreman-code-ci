import { describe, expect, it } from 'vitest'
import { makeCurrentGraphFixture } from './currentGraphFixture.js'
import {
  canonicalGraphJson, graphJsonBytes, assertGraphEffectAuthority,
  GraphEffectAccessStateSchema, GraphEffectFenceSchema, NativeGraphProjectionFenceSchema,
  assertNativeGraphProjectionAuthority, NativeTerminalEvidenceSchema, NativeWorkReliabilitySchema,
  assertNativeWorkTransition, nativeSubmissionRecovery, parseNativeGraphObservation,
  NATIVE_GRAPH_EVIDENCE_MAX_BYTES, classifyGraphObservation, GraphRunStateSchema, GraphNodeStateSchema,
  assertGraphRunTransition, assertGraphNodeTransition, RunGraphSnapshotSchema, applyRunGraphPageFixture,
  NativeGraphActivityRecordSchema, NativeGraphCorrelationRecordSchema,
} from '../src/wave25/index.js'

const digest = 'sha256:' + 'a'.repeat(64)
function fences() {
  const fixture = makeCurrentGraphFixture()
  const expected = GraphEffectFenceSchema.parse({ scope: fixture.scope,
    effect: { kind: 'execution.launch', entityId: fixture.identities[0]!.executionId }, effectDigest: digest,
    ownerId: 'existing-owner', fence: '9007199254740993', connectionGeneration: '4' })
  const current = GraphEffectAccessStateSchema.parse({ ...expected, ownership: 'held', access: 'effect', security: 'valid', effectClosed: false, submission: 'not_submitted' })
  return { fixture, expected, current }
}
function observation() {
  const fixture = makeCurrentGraphFixture()
  return { scope: fixture.scope,
    work: { execution: fixture.identities[0]!, workKind: 'workflow' as const, workId: fixture.identities[0]!.executionId },
    source: { sourceKind: 'native_event' as const, sourceId: 'native-source-1', sourceRevision: '0' },
    sourceStreamId: 'native-stream-1', sourcePosition: '9007199254740993', connectionGeneration: '4', observedAt: fixture.createdAt }
}

describe('v3 exact source identity versus fenced effect authority', () => {
  it('classifies duplicate/reordered observations without numeric cursor loss', () => {
    const native = observation()
    const first = { scope: native.scope, evidence: native.source, digest, streamId: native.sourceStreamId, position: native.sourcePosition }
    expect(classifyGraphObservation(first, structuredClone(first))).toBe('duplicate')
    expect(() => classifyGraphObservation(first, { ...first, digest: 'sha256:' + 'b'.repeat(64) })).toThrow('GRAPH_SOURCE_CONFLICT')
    const different = { ...first, evidence: { ...first.evidence, sourceId: 'native-source-2' } }
    expect(classifyGraphObservation(first, { ...different, position: '9007199254740992' })).toBe('earlier')
    expect(classifyGraphObservation(first, { ...different, position: '9007199254740994' })).toBe('later')
    expect(classifyGraphObservation(first, { ...different, streamId: 'another-stream' })).toBe('independent')
    expect(() => classifyGraphObservation(first, different)).toThrow('GRAPH_SOURCE_CONFLICT')
    expect(() => classifyGraphObservation(first, { ...different, scope: { ...first.scope, runId: 'another-run' } })).toThrow('GRAPH_SCOPE_MISMATCH')
  })
  it('requires current owner, exact scope/digest, generation, fence and explicit qualified permissions', () => {
    const { expected, current } = fences()
    expect(() => assertGraphEffectAuthority(expected, current)).not.toThrow()
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ ownerId: 'old-owner' }, 'GRAPH_OWNER_LOST'], [{ ownership: 'lost' }, 'GRAPH_OWNER_LOST'],
      [{ fence: '9007199254740992' }, 'GRAPH_STALE_FENCE'], [{ connectionGeneration: '5' }, 'GRAPH_STALE_GENERATION'],
      [{ connectionGeneration: null }, 'GRAPH_STALE_GENERATION'], [{ access: 'observe' }, 'GRAPH_EFFECT_ACCESS_DENIED'],
      [{ security: 'unknown' }, 'GRAPH_SECURITY_UNQUALIFIED'], [{ security: 'invalid' }, 'GRAPH_SECURITY_UNQUALIFIED'],
      [{ security: 'future-mode' }, 'GRAPH_AUTHORITY_INVALID'], [{ effectClosed: true }, 'GRAPH_TERMINAL_CONFLICT'],
      [{ submission: 'uncertain' }, 'GRAPH_SUBMISSION_NOT_REPLAYABLE'], [{ submission: 'acknowledged' }, 'GRAPH_SUBMISSION_NOT_REPLAYABLE'],
      [{ submission: 'unknown' }, 'GRAPH_SUBMISSION_NOT_REPLAYABLE'], [{ effectDigest: 'sha256:' + 'b'.repeat(64) }, 'GRAPH_EFFECT_CONFLICT'],
    ]
    for (const [patch, code] of invalid) expect(() => assertGraphEffectAuthority(expected, { ...current, ...patch })).toThrow(code)
    const { security: _security, ...missing } = current
    expect(() => assertGraphEffectAuthority(expected, missing)).toThrow('GRAPH_AUTHORITY_INVALID')
    expect(_security).toBe('valid')
  })
  it('separates observation access from current projection-write authority', () => {
    const { fixture } = fences(), native = observation()
    const expected = NativeGraphProjectionFenceSchema.parse({ scope: fixture.scope, key: native.work, ownerId: 'existing-owner', fence: '8', connectionGeneration: '4' })
    const current = { ...expected, ownership: 'held', access: 'project' }
    expect(() => assertNativeGraphProjectionAuthority(expected, current)).not.toThrow()
    expect(() => assertNativeGraphProjectionAuthority(expected, { ...current, access: 'observe' })).toThrow('GRAPH_EFFECT_ACCESS_DENIED')
    expect(() => assertNativeGraphProjectionAuthority(expected, { ...current, connectionGeneration: '3' })).toThrow('GRAPH_STALE_GENERATION')
    expect(() => assertNativeGraphProjectionAuthority(expected, { ...current, fence: '9' })).toThrow('GRAPH_STALE_FENCE')
  })
})

describe('v3 terminal, uncertainty and transport separation', () => {
  it.each(['open', 'closed', 'keepalive'])('%s is transport only, not completion or semantic progress', (transport) => {
    const value = { ...observation(), kind: 'transport', transport }
    expect(parseNativeGraphObservation(value)).toEqual(value)
    expect(() => parseNativeGraphObservation({ ...value, terminal: { outcome: 'succeeded' } })).toThrow('GRAPH_EVIDENCE_INVALID')
    expect(() => parseNativeGraphObservation({ ...value, action: 'working' })).toThrow('GRAPH_EVIDENCE_INVALID')
    expect(() => parseNativeGraphObservation({ ...value, semanticProgressAt: value.observedAt })).toThrow('GRAPH_EVIDENCE_INVALID')
  })
  it('requires positive structured terminal evidence; unknown/uncertain never defaults to success', () => {
    const unknown = { submission: 'unknown', submissionId: null, terminal: null, stopRequested: false }
    expect(NativeWorkReliabilitySchema.parse(unknown)).toEqual(unknown)
    const uncertain = { ...unknown, submission: 'uncertain', submissionId: 'submission-1' }
    expect(NativeWorkReliabilitySchema.parse(uncertain)).toEqual(uncertain)
    const terminal = { outcome: 'succeeded', evidenceKind: 'provider_terminal', evidenceId: 'terminal-1', nativeSettled: true }
    expect(NativeWorkReliabilitySchema.safeParse({ ...uncertain, terminal }).success).toBe(false)
    expect(NativeTerminalEvidenceSchema.safeParse({ ...terminal, nativeSettled: false }).success).toBe(false)
    expect(NativeTerminalEvidenceSchema.safeParse({ ...terminal, outcome: 'uncertain' }).success).toBe(false)
    expect(NativeWorkReliabilitySchema.safeParse({ ...unknown, submission: 'future-state' }).success).toBe(false)
    expect(NativeTerminalEvidenceSchema.safeParse({ ...terminal, evidenceKind: 'transport_closed' }).success).toBe(false)
    expect(NativeWorkReliabilitySchema.safeParse({ ...uncertain, terminal: { ...terminal, outcome: 'interrupted', evidenceKind: 'persisted_terminal', nativeSettled: false } }).success).toBe(true)
  })
  it('allows only reconciliation of possibly submitted work and retains submission/terminal identity', () => {
    expect(nativeSubmissionRecovery('unknown')).toBe('observe')
    expect(nativeSubmissionRecovery('not_submitted')).toBe('eligible')
    expect(nativeSubmissionRecovery('uncertain')).toBe('reconcile')
    expect(nativeSubmissionRecovery('acknowledged')).toBe('reconcile')
    expect(nativeSubmissionRecovery('settled')).toBe('settle')
    const previous = NativeWorkReliabilitySchema.parse({ submission: 'uncertain', submissionId: 'submission-1', terminal: null, stopRequested: false })
    expect(() => assertNativeWorkTransition(previous, { ...previous, submission: 'not_submitted' })).toThrow('GRAPH_SUBMISSION_NOT_REPLAYABLE')
    expect(() => assertNativeWorkTransition(previous, { ...previous, submissionId: 'replacement' })).toThrow('GRAPH_SOURCE_CONFLICT')
    const interrupted = NativeWorkReliabilitySchema.parse({ ...previous, terminal: { outcome: 'interrupted', evidenceKind: 'persisted_terminal', evidenceId: 'failure-1', nativeSettled: false } })
    expect(() => assertNativeWorkTransition(interrupted, { ...interrupted, terminal: null })).toThrow('GRAPH_TERMINAL_CONFLICT')
    expect(() => assertNativeWorkTransition(interrupted, { ...interrupted, submission: 'settled', terminal: { ...interrupted.terminal!, nativeSettled: true } })).not.toThrow()
  })
  it('retains unknown lifecycle and native terminal fences instead of fabricating Idle or reactivation', () => {
    const { fixture } = fences(), native = observation(), id = fixture.identities[0]!
    expect(GraphNodeStateSchema.parse({ workflowNodeId: id.workflowNodeId, lifecycle: 'unknown' }).lifecycle).toBe('unknown')
    expect(GraphNodeStateSchema.parse({ workflowNodeId: id.workflowNodeId, lifecycle: 'uncertain', execution: id }).lifecycle).toBe('uncertain')
    const record = { key: native.work, projectionRevision: '2', lastNativeSequence: '8', terminalNativeSequence: '8', activity: { workflowNodeId: id.workflowNodeId, status: 'none' } }
    expect(NativeGraphActivityRecordSchema.safeParse(record).success).toBe(true)
    expect(NativeGraphActivityRecordSchema.safeParse({ ...record, activity: { workflowNodeId: id.workflowNodeId, status: 'active', action: 'working', execution: id, acknowledgementId: 'ack-1', correlationId: 'corr-1' } }).success).toBe(false)
    expect(NativeGraphCorrelationRecordSchema.safeParse({ key: native.work, correlationKey: 'corr-1', provider: 'codex', nativeSessionId: 'native-session', connectionId: 'connection-1', connectionGeneration: 4,
      nativeTurnId: null, nativeRequestId: null, interactionId: null, reviewJobId: null, firstNativeSequence: '1', lastNativeSequence: '8', terminalNativeSequence: '9', metadataRevision: '2' }).success).toBe(false)
  })
})

describe('v3 monotonic Stop and complete structured limits', () => {
  it('never clears Stop or rewrites a terminal outcome, while allowing independent cleanup', () => {
    const fixture = makeCurrentGraphFixture(), previous = { ...fixture.snapshot.state.run, stopRequested: true }
    expect(() => assertGraphRunTransition(previous, { ...previous, stopRequested: false })).toThrow('GRAPH_STOP_CONFLICT')
    expect(() => assertGraphRunTransition(previous, { ...previous, stopRequested: null as never })).toThrow()
    expect(() => assertGraphRunTransition(previous, { ...previous, executionState: 'completed', outcome: 'succeeded' })).toThrow('GRAPH_STOP_CONFLICT')
    const completed = GraphRunStateSchema.parse({ ...fixture.snapshot.state.run, executionState: 'completed', outcome: 'succeeded', cleanupPending: true })
    expect(() => assertGraphRunTransition(completed, { ...completed, stopRequested: true, cleanupPending: false })).not.toThrow()
    expect(() => assertGraphRunTransition(completed, { ...completed, outcome: 'canceled' })).toThrow('GRAPH_TERMINAL_CONFLICT')
    const terminal = { workflowNodeId: fixture.identities[0]!.workflowNodeId, lifecycle: 'interrupted' as const, execution: fixture.identities[0]! }
    expect(() => assertGraphNodeTransition(terminal, { ...terminal, lifecycle: 'running' })).toThrow('GRAPH_TERMINAL_CONFLICT')
    expect(RunGraphSnapshotSchema.safeParse({ ...fixture.snapshot, state: { ...fixture.snapshot.state, run: { ...previous, stopRequested: null } } }).success).toBe(false)
    expect(RunGraphSnapshotSchema.safeParse({ ...fixture.snapshot, scope: { ...fixture.scope, executionSemanticsVersion: 1 } }).success).toBe(false)
  })
  it('rejects an atomic batch that would resurrect a stopped node without committing any of it', () => {
    const fixture = makeCurrentGraphFixture(), original = fixture.snapshot
    const events = [
      { fact: { type: 'run.state', state: { ...original.state.run, stopRequested: true } } },
      { fact: { type: 'node.state', state: { workflowNodeId: fixture.identities[0]!.workflowNodeId, lifecycle: 'starting', execution: fixture.identities[0] } } },
    ].map((item, i) => ({ ...item, eventId: `00000000-0000-4000-8000-00000000000${i + 2}`, evidence: { sourceKind: 'run', sourceId: 'stop-fixture', sourceRevision: '1' } }))
    const batch = { protocolVersion: 1, scope: fixture.scope, batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '0', sequence: '1', events }
    const result = applyRunGraphPageFixture(original, { kind: 'page', protocolVersion: 1, scope: fixture.scope, baseSequence: '0', throughSequence: '1', headSequence: '1', retentionFloor: '0', hasMore: false, batches: [batch] }, 1, 1)
    expect(result.kind).toBe('reset'); expect(result.snapshot).toBe(original)
    expect(result.snapshot.asOfSequence).toBe('0'); expect(result.snapshot.state.run.stopRequested).toBe(false)
    expect(result.appliedEventIds).toEqual([])
  })
  it('counts exact UTF-8 and escaped JSON bytes; never returns a partial structured value', () => {
    const value = { b: ['é', '\n', '😀'], a: { x: true } }, encoded = canonicalGraphJson(value)
    expect(JSON.parse(encoded)).toEqual(value)
    const bytes = new TextEncoder().encode(encoded).byteLength
    expect(canonicalGraphJson(value, bytes)).toBe(encoded)
    expect(() => canonicalGraphJson(value, bytes - 1)).toThrow('GRAPH_JSON_LIMIT')
    expect(() => canonicalGraphJson('a'.repeat(100), 5)).toThrow('GRAPH_JSON_LIMIT')
    expect(() => canonicalGraphJson([1, undefined])).toThrow('GRAPH_JSON_INVALID')
    const sparse = [1, 2, 3]; delete sparse[1]
    expect(() => canonicalGraphJson(sparse)).toThrow('GRAPH_JSON_INVALID')
    expect(() => canonicalGraphJson({ value: Infinity })).toThrow('GRAPH_JSON_INVALID')
    let evaluated = false
    expect(() => canonicalGraphJson({ get hidden() { evaluated = true; return 'secret' } })).toThrow('GRAPH_JSON_INVALID')
    expect(evaluated).toBe(false)
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(graphJsonBytes(cycle)).toBe(Infinity)
    expect(canonicalGraphJson({ ok: true })).toBe('{"ok":true}')
  })
  it('rejects malformed/oversized complete evidence without poisoning the next valid observation', () => {
    const value = { ...observation(), kind: 'transport', transport: 'closed' }
    expect(() => parseNativeGraphObservation({ ...value, rawBody: 'x'.repeat(NATIVE_GRAPH_EVIDENCE_MAX_BYTES) })).toThrow('GRAPH_EVIDENCE_TOO_LARGE')
    expect(() => parseNativeGraphObservation(JSON.stringify(value).slice(0, -1))).toThrow('GRAPH_EVIDENCE_INVALID')
    expect(() => parseNativeGraphObservation({ ...value, rawBody: '{}' })).toThrow('GRAPH_EVIDENCE_INVALID')
    expect(parseNativeGraphObservation(value)).toEqual(value)
  })
})
