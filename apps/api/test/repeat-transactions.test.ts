import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { MemorySaver } from '@langchain/langgraph'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import {
  RepeatWorkflowVersionV1Schema, makeCurrentWorkflowFixture, parseRepeatExitResultV1,
  validateRepeatDecisionV1, validateRepeatSuccessorV1, canonicalGraphJson,
  type RepeatOccurrenceV1,
} from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { DomainError } from '../src/modules/errors.js'
import { SourceError } from '../src/modules/sources/manifest.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { normalizeRepeatTerminal, repeatNodeAction, repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { RepeatRunRepository, type RepeatRepositoryHost, type RepeatRuntimeRun } from '../src/modules/runs/repeatPostgres.js'
import {
  assertRepeatBodyComplete, assertRepeatSource, bindRepeatNodeInput, compileRepeatLayout,
  decideRepeatAdmission, decideRepeatBlockEntry, decideRepeatExit, finalRepeatExport, freezeRepeatEntry,
  makeRepeatOccurrence, repeatDigest, repeatExecutionIdentity, repeatSlotId, repeatSuccessorInput,
  type RepeatResolution, type RepeatScope, type RepeatSource,
} from '../src/modules/runs/repeatResolution.js'
import { executeRepeatRuntime, repeatExecutionDirectoryKey, startIntervalChecks } from '../src/modules/runs/repeatRuntime.js'
import { compileExecutionTopology } from '../src/modules/runs/topology.js'
import { workflowNativeReservation, type WorkflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'

const at = '2026-09-25T00:00:00.000Z'
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, kind: 'execution' as const, source, target })
function fixture(cap = 3) {
  const base = makeCurrentWorkflowFixture('repeat-core')
  const names = ['work', 'review', 'done', 'limit']
  const version = RepeatWorkflowVersionV1Schema.parse({ ...base.version, executionSemanticsVersion: 3, entryNodeId: 'work',
    agentConfigurationVersionIds: Object.fromEntries(names.map((id) => [`agent-${id}`, `config-${id}`])),
    definition: { ...base.version.definition, executionSemanticsVersion: 3, entryNodeId: 'work',
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: cap * 2 + 2 },
      nodes: names.map((id) => ({ id, agentId: `agent-${id}`, name: id, ...(id === 'review' ? { choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge', relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge', relationshipId: 'review-limit' } },
      ] } } : {}) })),
      edges: [edge('work', 'review'), edge('review', 'done'), edge('review', 'limit')],
      repeat: { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
        maxOccurrences: cap, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'edge', relationshipId: 'review-limit' } }] },
    } })
  const scope: RepeatScope = { ...base.scope, executionSemanticsVersion: 3 }
  const run: RepeatRuntimeRun = { ...base.run, executionState: 'running', executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds }
  return { version, scope, run, block: version.definition.repeat!.blocks[0]! }
}
function execution(f: ReturnType<typeof fixture>, nodeId: string, id: string, attempt = 1): HarnessExecution {
  return HarnessExecutionSchema.parse({ id, runId: f.scope.runId, workflowNodeId: nodeId, agentId: `agent-${nodeId}`,
    agentConfigurationVersionId: `config-${nodeId}`, attempt, state: 'queued', input: {}, createdAt: at })
}
function successful(value: HarnessExecution, output: unknown = {}): HarnessExecution {
  return HarnessExecutionSchema.parse({ ...value, state: 'completed', finishedAt: at, result: { outcome: 'succeeded', output } })
}
function terminal(f: ReturnType<typeof fixture>, occ: RepeatOccurrenceV1, outcome = 'issues', attempt = 1) {
  const output = { routing: { outcome }, data: { latestDeliverable: { revision: occ.identity.occurrenceIndex }, remainingFindings: outcome === 'pass' ? [] : [{ id: 'f1' }] } }
  const completed = successful(execution(f, 'review', `exit-${occ.identity.occurrenceIndex}-${attempt}`, attempt), output)
  const decision = decideRepeatExit(f.version, occ, completed, parseRepeatExitResultV1(completed.result, f.version.definition.nodes[1]!.choice!), at)
  return { completed, decision }
}
function first(f: ReturnType<typeof fixture>) { return makeRepeatOccurrence(f.scope, f.block, freezeRepeatEntry({}, []), null) }
function resolved(f: ReturnType<typeof fixture>, occurrence: RepeatOccurrenceV1, nodeId: string) {
  const e = successful(execution(f, nodeId, `${nodeId}-${occurrence.identity.occurrenceIndex}`))
  return repeatTerminalResolution(f.version, f.scope, { nodeId, occurrence: occurrence.identity }, e)
}

