import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type pg from 'pg'
import {
  AcceptedWorkflowRunV3Schema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, canonicalGraphJson,
  type AcceptedWorkflowRunV3,
} from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotSchema, type RunBoardSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { beforeGraphCommit } from '../src/modules/run-graph/connection.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import type { RepeatStartPublication } from '../src/modules/runs/repeatStartAdmission.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

/** Synthetic records, not an authenticated/native/DB fixture. All IDs and paths
 * are test data. The real schemas, immutable readers and G1 facade remain used. */
export function startFixture() {
  const f = makeCurrentWorkflowFixture('eng04-start-native3')
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = WorkflowVersionV3Schema.parse({ ...f.version, id: `${f.version.id}-v3`, executionSemanticsVersion: 3,
    definition: { ...f.version.definition, executionSemanticsVersion: 3,
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  version.contentHash = repeatDigest({ definition: version.definition,
    configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
  const location = { runnerId: 'runner-start-test', rootPath: '/synthetic/start-project', locationRevision: 4,
    identityHash: `sha256:${createHash('sha256').update('1:2').digest('hex')}` }
  const principal: ManagementPrincipal = { id: 'principal-start-test', name: 'Synthetic Start caller', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [
      { actions: ['runs:start', 'runs:read'], scope: { workspaceIds: [version.workspaceId], workflowIds: [version.workflowId] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [version.workspaceId] } },
    ] }
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, workflowVersionId: version.id, executionSemanticsVersion: 3,
    executionState: 'queued', outcome: 'pending', input: {}, executionLocation: location,
    authorizationPrincipalId: principal.id, approval: version.approval })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const, commandId: 'command-start-test', expectedWorkflowRevision: 7,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: 4, input: {} }
  const locationRow = { id: version.workspaceId, execution_location: { runnerId: location.runnerId, rootPath: location.rootPath },
    execution_location_identity: { device: '1', inode: '2' }, location_revision: '4', archived_at: null }
  const workflow = { id: version.workflowId, workspace_id: version.workspaceId, revision: '7',
    current_version_id: version.id, archived_at: null, record: version.definition }
  const versionRow = { id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
    version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3, record: version }
  const configurations = f.configurations.map((record) => ({ id: record.id, workspace_id: record.workspaceId,
    agent_id: record.agentId, version: record.version, record, current_configuration_version_id: record.id }))
  return { f, version, versionRow, configurations, workflow, run, location, locationRow, request, principal }
}

type PrincipalRow = { id: string; name: string; audience: string; grants: unknown; expires_at: Date;
  revoked_at: Date | null; delegated_from: string | null }
type Receipt = { input_hash: string; target_key: string; result: unknown }
type Binding = { principal_id: string; run_id: string; owner_principal_id: string; caller_principal_id: string;
  grant_ceiling: unknown; accepted_expires_at: Date }
interface Database {
  run: AcceptedWorkflowRunV3 | undefined
  boardSnapshot?: RunBoardSnapshot
  admissionTrigger?: string
  principals: PrincipalRow[]
  bindings: Binding[]
  receipt: Receipt | undefined
  source: { digest: string; semantic: string } | undefined
  head: boolean
  succeededAudit: boolean
}

/** Rollback-capable, PostgreSQL-shaped command fixture. SQL rows/publication
 * writes and filesystem location are DOUBLES. There is no SQL parser, real lock
 * contention, PostgreSQL server, native manager, or production canonical producer. */
export function startSqlFixture() {
  const f = startFixture()
  const rootRow: PrincipalRow = { id: f.principal.id, name: f.principal.name, audience: 'operator', grants: f.principal.grants,
    expires_at: new Date(f.principal.expiresAt), revoked_at: null, delegated_from: null }
  let database: Database = { run: undefined, principals: [rootRow], bindings: [], receipt: undefined,
    source: undefined, head: false, succeededAudit: false }
  const calls: { sql: string; values: unknown[]; transaction: boolean }[] = []
  const releases: boolean[] = []
  const state = { filesystemCalls: 0, publications: 0, activeTransactions: 0, count: '0',
    loseCommit: false, missingSource: false, denyClock: false, stopped: false, cleanupPending: false,
    failBoardSnapshot: false, filesystemError: false, maintenanceActive: false,
    onSnapshot: undefined as (() => void) | undefined,
    rows: undefined as ((sql: string, values: unknown[], rows: Record<string, unknown>[]) => Record<string, unknown>[]) | undefined }
  const result = (sql: string, values: unknown[], rows: Record<string, unknown>[]) => {
    const actual = state.rows ? state.rows(sql, values, structuredClone(rows)) : structuredClone(rows)
    return { rows: actual, rowCount: actual.length }
  }
  class Client extends EventEmitter {
    private transaction: Database | undefined
    private inTransaction = false
    getTransactionStatus() { return this.inTransaction ? 'T' : 'I' }
    release(destroy = false) { releases.push(destroy) }
    async query(text: string, values: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      calls.push({ sql, values: structuredClone(values), transaction: this.inTransaction })
      const answer = (rows: Record<string, unknown>[] = []) => result(sql, values, rows)
      if (sql.startsWith('begin')) {
        if (this.inTransaction) throw new Error('nested fixture transaction')
        this.transaction = structuredClone(database); this.inTransaction = true; state.activeTransactions++
        return answer()
      }
      if (sql === 'commit') {
        if (!this.transaction) throw new Error('commit outside fixture transaction')
        const newlyAccepted = !database.run && Boolean(this.transaction.run)
        database = this.transaction; this.transaction = undefined; this.inTransaction = false; state.activeTransactions--
        if (state.loseCommit && newlyAccepted) throw new Error('synthetic lost COMMIT reply')
        return answer()
      }
      if (sql === 'rollback') {
        if (this.inTransaction) state.activeTransactions--
        this.transaction = undefined; this.inTransaction = false
        return answer()
      }
      const db = this.transaction ?? database
      if (sql.includes('pg_try_advisory_xact_lock_shared')) return answer([{ available: !state.maintenanceActive }])
      if (sql.includes('pg_try_advisory_xact_lock')) return answer([{ locked: true }])
      if (sql.startsWith('select 1 where clock_timestamp()')) return answer(state.denyClock ? [] : [{}])
      if (sql.includes('from management_principals where id=$1')) return answer(db.principals.filter((row) => row.id === values[0]))
      if (sql.startsWith('select id from management_principals where id=any')) return answer(db.principals.filter((row) => (values[0] as string[]).includes(row.id)))
      if (sql.startsWith('insert into management_principals')) {
        db.principals.push({ id: String(values[0]), name: String(values[1]), audience: 'operator',
          grants: JSON.parse(String(values[3])), expires_at: new Date(String(values[4])), revoked_at: null, delegated_from: String(values[5]) })
        return answer()
      }
      if (sql.startsWith('insert into run_authority_principals')) {
        db.bindings.push({ principal_id: String(values[0]), run_id: String(values[1]), owner_principal_id: String(values[2]),
          caller_principal_id: String(values[3]), grant_ceiling: JSON.parse(String(values[4])), accepted_expires_at: new Date(String(values[5])) })
        return answer()
      }
      if (sql.startsWith('select caller_principal_id from run_authority_principals')) return answer(db.bindings.filter((row) => row.principal_id === values[0] && row.run_id === values[1]))
      if (sql.startsWith('select input_hash,target_key,result from management_command_receipts')) return answer(db.receipt ? [db.receipt] : [])
      if (sql.startsWith('select 1 from management_audit')) return answer(db.succeededAudit ? [{}] : [])
      if (sql.startsWith('insert into management_command_receipts')) {
        if (db.receipt) throw new Error('duplicate fixture receipt')
        db.receipt = { target_key: String(values[2]), input_hash: String(values[3]), result: JSON.parse(String(values[4])) }
        return answer()
      }
      if (sql.startsWith('insert into management_audit')) { if (sql.includes("'succeeded'")) db.succeededAudit = true; return answer() }
      if (/^\s*with pinned_version as materialized/.test(sql)) return answer([{ versions: [f.versionRow], configurations: f.configurations }])
      if (sql.includes('from workflow_versions where')) return answer([f.versionRow])
      if (sql.includes('from agent_configuration_versions where') || sql.includes('from agents a')) return answer(f.configurations)
      if (sql.includes('from workspaces where')) return answer([f.locationRow])
      if (sql.includes('from workflows where')) return answer([f.workflow])
      if (sql.includes('from graph_drafts')) return answer([])
      if (sql.startsWith('select count(*)::text as count from runs')) return answer([{ count: state.count }])
      // Recovery fence: no interrupted Run or pending cleanup in this workflow.
      if (sql.startsWith('select 1 from runs r where r.workspace_id=$1 and r.workflow_id=$2')) return answer([])
      if (sql.startsWith('insert into runs(')) {
        if (db.run) throw new Error('duplicate fixture Run')
        db.run = AcceptedWorkflowRunV3Schema.parse(JSON.parse(String(values[4])))
        return answer()
      }
      if (sql.startsWith('insert into run_board_snapshots')) {
        if (state.failBoardSnapshot) throw new Error('synthetic snapshot storage failure')
        if (!this.inTransaction || !db.run || db.boardSnapshot) throw new Error('invalid snapshot admission')
        db.boardSnapshot = RunBoardSnapshotSchema.parse(JSON.parse(String(values[6])))
        db.admissionTrigger = String(values[5])
        return answer()
      }
      if (sql.startsWith('select r.id,r.workspace_id,r.workflow_id')) {
        const run = db.run
        return answer(run ? [{ id: run.id, workspace_id: run.workspaceId, workflow_id: run.workflowId,
          workflow_version_id: run.workflowVersionId, execution_state: run.executionState, runner_id: run.executionLocation.runnerId,
          working_directory: run.executionLocation.rootPath, location_revision: String(run.executionLocation.locationRevision),
          record: run, stopped: state.stopped, cleanup_pending: state.cleanupPending }] : [])
      }
      if (sql.startsWith('insert into run_graph_heads')) { db.head = true; return answer() }
      if (sql.startsWith('insert into run_graph_sources')) { db.source = { digest: String(values[1]), semantic: String(values[2]) }; return answer() }
      if (sql.startsWith('select run_id from run_graph_heads')) return answer(db.head ? [{ run_id: db.run?.id }] : [])
      if (sql.startsWith('select r.workspace_id,r.workflow_id,r.workflow_version_id')) {
        return answer(db.run && db.head && db.source ? [{ workspace_id: db.run.workspaceId, workflow_id: db.run.workflowId,
          workflow_version_id: db.run.workflowVersionId, execution_semantics_version: 3, protocol_version: 1, head_sequence: '1',
          source_digest: db.source.digest, source_semantic_digest: db.source.semantic, source_sequence: '1',
          effect_digest: null, effect_semantic_digest: null, effect_sequence: null }] : [])
      }
      throw new Error(`Unmodelled Start SQL: ${sql}`)
    }
  }
  const pool = { connect: async () => new Client(), query: (sql: string, values?: unknown[]) => new Client().query(sql, values) } as unknown as pg.Pool
  const locations = { snapshot: async () => {
    if (state.activeTransactions !== 0) throw new Error('filesystem inside G1')
    state.filesystemCalls++
    if (state.filesystemError) throw new Error('synthetic filesystem failure')
    const prepared = structuredClone(f.location)
    state.onSnapshot?.()
    return prepared
  } } as unknown as WorkspaceLocationService
  const publication: RepeatStartPublication = { initializeLocked: async (sql, accepted) => {
    state.publications++
    if (accepted.snapshot.authorizationPrincipalId !== accepted.run.authorizationPrincipalId
      || accepted.run.authorizationPrincipalId === f.principal.id) throw new Error('Start did not pin the new accepted authority')
    const semanticDigest = repeatDigest({ kind: 'TEST_ONLY_queued_repeat', runId: accepted.run.id })
    await sql.query('insert into run_graph_heads(run_id) values($1)', [accepted.run.id])
    beforeGraphCommit(sql, async () => {
      if (!state.missingSource) await sql.query('insert into run_graph_sources(run_id,source_digest,semantic_digest) values($1,$2,$3)',
        [accepted.run.id, repeatDigest(accepted.run), semanticDigest])
    })
    return { semanticDigest }
  } }
  return { ...f, pool, locations, publication, calls, releases, state,
    database: () => database, replaceDatabase: (next: Database) => { database = structuredClone(next) },
    serialized: () => canonicalGraphJson(database) }
}
