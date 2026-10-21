import type { PublicProjectionReader } from '../src/modules/run-graph/publicProjectionReader.js'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { CURRENT_NATIVE_ACTIVITIES_SQL } from '../src/modules/run-graph/currentActivity.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { GraphRunStateSchema, type RepeatGraphScopeV3, type RepeatGraphFactV3, type RepeatGraphEffectV3, type PublicGraphProjection } from '@foreman-code/contracts/wave25'
import { graphSourceDigest, openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

export const projectionScope: RepeatGraphScopeV3 = { workspaceId: 'ws', workflowId: 'wf', workflowVersionId: 'v3', runId: 'run', executionSemanticsVersion: 3 }
export const projectionDigest = `sha256:${'a'.repeat(64)}`
export function occurrenceFact(id = 'one'): RepeatGraphFactV3 {
  return { type: 'repeat.occurrence', occurrence: { contractVersion: 1,
    identity: { scope: projectionScope, blockId: `block-${id}`, occurrenceId: `occ-${id}`, occurrenceIndex: 1 },
    input: { bindingId: `binding-${id}`, inputDigest: projectionDigest, previous: null } } }
}
export function publicationInput(id = 'one') {
  const effect: RepeatGraphEffectV3 = { identity: { kind: 'input.bind', entityId: `effect-${id}` }, digest: projectionDigest,
    operation: 'occurrence.create', subjectId: `occ-${id}` }
  return { evidence: { sourceKind: 'input_binding' as const, sourceId: `source-${id}`, sourceRevision: '1' }, sourceDigest: projectionDigest, effect }
}
interface Source { source_kind: string; source_id: string; source_revision: string; source_digest: string; semantic_digest: string; first_sequence: string }
interface Effect { effect_kind: string; entity_id: string; effect_digest: string; semantic_digest: string; first_sequence: string }
interface Batch { sequence: string; kind: string; payload: string | null; payload_bytes: number; batch_id: string }
interface State { head: number; floor: number; domain: number; stopped: boolean; executionState: string; outcome: string;
  sources: Source[]; effects: Effect[]; batches: Batch[]; cleanupPending: boolean;
  projection: { record: PublicGraphProjection; source_digest: string; semantic_digest: string; sequence: string } | null }

/** Strict SQL-shaped transaction model. It is NOT PostgreSQL, an authenticated
 * owner, native execution, a real constraint/lock test or a production adapter.
 * Unknown SQL is an error. The actual transaction facade/publication/receipt
 * verifier/page reader execute against this model, without a fake receipt hook. */
export class ProjectionDatabase {
  constructor(readonly readPublicProjection: PublicProjectionReader = readPublicProjectionLocked) {}
  state: State = { head: 0, floor: 0, domain: 0, stopped: false, executionState: 'queued', outcome: 'pending', sources: [], effects: [], batches: [], cleanupPending: false, projection: null }
  scope = { ...projectionScope } as { workspaceId: string; workflowId: string; workflowVersionId: string; runId: string; executionSemanticsVersion: number }
  initialized = false
  fresh = false
  protocolVersion = 1
  readonly fixture = (() => {
    const f = currentUnitSnapshot('projection', 'single')
    const version = { ...f.version, id: projectionScope.workflowVersionId, workspaceId: projectionScope.workspaceId,
      workflowId: projectionScope.workflowId, definition: { ...f.version.definition,
        id: projectionScope.workflowId, workspaceId: projectionScope.workspaceId } }
    version.contentHash = graphSourceDigest({ definition: version.definition,
      configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
    return { ...f, version, scope: projectionScope,
      run: { ...f.run, id: projectionScope.runId, workspaceId: projectionScope.workspaceId,
        workflowId: projectionScope.workflowId, workflowVersionId: projectionScope.workflowVersionId },
      configurations: f.configurations.map((row) => ({ ...row, workspaceId: projectionScope.workspaceId })) }
  })()
  private run(s: State) {
    return { ...this.fixture.run, executionState: s.executionState, outcome: s.outcome,
      ...(s.executionState === 'completed' ? { finishedAt: this.fixture.createdAt, result: { outcome: s.outcome } } : {}) }
  }
  runState() {
    return GraphRunStateSchema.parse({ executionState: this.state.executionState, outcome: this.state.outcome,
      stopRequested: this.state.stopped, cleanupPending: this.state.cleanupPending,
      pendingInteractionCount: 0, unsettledReviewCount: 0 })
  }
  private pinnedRows(s: State) {
    this.protectedMetadataReads++
    const version = this.fixture.version
    return [{ workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
      workflow_version_id: this.scope.workflowVersionId, execution_state: s.executionState,
      execution_semantics_version: this.scope.executionSemanticsVersion, version_id: version.id,
      version_number: version.version, entry_node_id: version.entryNodeId, run_record: this.run(s), version_record: version,
      version_workspace_id: version.workspaceId, version_workflow_id: version.workflowId,
      configurations: this.fixture.configurations.map(record => ({ id: record.id,
        workspace_id: record.workspaceId, agent_id: record.agentId, version: record.version, record })) }]
  }
  private projectionRows(s: State, values: unknown[], pins?: ReturnType<ProjectionDatabase['pinnedRows']>) {
    assert.ok(this.fixture.version.definition.nodes.every(node => node.kind !== 'job'),
      'this fixture has no Job preparations')
    const found = values[0] === this.scope.runId
    const matchesScope = found && values[2] === this.scope.workflowVersionId
      && values[3] === this.scope.workspaceId && values[4] === this.scope.workflowId
    return {
      ...(pins === undefined ? {} : { pins: found ? pins : [] }),
      nodeRun: found ? [{ closed: s.stopped || ['completed', 'interrupted'].includes(s.executionState),
        cleanup_pending: s.cleanupPending }] : [],
      runState: matchesScope ? [{ execution_state: s.executionState, outcome: s.outcome,
        stopped: s.stopped, cleanup_pending: s.cleanupPending }] : [],
      executions: [], jobs: [], attention: [], native: [], interactions: [], reviews: [], resolutions: [], bindings: [],
    }
  }
  /** Actual canonical admission/finalization, not hand-written receipt success.
   * The one ordinary node has no admitted execution, history or native resources.
   * Generic journal producer callbacks below remain explicit unit-test ports. */
  async initialize(): Promise<void> {
    assert.equal(this.initialized, false, 'initialization is explicit, never a read fallback')
    this.fresh = true
    const c = this.connection()
    try {
      await c.transaction(async (sql) => {
        const publication = await openRunGraphPublication(sql, projectionScope, this.readPublicProjection, { historyCoverage: 'from_admission' })
        await publication.repeatInsertedRunReadback(this.fixture.run)
      })
      assert.equal(this.state.head, 1)
    } finally { this.fresh = false; await c.close() }
    this.calls.length = 0
    this.transactions.length = 0
    this.protectedMetadataReads = 0
    this.historyBodyReads = 0
    this.headReads = 0
    this.scopeReads = 0
    this.writes = 0
  }
  /** Exercise the real publisher's before/after Run and public-projection checks. */
  async changeRun(patch: { stopped?: boolean; executionState?: string; outcome?: string; cleanupPending?: boolean }) {
    const c = this.connection()
    try { await c.transaction(async (sql) => {
      await openRunGraphPublication(sql, projectionScope, this.readPublicProjection)
      await sql.query('update projection_test_run set fields=$1', [patch])
    }) } finally { await c.close() }
  }
  ownerLost = false
  ownerFence = '100'
  onInsertSource: (() => void) | undefined
  onInsertEffect: ((effect: Effect) => void) | undefined
  unknownCommit = false
  calls: string[] = []
  transactions: Array<{ readOnly: boolean; isolation: string; outcome: 'pending' | 'committed' | 'rolled-back' }> = []
  protectedMetadataReads = 0
  historyBodyReads = 0
  headReads = 0
  scopeReads = 0
  writes = 0
  assertNoProtectedGraphReads(): void {
    assert.equal(this.headReads, 0)
    assert.equal(this.protectedMetadataReads, 0)
    assert.equal(this.historyBodyReads, 0)
  }
  readonly owner = { runId: projectionScope.runId, assertOwned: () => { if (this.ownerLost) throw new Error('RUN_OWNERSHIP_LOST') },
    readOneShotFence: async (sql: GraphTransactionSql) => {
      const row = (await sql.query<{ owner_id: string; fence: string }>('select projection_test_owner_fence')).rows[0]
      assert.ok(row); return { ownerId: row.owner_id, fence: row.fence }
    } } as unknown as RunOwnership
  connect() {
    let transaction: State | null = null
    let observedTransaction: typeof this.transactions[number] | undefined
    let initializedBefore = this.initialized
    const client = new EventEmitter() as EventEmitter & { query: pg.ClientBase['query']; release: () => void }
    client.release = () => undefined
    client.query = (async (text: string, values: unknown[] = []) => {
      const q = text.replace(/\s+/g, ' ').trim(), s = transaction ?? this.state
      this.calls.push(q)
      if (/^(insert|update|delete)\b/.test(q)) this.writes++
      // Count attempted reads before any handler can return, including empty results and proof/header lookups.
      if (/\b(?:from|join) run_graph_(?:heads|sources|effects|public_projection)\b/.test(q)) this.headReads++
      if (/\b(?:from|join) run_graph_batches\b/.test(q)) this.historyBodyReads++
      const result = (rows: unknown[] = []) => ({ rows: structuredClone(rows), rowCount: rows.length, command: '', oid: 0, fields: [] })
      if (q.startsWith('begin ')) {
        observedTransaction = { readOnly: q.endsWith('read only'),
          isolation: q.includes('repeatable read') ? 'repeatable read' : 'other', outcome: 'pending' }
        this.transactions.push(observedTransaction)
        initializedBefore = this.initialized
        assert.equal(transaction, null)
        transaction = structuredClone(this.state)
        return result()
      }
      if (q === 'commit') {
        if (observedTransaction) observedTransaction.outcome = 'committed'
        assert.ok(transaction)
        this.state = transaction
        transaction = null
        if (this.unknownCommit) {
          this.unknownCommit = false
          throw new Error('COMMIT reply lost')
        }
        return result()
      }
      if (q === 'rollback') {
        if (observedTransaction) observedTransaction.outcome = 'rolled-back'
        if (transaction) this.initialized = initializedBefore
        transaction = null
        return result()
      }
      if (q.startsWith('with pins as materialized')) {
        return result([this.projectionRows(s, values, this.pinnedRows(s))])
      }
      if (q.startsWith('with projection_nodes as materialized')) {
        return result([this.projectionRows(s, values)])
      }
      if (q === 'select projection_test_owner_fence') return result([{ owner_id: '42', fence: this.ownerFence }])
      if (q === 'update projection_test_domain set revision=revision+1') { s.domain++; return result() }
      if (q.startsWith('select effect_kind,entity_id,payload_digest from run_repeat_effects')) return result([])
      if (q.startsWith("select p.preparation->>'executionId' as id,s.workflow_node_id,n.node->>'jobDefinitionId' as definition_id,")) {
        assert.deepEqual(values, [projectionScope.runId, this.fixture.version.definition.nodes.map(node => node.id),
          projectionScope.workflowVersionId, projectionScope.workspaceId, projectionScope.workflowId])
        assert.ok(this.fixture.version.definition.nodes.every(node => node.kind !== 'job'), 'this fixture has no Job preparations')
        return result([])
      }
      if (q.startsWith('select p.ordinal,')) {
        const expected = JSON.parse(String(values[2])) as Array<{ ordinal: number; source_kind: string; source_revision: string; source_id: string | null;
          source_digest: string | null; semantic_digest: string; effect_kind: string | null; entity_id: string | null }>
        return result(expected.map(p => {
          const source = s.sources.find(x => x.source_kind === p.source_kind && String(x.source_revision) === p.source_revision && x.semantic_digest === p.semantic_digest
            && (p.source_id === null || x.source_id === p.source_id) && (p.source_digest === null || x.source_digest === p.source_digest)
            && BigInt(x.first_sequence) > 0n && BigInt(x.first_sequence) <= BigInt(String(values[1])))
          const effect = s.effects.find(x => x.effect_kind === p.effect_kind && x.entity_id === p.entity_id)
          return { ordinal: p.ordinal, source_id: source?.source_id ?? null, source_digest: source?.source_digest ?? null,
            semantic_digest: source?.semantic_digest ?? null, first_sequence: source?.first_sequence ?? null,
            effect_digest: effect?.effect_digest ?? null, effect_semantic_digest: effect?.semantic_digest ?? null, effect_sequence: effect?.first_sequence ?? null }
        }))
      }
      if (q.startsWith('select p.record,p.source_digest,p.semantic_digest,p.sequence::text,')) {
        if (!s.projection) return result()
        const source = s.sources.find((row) => row.source_kind === 'run' && row.source_id === values[1]
          && row.source_revision === s.projection!.sequence)
        return result([{ ...s.projection, proof_sequence: source?.first_sequence ?? null,
          proof_source_digest: source?.source_digest ?? null, proof_semantic_digest: source?.semantic_digest ?? null }])
      }
      if (q.includes('join run_graph_sources s')) {
        const source = s.sources.find(x => x.source_kind === values[1] && x.source_id === values[2] && String(x.source_revision) === values[3])
        const effect = s.effects.find(x => x.effect_kind === values[4] && x.entity_id === values[5])
        return result(source ? [{ workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
          workflow_version_id: this.scope.workflowVersionId, execution_semantics_version: this.scope.executionSemanticsVersion,
          protocol_version: 1, head_sequence: String(s.head), source_digest: source.source_digest,
          source_semantic_digest: source.semantic_digest, source_sequence: source.first_sequence,
          effect_digest: effect?.effect_digest ?? null, effect_semantic_digest: effect?.semantic_digest ?? null,
          effect_sequence: effect?.first_sequence ?? null }] : [])
      }
      if (q === 'update projection_test_run set fields=$1') { Object.assign(s, values[0]); return result() }
      if (q.startsWith('insert into run_graph_heads')) { assert.equal(this.fresh, true); this.initialized = true; return result() }
      if (q.startsWith('select protocol_version,head_sequence::text as sequence')) return result(this.initialized
        ? [{ protocol_version: this.protocolVersion, sequence: String(s.head) }] : [])
      if (q.startsWith('select xmin=pg_current_xact_id_if_assigned()')) return result([{ fresh: this.fresh }])
      if (q.startsWith('select record,workspace_id,workflow_id,workflow_version_id,execution_state')) return result([{
        record: this.run(s), workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
        workflow_version_id: this.scope.workflowVersionId, execution_state: s.executionState, stopped: s.stopped,
        written_here: true, created_here: this.fresh }])
      if (q.startsWith('select head_sequence::text')) return result(this.initialized ? [{ sequence: String(s.head), head_sequence: String(s.head) }] : [])
      if (q.startsWith('select h.head_sequence::text,latest.source_revision')) {
        const latest = s.sources.filter((row) => row.source_kind === 'run' && row.source_id === values[0])
          .sort((a, b) => Number(b.source_revision) - Number(a.source_revision))[0]
        return result(this.initialized ? [{ head_sequence: String(s.head), source_revision: null,
          source_digest: null, semantic_digest: null, first_sequence: null, ...latest }] : [])
      }
      if (q.startsWith('select s.source_revision::text,s.source_digest')) return result(s.sources
        .filter((row) => row.source_kind === 'run' && row.source_id === values[0])
        .sort((a, b) => Number(b.source_revision) - Number(a.source_revision)).slice(0, 1))
      if (q.startsWith('select r.execution_state,r.record')) return result([{ execution_state: s.executionState,
        outcome: s.outcome, stopped: s.stopped, cleanup_pending: s.cleanupPending }])
      if (q.startsWith('select not exists(select 1 from harness_executions')) return result([{ empty: s.head === 0 && !s.sources.length }])
      if (q.startsWith('select 1 where exists(select 1 from harness_executions')) return result()
      if (q.startsWith('insert into run_graph_public_projection')) {
        s.projection = { record: JSON.parse(String(values[2])), source_digest: String(values[3]),
          semantic_digest: String(values[4]), sequence: String(values[1]) }; return result()
      }
      if (q.startsWith('select r.workspace_id,r.workflow_id,r.workflow_version_id,r.execution_state')) {
        return result(this.pinnedRows(s))
      }
      if (q.startsWith('select r.stop_requested_at is not null')) return result([{ closed: s.stopped
        || ['completed', 'interrupted'].includes(s.executionState), cleanup_pending: s.cleanupPending }])
      if (q.startsWith('select workspace_id,workflow_id,id from runs')) {
        this.scopeReads++
        return result(values[0] === this.scope.runId
          ? [{ id: this.scope.runId, workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId }] : [])
      }
      // Empty, ordinary workflow cut. Each named query is an explicit physical
      // table read: no catch-all SELECT branch, native proof or history fallback.
      if (q === CURRENT_NATIVE_ACTIVITIES_SQL.replace(/\s+/g, ' ').trim()) return result()
      for (const prefix of [
        'select distinct on (e.workflow_node_id) e.id',
        'select d.record from run_repeat_resolutions',
        'with interactions as ( select e.workflow_node_id as node_id,count(*)::text,',
        'select b.record,b.bound_at from run_repeat_bindings',
        'select i.record from durable_interactions',
        'select j.record,j.revision::text,i.record as interaction_record',
        'select occurrence_id,workspace_id,workflow_id,workflow_version_id,block_id',
        'select x.execution_id,x.run_id,x.slot_id,x.occurrence_id,x.technical_attempt',
        'select binding_id,recipient_execution_id,source_execution_id,',
        'select occurrence_key,workflow_node_id,source_occurrence_id,execution_id,record',
        'select execution_id,occurrence_id,result_digest from run_repeat_results',
        "select decision_id,occurrence_id,exit_execution_id,result_digest,record-'resultData' as metadata",
      ]) if (q.startsWith(prefix)) return result()
      if (q.startsWith('select r.workspace_id')) return result([{ workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
        workflow_version_id: this.scope.workflowVersionId, execution_semantics_version: this.scope.executionSemanticsVersion,
        has_job_nodes: this.fixture.version.definition.nodes.some(node => node.kind === 'job') }])
      if (q.startsWith('select h.head_sequence')) {
        return result(values[0] !== this.scope.runId || values[1] !== this.scope.workspaceId
          || values[2] !== this.scope.workflowId || values[3] !== this.scope.workflowVersionId
          || this.scope.executionSemanticsVersion !== 3 ? [] : [{ head_sequence: this.initialized ? String(s.head) : null,
          retention_floor: String(s.floor), protocol_version: this.protocolVersion, history_coverage: 'from_admission' }])
      }
      if (q.startsWith('select protocol_version from run_graph_heads')) return result(this.initialized ? [{ protocol_version: 1 }] : [])
      if (q.startsWith('select execution_state,')) return result([{ execution_state: s.executionState, stopped: s.stopped, outcome: s.outcome }])
      if (q.startsWith('select source_digest,semantic_digest')) return result(s.sources.filter(x => x.source_kind === values[1]
        && x.source_id === values[2] && String(x.source_revision) === values[3]))
      if (q.startsWith('select effect_digest,semantic_digest')) return result(s.effects.filter(x => x.effect_kind === values[1] && x.entity_id === values[2]))
      if (q.startsWith('update run_graph_heads')) return result([{ head_sequence: String(++s.head) }])
      if (q.startsWith('insert into run_graph_batches')) {
        s.batches.push({ sequence: String(values[1]), batch_id: String(values[2]), kind: String(values[3]),
          payload: values[4] as string | null, payload_bytes: typeof values[4] === 'string' ? Buffer.byteLength(values[4]) : 0 }); return result()
      }
      if (q.startsWith('insert into run_graph_sources')) {
        const rows = JSON.parse(String(values[1])) as Source[]
        for (const row of rows) { assert.ok(!s.sources.some(x => x.source_kind === row.source_kind && x.source_id === row.source_id
          && x.source_revision === row.source_revision)); s.sources.push({ ...row,
            first_sequence: row.first_sequence ?? String(s.head + 1) }) }
        this.onInsertSource?.(); return result()
      }
      if (q.startsWith('insert into run_graph_effects')) {
        for (const row of JSON.parse(String(values[2])) as Omit<Effect, 'first_sequence'>[]) {
          assert.ok(!s.effects.some(x => x.effect_kind === row.effect_kind && x.entity_id === row.entity_id))
          const effect = { ...row, first_sequence: String(values[1]) }
          s.effects.push(effect)
          this.onInsertEffect?.(effect)
        } return result()
      }
      if (q.startsWith('select b.sequence::text,b.kind,b.payload_bytes')) return result(s.batches
        .filter(x => BigInt(x.sequence) > BigInt(String(values[1])) && BigInt(x.sequence) <= BigInt(String(values[2])))
        .sort((a,b) => Number(a.sequence)-Number(b.sequence)).slice(0, Number(values[3])))
      if (q.startsWith('select b.sequence::text,b.payload')) {
        return result(s.batches.filter(x => (values[1] as string[]).includes(x.sequence))
          .sort((a,b) => Number(a.sequence)-Number(b.sequence)))
      }
      throw new Error(`Unmodelled SQL: ${q}`)
    }) as pg.ClientBase['query']
    return client
  }
  connection(): ExclusiveGraphConnection {
    return new ExclusiveGraphConnection(this.connect() as unknown as pg.ClientBase, () => this.owner.assertOwned())
  }
  pool(): pg.Pool { return { connect: async () => this.connect() } as unknown as pg.Pool }
}