describe('deterministic occurrence core', () => {
  it('admits a second disjoint repeat block from the first final export with its occurrence provenance', () => {
    const f = fixture(2)
    const second = { ...f.block, id: 'second', maxOccurrences: 1, nodeIds: ['done'], entryNodeId: 'done', exitNodeId: 'done',
      limitExit: { kind: 'branch_end' as const } }
    f.version = RepeatWorkflowVersionV1Schema.parse({ ...f.version, definition: { ...f.version.definition,
      nodes: f.version.definition.nodes.map((node) => node.id === 'done' ? { ...node, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } },
        { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } } : node),
      repeat: { contractVersion: 1, blocks: [f.block, second] },
    } })
    const current = first(f)
    const { completed, decision } = terminal(f, current.occurrence, 'pass')
    const local = repeatTerminalResolution(f.version, f.scope,
      { nodeId: 'review', occurrence: current.occurrence.identity }, completed)
    expect(() => decideRepeatBlockEntry(f.version, second, new Map([['review', local]]))).toThrow()
    expect(() => decideRepeatBlockEntry(f.version, second,
      new Map([['work', resolved(f, current.occurrence, 'work')]]))).toThrow()
    const exported = finalRepeatExport(f.version, local, decision)
    expect(exported.ref.occurrence).toEqual(current.occurrence.identity)
    const admission = decideRepeatBlockEntry(f.version, second, new Map([['review', exported]]))
    expect(admission.kind).toBe('run')
    if (admission.kind !== 'run') throw new Error('second block should be selected')
    expect(admission.selected.map((edge) => edge.id)).toEqual(['review-done'])
    const next = makeRepeatOccurrence(f.scope, second, freezeRepeatEntry({}, []), null)
    expect(next.occurrence.identity.blockId).toBe('second')
    expect(decideRepeatAdmission(f.version, { nodeId: 'done', occurrence: next.occurrence.identity }, new Map()).kind).toBe('run')
    const end = successful(execution(f, 'done', 'second-exit'), {
      routing: { outcome: 'pass' }, data: { latestDeliverable: {}, remainingFindings: [] },
    })
    const endDecision = decideRepeatExit(f.version, next.occurrence, end,
      parseRepeatExitResultV1(end.result, f.version.definition.nodes.find((node) => node.id === 'done')!.choice!), at)
    const endLocal = repeatTerminalResolution(f.version, f.scope, { nodeId: 'done', occurrence: next.occurrence.identity }, end)
    expect(() => decideRepeatBlockEntry(f.version, second, new Map([['done', endLocal]]))).toThrow()
    expect(finalRepeatExport(f.version, endLocal, endDecision).value.branchEnded).toBe(true)
  })
  it('repeats to the explicit cap, carries exact previous accepted result, and never creates cap+1', () => {
    const f = fixture(3)
    let current = first(f)
    for (let index = 1; index <= 3; index++) {
      const { completed, decision } = terminal(f, current.occurrence)
      expect(validateRepeatDecisionV1(f.version, decision, completed.result)).toEqual(decision)
      expect(decision.reason).toBe(index === 3 ? 'limit_exit' : 'repeat')
      if (index < 3) {
        const next = makeRepeatOccurrence(f.scope, f.block, repeatSuccessorInput(current.input, decision, completed.result!), decision)
        expect(validateRepeatSuccessorV1(f.version, decision, next.occurrence, completed.result)).toEqual(next.occurrence)
        expect(next.input.carry!.execution.executionId).toBe(completed.id)
        expect(next.occurrence.input.previous!.acceptedResultDigest).toBe(repeatDigest(completed.result))
        current = next
      } else {
        expect(decision.target).toEqual(f.block.limitExit)
        expect(decision.resultData.remainingFindings).toEqual([{ id: 'f1' }])
        expect(() => makeRepeatOccurrence(f.scope, f.block, repeatSuccessorInput(current.input, decision, completed.result!), decision)).toThrow()
      }
    }
  })
  it.each([1, 3])('gives early exit precedence over a cap of %i and exports only its chosen edge', (cap) => {
    const f = fixture(cap), current = first(f), { completed, decision } = terminal(f, current.occurrence, 'pass')
    const local = repeatTerminalResolution(f.version, f.scope, { nodeId: 'review', occurrence: current.occurrence.identity }, completed)
    expect(decision.reason).toBe('early_exit')
    expect(finalRepeatExport(f.version, local, decision).value.selectedRelationshipIds).toEqual(['review-done'])
    expect(local.deferredRelationshipIds).toEqual(['review-done', 'review-limit'])
    expect(local.value.selectedRelationshipIds).toEqual([])
    expect(local.value.unselectedRelationshipIds).toEqual([])
  })
  it('does not deselect or resolve an external edge on an intermediate occurrence', () => {
    const f = fixture(), current = first(f), { completed, decision } = terminal(f, current.occurrence)
    const local = repeatTerminalResolution(f.version, f.scope, { nodeId: 'review', occurrence: current.occurrence.identity }, completed)
    expect(() => finalRepeatExport(f.version, local, decision)).toThrow()
    expect(() => decideRepeatAdmission(f.version, { nodeId: 'done', occurrence: null }, new Map([['review', local]]))).toThrow()
  })
  it('creates new identities for a new Run, but deterministic identities for replay in the same Run', () => {
    const f = fixture(), a = first(f), b = first(f)
    expect(a).toEqual(b)
    const retry = makeRepeatOccurrence({ ...f.scope, runId: 'different-run' }, f.block, a.input, null)
    expect(retry.occurrence.identity.occurrenceIndex).toBe(1)
    expect(retry.occurrence.identity.occurrenceId).not.toBe(a.occurrence.identity.occurrenceId)
  })
  it('keeps technical attempts inside a slot with byte-identical input, not a new occurrence', () => {
    const f = fixture(), current = first(f), ref = { nodeId: 'work', occurrence: current.occurrence.identity }
    const bind = (attempt: number) => bindRepeatNodeInput({ version: f.version, runInput: current.input.runInput, ref,
      recipient: execution(f, 'work', `work-attempt-${attempt}`, attempt), occurrence: current.occurrence, entry: current.input, predecessors: [] })
    expect(bind(2).digest).toBe(bind(1).digest)
    expect(canonicalGraphJson(bind(2).input)).toBe(canonicalGraphJson(bind(1).input))
    expect(repeatSlotId(f.scope.runId, ref)).toBe(repeatSlotId(f.scope.runId, structuredClone(ref)))
  })
  it('rejects replaced result bytes and cross-Run carry lineage', () => {
    const f = fixture(), current = first(f), { completed, decision } = terminal(f, current.occurrence)
    expect(() => repeatSuccessorInput(current.input, decision, successful(completed, {}).result!)).toThrow()
    expect(() => makeRepeatOccurrence({ ...f.scope, runId: 'other' }, f.block, repeatSuccessorInput(current.input, decision, completed.result!), decision)).toThrow()
  })
  it('requires complete accepted exact execution, agent and configuration pins for each source', () => {
    const f = fixture(), current = first(f), e = successful(execution(f, 'work', 'exact-work'))
    const source: RepeatSource = { relationshipId: 'work-review', execution: repeatExecutionIdentity(e), occurrence: current.occurrence.identity,
      acceptedResult: e.result!, acceptedResultDigest: repeatDigest(e.result) }
    expect(() => assertRepeatSource(f.version, f.scope, source, e, true)).not.toThrow()
    expect(() => assertRepeatSource(f.version, f.scope, source, e, false)).toThrow()
    expect(() => assertRepeatSource(f.version, f.scope, source, { ...e, id: 'replacement' }, true)).toThrow()
    expect(() => assertRepeatSource(f.version, f.scope, source, { ...e, agentConfigurationVersionId: 'other' }, true)).toThrow()
  })
  it('isolates selected joins and completion from earlier occurrences', () => {
    const f = fixture(), a = first(f), { completed, decision } = terminal(f, a.occurrence)
    const b = makeRepeatOccurrence(f.scope, f.block, repeatSuccessorInput(a.input, decision, completed.result!), decision)
    const old = resolved(f, a.occurrence, 'work')
    expect(() => decideRepeatAdmission(f.version, { nodeId: 'review', occurrence: b.occurrence.identity }, new Map([['work', old]]))).toThrow()
    expect(() => assertRepeatBodyComplete(f.version, b.occurrence.identity, new Map([['work', old]]))).toThrow()
    const current = resolved(f, b.occurrence, 'work')
    expect(decideRepeatAdmission(f.version, { nodeId: 'review', occurrence: b.occurrence.identity }, new Map([['work', current]])).kind).toBe('run')
  })
  it('keeps layout size independent of cap, with one boundary pair per block', () => {
    const a = compileRepeatLayout(fixture(1).version), b = compileRepeatLayout(fixture(1000).version)
    expect(a.nodes).toEqual(b.nodes)
    expect(a.edges).toEqual(b.edges)
    expect(a.boundaries).toHaveLength(1)
    expect(b.recursionLimit).toBeGreaterThan(a.recursionLimit)
  })
  it('rejects cycles in both the common current graph and configured repeat blocks', () => {
    const current = makeCurrentWorkflowFixture('guard').version
    const broken = structuredClone(current)
    broken.definition.edges.push(edge(broken.definition.nodes[1]!.id, broken.entryNodeId))
    expect(() => compileExecutionTopology(broken)).toThrow()
    const f = fixture(); f.version.definition.edges.push(edge('limit', 'work'))
    expect(RepeatWorkflowVersionV1Schema.safeParse(f.version).success).toBe(false)
  })
  it('snapshots input by value, and bounds execution path names independently of ID length', () => {
    const runInput = {}, snapshot = freezeRepeatEntry(runInput, [])
    Object.assign(runInput, { changed: true })
    expect(snapshot.runInput).toEqual({})
    expect(repeatExecutionDirectoryKey('x'.repeat(200))).toHaveLength(64)
    expect(repeatExecutionDirectoryKey('x')).not.toBe(repeatExecutionDirectoryKey('y'))
    expect(() => repeatExecutionDirectoryKey('../escape')).toThrow()
  })
  it('preserves exact native text-carried results and fails closed for malformed repeat exits', () => {
    const f = fixture(), current = first(f), ref = { nodeId: 'review', occurrence: current.occurrence.identity }
    const { completed } = terminal(f, current.occurrence)
    expect(normalizeRepeatTerminal(f.version, f.scope, ref, completed)).toEqual(completed)
    const text = successful(completed, { text: JSON.stringify(completed.result!.outcome === 'succeeded' ? completed.result!.output : {}) })
    expect(normalizeRepeatTerminal(f.version, f.scope, ref, text)).toEqual(text)
    const resolution = repeatTerminalResolution(f.version, f.scope, ref, text)
    expect(resolution.value.acceptedResultDigest).toBe(repeatDigest(text.result))
    expect(resolution.value.acceptedResultDigest).not.toBe(repeatDigest(completed.result))
    const mixed = successful(completed, { text: JSON.stringify({}), routing: { outcome: 'pass' } })
    expect(normalizeRepeatTerminal(f.version, f.scope, ref, mixed).result?.outcome).toBe('failed')
    expect(normalizeRepeatTerminal(f.version, f.scope, ref, successful(completed, {})).result?.outcome).toBe('failed')
  })
  it('skipped/resolved wrapper replay never creates a candidate or calls native observe', async () => {
    const f = fixture(), current = first(f), resolution = resolved(f, current.occurrence, 'work')
    let native = 0, candidates = 0
    const action = repeatNodeAction({ runId: f.scope.runId, signal: new AbortController().signal, limiter: new ExecutionLimiter(1, 10),
      store: { admit: async () => ({ kind: 'resolved', resolution }), acceptTerminal: async () => { throw new Error('not called') } },
      driver: { candidate: () => { candidates++; return execution(f, 'work', 'no') }, observe: async () => { native++ } } })
    await action(resolution.ref, { runId: f.scope.runId, occurrences: {}, boundaries: {}, executionIds: {} })
    expect([candidates, native]).toEqual([0, 0])
  })
})

/** PostgreSQL-SHAPED test double, not PostgreSQL and not native/security proof.
 * Executes the real repository and real transaction facade, retaining SQL, ordered
 * hooks, rollback and ambiguous COMMIT behavior. Unsupported SQL fails the test.
 * Database constraints, advisory locks, RLS and canonical publication require D's
 * separate real PostgreSQL integration lane before activation. */
interface DbState {
  run: RepeatRuntimeRun; stopped: boolean
  occurrences: Map<string, { record: RepeatOccurrenceV1; input_json: string; input_digest: string }>
  slots: Map<string, { slot_id: string; occurrence_id: string | null; workflow_node_id: string; input_json: string; input_digest: string }>
  executions: Map<string, { record: HarnessExecution; accepted: boolean; slot_id: string; identity: unknown; previous: string | null }>
  resolutions: Map<string, RepeatResolution>; bindings: Array<{ recipient: string; record: unknown }>
  results: Map<string, { result_json: string; result_digest: string }>; decisions: Map<string, unknown>
  effects: Map<string, string>; receipts: Map<string, string>
  nativeEntries: Map<string, { reservation: WorkflowNativeReservation; reservation_json: string; reservation_digest: string; phase: 'reserved' }>
  native: Map<string, { session: { harness: 'codex'; providerVersion: string; nativeSessionId: string }; finalized: boolean; closed: boolean }>
}
function postgresShape(cap = 3, artifacts: false | 'enabled' | 'missing' = false) {
  const f = fixture(cap), events: string[] = []
  if (artifacts) {
    const work = f.version.definition.nodes.find(node => node.id === 'work')!
    if (work.kind === 'job') throw new Error('fixture')
    work.artifactOutputs = { version: 1, outputKeys: ['report'] }
  }
  let state: DbState = { run: f.run, stopped: false, occurrences: new Map(), slots: new Map(), executions: new Map(),
    resolutions: new Map(), bindings: [], results: new Map(), decisions: new Map(), effects: new Map(), receipts: new Map(), nativeEntries: new Map(), native: new Map() }
  let saved: DbState | undefined, fault = '', lostCommit = false, fence = 0
  const key = (kind: unknown, id: unknown) => `${kind}:${id}`
  const client = { query: async (text: string, values: unknown[] = []) => {
    const q = text.replace(/\s+/g, ' ').trim().toLowerCase(), v = values as Array<string | null>
    events.push(q)
    let rows: unknown[] = [], rowCount: number | undefined
    if (q.startsWith('begin ')) saved = structuredClone(state)
    else if (q === 'commit') { saved = undefined; if (lostCommit) { lostCommit = false; throw new Error('COMMIT reply lost') } }
    else if (q === 'rollback') { if (saved) state = saved; saved = undefined }
    else if (q.includes('from runs r join workflow_versions')) rows = [{ run: state.run, version: f.version, stopped: state.stopped, state: state.run.executionState, now: at }]
    else if (q.startsWith('select ( (select count(*) from harness_executions')) {
      rows = [{ total: String([...state.executions.values()].filter((item) => item.record.runId === v[0]).length) }]
    }
    else if (q.startsWith('select record,input_json,input_digest')) { const row = state.occurrences.get(v[0]!); if (row) rows = [row] }
    else if (q.startsWith('select occurrence_id from run_repeat_occurrences')) {
      const list = [...state.occurrences.values()].filter((x) => x.record.identity.blockId === v[1]
        && (values.length < 3 || x.record.identity.occurrenceIndex === values[2])).sort((a, b) => b.record.identity.occurrenceIndex - a.record.identity.occurrenceIndex)
      rows = list.slice(0, 1).map((x) => ({ occurrence_id: x.record.identity.occurrenceId }))
    } else if (q.startsWith('select record from run_repeat_resolutions')) rows = [...state.resolutions.entries()].filter(([k]) => k.startsWith(`${v[1]}:`)).map(([, record]) => ({ record }))
    else if (q.startsWith('select payload_digest')) { const payload_digest = state.effects.get(key(v[1], v[2])); if (payload_digest) rows = [{ payload_digest }] }
    else if (q.startsWith('insert into run_repeat_occurrences')) state.occurrences.set(v[0]!, { record: JSON.parse(v[14]!), input_json: v[8]!, input_digest: v[9]! })
    else if (q.startsWith('insert into run_repeat_effects')) state.effects.set(key(v[1], v[2]), v[3]!)
    else if (q.startsWith('insert into run_repeat_slots')) state.slots.set(v[0]!, { slot_id: v[0]!, occurrence_id: v[2]!, workflow_node_id: v[3]!, input_json: v[4]!, input_digest: v[5]! })
    else if (q.startsWith('insert into harness_executions')) state.executions.set(v[0]!, { record: JSON.parse(v[6]!), accepted: false, slot_id: '', identity: {}, previous: null })
    else if (q.startsWith('insert into workflow_native_entries')) {
      const entry = state.executions.get(v[0]!)!, slot = state.slots.get(entry.slot_id)!
      const occurrence = slot.occurrence_id ? state.occurrences.get(slot.occurrence_id)!.record.identity : null
      const reservation = workflowNativeReservation(f.scope, { nodeId: slot.workflow_node_id, occurrence }, entry.record, slot.input_digest)
      expect(values).toEqual([entry.record.id, f.scope.runId, canonicalGraphJson(reservation), canonicalGraphJson(reservation), repeatDigest(reservation)])
      expect(q).toContain("values($1,$2,$3::jsonb,$4::text,$5,'reserved')")
      expect(state.nativeEntries.has(entry.record.id)).toBe(false)
      state.nativeEntries.set(entry.record.id, { reservation: structuredClone(reservation), reservation_json: v[3]!, reservation_digest: v[4]!, phase: 'reserved' })
      rowCount = 1
    }
    else if (q.startsWith('insert into run_repeat_executions')) Object.assign(state.executions.get(v[0]!)!, { slot_id: v[2], identity: JSON.parse(v[6]!), previous: v[5] })
    else if (q.startsWith('select x.execution_id from run_repeat_executions x')) {
      rows = [...state.executions.values()].filter((e) => e.record.runId === v[0]
        && state.slots.get(e.slot_id)!.occurrence_id === v[1] && e.record.workflowNodeId === v[2]
        && e.record.attempt === 1).map((e) => ({ execution_id: e.record.id }))
    }
    else if (q.startsWith('select execution_id from run_repeat_executions')) rows = [...state.executions.values()]
      .filter((x) => q.includes('previous_execution_id') ? x.previous === v[0] : x.slot_id === v[0])
      .sort((a, b) => b.record.attempt - a.record.attempt).slice(0, 1).map((x) => ({ execution_id: x.record.id }))
    else if (q.startsWith('select e.record,e.accepted')) {
      const e = state.executions.get(v[0]!)
      if (e && e.record.runId === v[1]) {
        const slot = state.slots.get(e.slot_id)!
        rows = [{ ...e, ...slot, execution_run_id: e.record.runId, execution_node_id: e.record.workflowNodeId,
          execution_agent_id: e.record.agentId, execution_attempt: e.record.attempt,
          execution_occurrence_id: slot.occurrence_id, identity_occurrence_id: slot.occurrence_id,
          technical_attempt: e.record.attempt }]
      }
    }
    else if (q.startsWith('select e.id from harness_executions e')) {
      expect(q).toContain('left join run_repeat_executions')
      expect(q).toContain('order by e.id limit 100 for update of e')
      rows = [...state.executions.values()].filter((e) => e.record.runId === v[0] && e.record.id > v[1]!
        && (v[2] === 'run' || v[2] === 'occurrence' && state.slots.get(e.slot_id)!.occurrence_id === v[3]
          || v[2] === 'slot' && e.slot_id === v[3] && e.record.attempt <= Number(values[4])))
        .sort((a, b) => a.record.id.localeCompare(b.record.id)).slice(0, 100).map((e) => ({ id: e.record.id }))
    }
    else if (q.startsWith("select id,record->>'executionsemanticsversion'")) {
      expect(values).toEqual([f.scope.runId])
      rows = [{ id: f.scope.runId, semantics: '3', workspace_id: f.scope.workspaceId, workflow_id: f.scope.workflowId,
        pins_match: true, negative_cleanup: false }]
    }
    else if (q.startsWith('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
      const e = state.executions.get(v[0]!)
      if (e && e.record.runId === v[1]) rows = [{ id: e.record.id, run_id: e.record.runId,
        workflow_node_id: e.record.workflowNodeId, agent_id: e.record.agentId, attempt: e.record.attempt, record: e.record }]
    }
    else if (q.startsWith('select j.id,j.execution_id,j.state,j.record')) {
      // This semantic repository fixture has no approvals or reviewer jobs.
      expect(q).toContain('i.execution_id=$2 or j.execution_id=$2'); rows = []
    }
    else if (q.startsWith('select i.id,i.execution_id,i.status,i.record')) rows = []
    else if (q.startsWith('select ( exists(select 1 from worker_credential_bindings')) {
      // No credential/budget/reviewer resources are allocated by this SQL model.
      expect(state.native.has(v[0]!)).toBe(true); rows = [{ outstanding: false }]
    }
    else if (q.startsWith('select reference,workflow_finalized_at')) {
      const native = state.native.get(v[0]!)
      if (native) rows = [{ reference: native.session, finalized: native.finalized }]
    }
    else if (q.startsWith('select c.record#>>')) {
      const agent = Object.entries(f.run.agentConfigurationVersionIds).find(([, id]) => id === v[0])?.[0]
      if (agent && v[1] === f.scope.runId) rows = [{ harness: 'codex', agent_id: agent, workspace_id: f.scope.workspaceId, pinned: true }]
    }
    else if (q.startsWith('select c.generation::text,c.execution_identity')) {
      const e = state.executions.get(v[0]!), native = state.native.get(v[0]!)
      if (e && native && e.record.runId === v[1]) rows = [{ generation: '1',
        execution_identity: { id: e.record.id, runId: e.record.runId, workflowNodeId: e.record.workflowNodeId,
          agentId: e.record.agentId, agentConfigurationVersionId: e.record.agentConfigurationVersionId, attempt: e.record.attempt },
        expected_reference: native.session, closed_reference: native.session, record: e.record, reference: native.session,
        closed: native.closed, detached: false, closed_without_session: false, prior_unclosed: false }]
    }
    else if (q.startsWith('select p.generation::text,p.execution_identity,p.reference')) {
      expect(values).toHaveLength(1)
      expect(state.executions.has(v[0]!)).toBe(true)
      expect(q).toContain('from execution_native_recoveries p join execution_native_closures c')
      rows = [] // No recovery receipt is seeded; a terminal enum is still not closure.
    }
    else if (q.startsWith('update execution_native_sessions')) {
      const native = state.native.get(v[0]!)
      if (native && canonicalGraphJson(native.session) === canonicalGraphJson(JSON.parse(v[1]!))) {
        native.finalized = true; rows = [{ execution_id: v[0] }]
      }
    }
    else if (q.startsWith('insert into run_repeat_bindings')) state.bindings.push({ recipient: v[2]!, record: JSON.parse(v[8]!) })
    else if (q.startsWith('select record from run_repeat_bindings')) rows = state.bindings.filter((b) => b.recipient === v[0]).map((b) => ({ record: b.record }))
    else if (q.startsWith('insert into run_repeat_results')) state.results.set(v[0]!, { result_json: v[3]!, result_digest: v[4]! })
    else if (q.startsWith('select result_json,result_digest')) { const row = state.results.get(v[0]!); if (row) rows = [row] }
    else if (q.startsWith('update harness_executions set accepted=true')) state.executions.get(v[0]!)!.accepted = true
    else if (q.startsWith('insert into run_repeat_resolutions')) state.resolutions.set(`${v[1]}:${v[2]}`, JSON.parse(v[5]!))
    else if (q.startsWith('insert into run_repeat_decisions')) state.decisions.set(v[1]!, JSON.parse(v[4]!))
    else if (q.startsWith('select record from run_repeat_decisions') || q.startsWith('select 1 from run_repeat_decisions')) {
      const record = state.decisions.get(v[0]!); if (record) rows = [{ record }]
    } else if (q.startsWith('select record,reserved_successor_execution_id,delivery_id from run_control_continuations')
      || q.includes("from run_chat_commands where run_id=$1 and kind='stop'")) {
      // This semantic repository fixture has no workflow control command, continuation or Stop receipt.
    } else if (/from execution_dispatch_intents where execution_id=\$1/.test(q) || q.startsWith('select record from execution_native_placements where execution_id=$1')) {
      // Main-local executions have no device dispatch intent or native placement.
    } else throw new Error(`Unscripted SQL: ${q}`)
    return { rows, rowCount: rowCount ?? rows.length, command: q.split(' ')[0], fields: [], oid: 0 }
  } }
  const connection = new ExclusiveGraphConnection(client as unknown as pg.ClientBase, () => {
    if (fault === 'owner') throw new Error('RUN_OWNERSHIP_LOST')
  })
  const gate = (name: string) => { events.push(name); if (fault === name) throw new Error(name) }
  const host: RepeatRepositoryHost = { openLocked: async () => ({
    run: state.run,
    assertAuthorityLocked: async () => { gate('authority') }, assertAdmissionLocked: async () => { gate('admission') },
    ...(artifacts === 'enabled' ? { assertWorkflowArtifactOutputsLocked: async () => { gate('artifact.outputs') } } : {}),
    assertSettlementLocked: async () => { gate('settlement') }, allowTechnicalRetryLocked: async () => true,
    publishLocked: async (_sql, effect, _facts, mutate) => {
      gate('publication.before'); await mutate(); gate('publication.after'); state.receipts.set(key(effect.kind, effect.entityId), effect.digest)
    },
    assertPublicationReceiptLocked: async (_sql, effect) => {
      gate('receipt'); if (state.receipts.get(key(effect.kind, effect.entityId)) !== effect.digest) throw new Error('GRAPH_RECEIPT_MISMATCH')
    },
    completeRunLocked: async () => { gate('complete'); state.run.executionState = 'completed' },
  }) }
  const owner = { runId: f.scope.runId, assertOwned: () => { if (fault === 'owner') throw new Error('RUN_OWNERSHIP_LOST') },
    oneShotConnection: () => connection, readOneShotFence: async () => ({ ownerId: 'owner', fence: String(fault === 'generation' ? ++fence : 1) }) }
  const repository = () => new RepeatRunRepository(owner, host, f.version)
  const store = repository()
  const enter = async () => { const result = await store.enterBlock(f.block.id); if (result.kind !== 'active') throw new Error('inactive'); return result.occurrence }
  const admit = async (occ: RepeatOccurrenceV1, node: string) => {
    const result = await store.admit({ nodeId: node, occurrence: occ.identity }, () => execution(f, node, `${node}-${occ.identity.occurrenceIndex}`))
    if (result.kind !== 'admitted') throw new Error(`unexpected ${result.kind}`)
    return result.execution
  }
  const finish = (id: string, output: unknown = {}) => {
    // Explicit native-store fixture data, not a dispatch/ACK capability. The real
    // settlement reader checks the physical binding and positive close below.
    const row = state.executions.get(id)!, nativeSessionId = `synthetic-${id}`
    state.native.set(id, { session: { harness: 'codex', providerVersion: 'unit-no-provider', nativeSessionId }, finalized: false, closed: true })
    row.record = successful({ ...row.record, nativeSessionId }, output)
  }
  const accept = (id: string) => store.acceptTerminal(id, (attempt) => execution(f, state.executions.get(id)!.record.workflowNodeId, `${id}-attempt-${attempt}`, attempt))
  const body = async (occ: RepeatOccurrenceV1, outcome = 'issues') => {
    const work = await admit(occ, 'work'); finish(work.id); await accept(work.id)
    const review = await admit(occ, 'review'); finish(review.id, { routing: { outcome }, data: { latestDeliverable: occ.identity.occurrenceIndex, remainingFindings: [] } })
    await accept(review.id)
    return review.id
  }
  return { f, events, store, repository, connection, owner, enter, admit, finish, accept, body, state: () => state,
    fail: (value: string) => { fault = value }, loseCommit: () => { lostCommit = true } }
}

describe('real repository with PostgreSQL-shaped scripted transactions (not real PostgreSQL)', () => {
  it('gates declared successful acceptance and replay before exposing a result, preserving rollback', async () => {
    const db = postgresShape(3, 'enabled'), occ = await db.enter(), work = await db.admit(occ, 'work')
    db.finish(work.id)
    db.fail('artifact.outputs')
    await expect(db.accept(work.id)).rejects.toThrow('artifact.outputs')
    expect(db.state().results.has(work.id)).toBe(false)
    expect(db.state().executions.get(work.id)!.accepted).toBe(false)
    db.fail(''); await db.accept(work.id)
    expect(db.state().results.has(work.id)).toBe(true)
    db.fail('artifact.outputs')
    await expect(db.repository().acceptTerminal(work.id)).rejects.toThrow('artifact.outputs')
    expect(db.state().results.has(work.id)).toBe(true)
  })
  it('fails closed when declared outputs lack the SQL-only acceptance capability', async () => {
    const db = postgresShape(3, 'missing'), occ = await db.enter(), work = await db.admit(occ, 'work')
    db.finish(work.id)
    await expect(db.accept(work.id)).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_UNAVAILABLE' })
    expect(db.state().results.has(work.id)).toBe(false)
  })
  it('atomically records accepted exit, route, decision and successor; replay is duplicate-free', async () => {
    const db = postgresShape(), first = await db.enter(), exitId = await db.body(first)
    const count = [db.state().occurrences.size, db.state().effects.size, db.state().executions.size]
    const boundary = await db.store.transition(first.identity.occurrenceId)
    expect(boundary.next!.identity.occurrenceIndex).toBe(2)
    await db.repository().acceptTerminal(exitId, () => { throw new Error('must not allocate') })
    await db.store.transition(first.identity.occurrenceId)
    expect([db.state().occurrences.size, db.state().effects.size, db.state().executions.size]).toEqual(count)
    expect(db.state().resolutions.has(':review')).toBe(false)
    expect(db.state().results.has(exitId)).toBe(true)
  })
  it('rejects a saved occurrence or queued execution whose canonical publication receipt is missing', async () => {
    const db = postgresShape(), occ = await db.enter(), work = await db.admit(occ, 'work')
    const saved = new Map(db.state().receipts)
    db.state().receipts.delete(`input.bind:${work.id}`)
    await expect(db.store.readExecution(work.id)).rejects.toThrow('GRAPH_RECEIPT_MISMATCH')
    db.state().receipts = saved
    db.state().receipts.delete(`occurrence.create:${occ.identity.occurrenceId}`)
    await expect(db.admit(occ, 'work')).rejects.toThrow('GRAPH_RECEIPT_MISMATCH')
  })
  it('rolls back accepted result, successor, route and receipt if canonical publication fails', async () => {
    const db = postgresShape(), occ = await db.enter(), work = await db.admit(occ, 'work')
    db.finish(work.id); await db.accept(work.id)
    const review = await db.admit(occ, 'review')
    db.finish(review.id, { routing: { outcome: 'issues' }, data: { latestDeliverable: 'draft', remainingFindings: [] } })
    db.fail('publication.after')
    await expect(db.accept(review.id)).rejects.toThrow('publication.after')
    expect(db.state().occurrences.size).toBe(1)
    expect(db.state().decisions.size).toBe(0)
    expect(db.state().results.has(review.id)).toBe(false)
    expect(db.state().executions.get(review.id)!.accepted).toBe(false)
    db.fail(''); await db.accept(review.id)
    expect(db.state().occurrences.size).toBe(2)
  })
  it.each(['owner', 'generation', 'authority', 'admission'])('fences %s before an occurrence/execution mutation', async (fault) => {
    const db = postgresShape()
    if (fault === 'admission') {
      const occ = await db.enter(); db.fail(fault)
      await expect(db.admit(occ, 'work')).rejects.toThrow()
      expect(db.state().executions.size).toBe(0)
    } else {
      db.fail(fault); await expect(db.enter()).rejects.toThrow()
      expect(db.state().occurrences.size).toBe(0)
    }
  })
  it('does not treat an already recorded repeat decision as launch permission after Stop', async () => {
    const db = postgresShape(), first = await db.enter(); await db.body(first)
    const next = (await db.store.transition(first.identity.occurrenceId)).next!
    db.state().stopped = true
    await expect(db.store.transition(first.identity.occurrenceId)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    await expect(db.admit(next, 'work')).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect(db.state().executions.size).toBe(2)
  })
  it('holds result acceptance and successor creation while approval/cleanup settlement is pending', async () => {
    const db = postgresShape(), occ = await db.enter(), work = await db.admit(occ, 'work')
    db.finish(work.id); db.fail('settlement')
    await expect(db.accept(work.id)).rejects.toThrow('settlement')
    expect(db.state().results.size).toBe(0)
    expect(db.state().occurrences.size).toBe(1)
  })
  it('never reruns a callback on ambiguous COMMIT and marks the dedicated connection unusable', async () => {
    const db = postgresShape(); db.loseCommit()
    await expect(db.enter()).rejects.toThrow('COMMIT reply lost')
    expect(db.state().occurrences.size).toBe(1)
    expect(db.connection.unusable).toBe(true)
    await expect(db.enter()).rejects.toThrow()
    expect(db.events.filter((event) => event === 'publication.before')).toHaveLength(1)
  })
  it('retries a negatively settled technical failure with identical input inside its occurrence', async () => {
    const db = postgresShape(), occ = await db.enter(), work = await db.admit(occ, 'work')
    db.finish(work.id)
    const row = db.state().executions.get(work.id)!
    row.record = HarnessExecutionSchema.parse({ ...row.record, state: 'completed', finishedAt: at,
      result: { outcome: 'failed', error: { code: 'TEMPORARY', message: 'synthetic', retryable: true } } })
    const result = await db.accept(work.id)
    expect(result.kind).toBe('retry')
    if (result.kind !== 'retry') throw new Error('retry expected')
    expect(result.execution.attempt).toBe(2)
    expect(result.execution.input).toEqual(work.input)
    expect(db.state().occurrences.size).toBe(1)
    expect(db.state().executions.get(result.execution.id)!.slot_id).toBe(row.slot_id)
    expect(db.state().results.has(work.id)).toBe(false)
  })
  it('replays completed Run only against the exact existing completion and publication receipt', async () => {
    const db = postgresShape(1), occ = await db.enter(); await db.body(occ, 'pass')
    for (const node of ['done', 'limit']) {
      const admission = await db.store.admit({ nodeId: node, occurrence: null }, () => execution(db.f, node, `final-${node}`))
      if (admission.kind === 'admitted') { db.finish(admission.execution.id); await db.accept(admission.execution.id) }
    }
    await db.store.completeRun(); await db.repository().completeRun()
    expect(db.events.filter((event) => event === 'complete')).toHaveLength(1)
    db.state().receipts.delete(`run.complete:${db.f.scope.runId}`)
    await expect(db.store.completeRun()).rejects.toThrow('GRAPH_RECEIPT_MISMATCH')
  })
  it.each(['SOURCE_MATERIALIZATION_UNCERTAIN', 'HARNESS_PROFILE_UNAVAILABLE'])(
    're-observes interrupted interval preparation without ending the Run: %s', async code => {
      const f = fixture(1)
      const node = f.version.definition.nodes[0]!
      if (node.kind === 'job') throw new Error('Expected an Agent node.')
      node.interval = { everySeconds: 60 }
      const queued = execution(f, node.id, 'queued-interval')
      const failure = new DomainError(code, 'The queued interval cannot finish preparation.', 409)
      let tracked!: Promise<unknown>
      let observations = 0
      let finished = false
      const stop = startIntervalChecks({ version: f.version, signal: new AbortController().signal,
        store: { admitTick: async () => ({ kind: 'busy', execution: queued }) },
        driver: { candidate: () => queued, observe: async observed => {
          expect(observed).toBe(queued)
          if (++observations === 1) throw failure
        } },
        track: task => { tracked = task.then(() => { finished = true }) } })
      try {
        await vi.waitFor(() => expect(observations).toBe(2), { timeout: 8_000 })
        expect(finished).toBe(false)
        expect(queued.state).toBe('queued')
      } finally {
        stop()
        await tracked
      }
      expect(finished).toBe(true)
    },
  )
  it.each([
    new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'Source preparation was interrupted before activation.'),
    new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The saved native qualification is unavailable.', 409),
  ])('settles queued work after a launch preparation refusal: $code', async failure => {
    const db = postgresShape(1)
    const calls: string[] = []
    const cleanupResults: unknown[] = []
    let observations = 0
    await expect(executeRepeatRuntime({
      runId: db.f.scope.runId, version: db.f.version, store: db.store, owner: db.owner,
      signal: new AbortController().signal, checkpointer: new MemorySaver(),
      lifecycle: {
        preflight: async () => {}, markRunning: async () => {}, persistWait: async () => false,
        currentState: async () => ({ executionState: db.state().run.executionState, stopRequested: false }),
        requestCleanup: async result => {
          calls.push('cleanup')
          cleanupResults.push(result)
        },
        cancelNativeAndRequestCleanup: async () => { calls.push('cancel'); return true },
        settleRun: async () => {
          calls.push('settle')
          db.state().run.executionState = 'completed'
        },
        finishNative: async () => { calls.push('finish native') },
        finishCleanup: async () => { calls.push('finish cleanup') },
      },
      driver: {
        candidate: (ref, attempt) => execution(db.f, ref.nodeId, 'timed-out-agent', attempt),
        observe: async () => {
          observations++
          throw failure
        },
      },
    })).rejects.toBe(failure)
    expect(observations).toBe(1)
    expect(calls.indexOf('cleanup')).toBeLessThan(calls.indexOf('cancel'))
    expect(cleanupResults).toContainEqual({ outcome: 'failed',
      error: { code: failure.code, message: failure.message, retryable: false } })
    expect(calls).toContain('cancel')
    expect(calls).toContain('settle')
    expect(calls.slice(-2)).toEqual(['finish native', 'finish cleanup'])
    expect(db.state().run.executionState).toBe('completed')
    expect([...db.state().executions.values()].map(row => row.record.workflowNodeId)).toEqual(['work'])
  })
  it('leaves the Run running for a retry after a transient launch preparation timeout', async () => {
    const db = postgresShape(1)
    const calls: string[] = []
    const failure = new DomainError('APP_MCP_PREFLIGHT_TIMEOUT', 'MCP inspection timed out.', 409)
    let observations = 0
    await expect(executeRepeatRuntime({
      runId: db.f.scope.runId, version: db.f.version, store: db.store, owner: db.owner,
      signal: new AbortController().signal, checkpointer: new MemorySaver(),
      lifecycle: {
        preflight: async () => {}, markRunning: async () => {}, persistWait: async () => false,
        currentState: async () => ({ executionState: db.state().run.executionState, stopRequested: false }),
        requestCleanup: async () => { calls.push('cleanup') },
        cancelNativeAndRequestCleanup: async () => { calls.push('cancel'); return true },
        settleRun: async () => { calls.push('settle') },
        finishNative: async () => { calls.push('finish native') },
        finishCleanup: async () => { calls.push('finish cleanup') },
      },
      driver: {
        candidate: (ref, attempt) => execution(db.f, ref.nodeId, 'timed-out-agent', attempt),
        observe: async () => {
          observations++
          throw failure
        },
      },
    })).rejects.toBe(failure)
    expect(observations).toBe(1)
    // The transient refusal fences neither the Run nor its other work; the engine retries the same checkpoint.
    expect(calls).toEqual([])
    expect(db.state().run.executionState).not.toBe('completed')
  })
  it('runs repeated static barriers on the existing LangGraph checkpointer and does not release final nodes early', async () => {
    const db = postgresShape(2), signal = new AbortController().signal, calls: string[] = []
    let nextId = 0
    await executeRepeatRuntime({ runId: db.f.scope.runId, version: db.f.version, store: db.store, owner: db.owner, signal, checkpointer: new MemorySaver(),
      lifecycle: { preflight: async () => {}, markRunning: async () => {}, persistWait: async () => false,
        currentState: async () => ({ executionState: db.state().run.executionState, stopRequested: db.state().stopped }),
        cancelNativeAndRequestCleanup: async () => { throw new Error('unexpected cancellation') },
        settleRun: async () => { throw new Error('unexpected settlement') },
        requestCleanup: async () => { calls.push('cleanup.requested') }, finishNative: async () => { calls.push('cleanup.native') },
        finishCleanup: async () => { calls.push('cleanup.finished') } },
      driver: { candidate: (ref, attempt) => execution(db.f, ref.nodeId, `graph-${++nextId}`, attempt), observe: async (e) => {
        const stored = await db.store.readExecution(e.id); const index = stored.ref.occurrence?.occurrenceIndex ?? 0
        calls.push(`${e.workflowNodeId}:${index}`)
        db.finish(e.id, e.workflowNodeId === 'review' ? { routing: { outcome: 'issues' }, data: { latestDeliverable: index, remainingFindings: [{ id: 'f1' }] } } : {})
      } } })
    expect(calls).toEqual(['work:1', 'review:1', 'work:2', 'review:2', 'limit:0', 'cleanup.requested', 'cleanup.native', 'cleanup.finished'])
    expect(db.state().occurrences.size).toBe(2)
  })
  it('queues an exact reserved native entry once and reuses it without granting a launch', async () => {
    const db = postgresShape(), occurrence = await db.enter(), work = await db.admit(occurrence, 'work')
    const before = structuredClone(db.state().nativeEntries.get(work.id))
    expect(before?.phase).toBe('reserved')
    expect(before?.reservation.inputDigest).toBe(repeatDigest(work.input))
    expect(before?.reservation.ref.occurrence).toEqual(occurrence.identity)
    expect(await db.admit(occurrence, 'work')).toEqual(work)
    expect(db.state().nativeEntries.size).toBe(1)
    expect(db.state().nativeEntries.get(work.id)).toEqual(before)
    expect(db.store.consumeLaunchPermit(work.id)).toBe(false)
    expect(db.events.filter((q) => q.startsWith('insert into workflow_native_entries'))).toHaveLength(1)
  })
  it('rolls back native reservation, input slot and execution together on failed admission publication', async () => {
    const db = postgresShape(), occurrence = await db.enter()
    const before = structuredClone(db.state())
    db.fail('publication.after')
    await expect(db.admit(occurrence, 'work')).rejects.toThrow('publication.after')
    expect(db.state()).toEqual(before)
    db.fail('')
    const work = await db.admit(occurrence, 'work')
    expect(db.state().nativeEntries.size).toBe(1)
    expect(db.state().nativeEntries.get(work.id)?.phase).toBe('reserved')
  })
  it('a terminal enum without a positive close cannot pass concrete settlement or accept a result', async () => {
    const db = postgresShape(), occurrence = await db.enter(), work = await db.admit(occurrence, 'work')
    db.finish(work.id)
    db.state().native.get(work.id)!.closed = false
    await expect(db.accept(work.id)).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(db.state().executions.get(work.id)!.accepted).toBe(false)
    expect(db.state().results.size).toBe(0)
    expect(db.state().native.get(work.id)!.finalized).toBe(false)
    expect(db.state().occurrences.size).toBe(1)
  })
})
