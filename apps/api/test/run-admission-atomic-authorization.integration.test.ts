import { readUntil } from './helpers/observableCondition.js'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { RepeatGraphBatchV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { currentRepositoryServices } from './helpers/wave25CurrentRepository.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, seedAgent3, candidateFor, graphHead, postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

/** Tests transactional admission and the public application service in isolated fixtures. */
describe.skipIf(!postgresEnabled)('Agent 3 atomic Run admission and live authorization', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const table of ['runs', 'run_graph_batches', 'management_command_receipts']) await db.pool.query(`drop trigger if exists a3_admission_fault on ${table}`)
  })
  async function fixture() {
    const candidate = makeCurrentWorkflowFixture(randomUUID())
    const f = await seedAgent3(db.pool, db.directory, candidate, { run: false })
    const access = new PostgresAccessService(db.pool)
    const issued = await access.issue({ name: 'Synthetic Run authority', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }], expiresAt: new Date(Date.now() + 300_000) })
    const commands = new PostgresCommandCoordinator(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands)
    const selected = await locations.set(issued.principal, 'http', { workspaceId: f.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: db.directory })
    const client = await db.pool.connect()
    try { f.run.executionLocation = await locations.snapshot(client, f.scope.workspaceId, selected.value.locationRevision, 'read-only') }
    finally { client.release() }
    // The FS probe is the only test double. SQL scope/revision/identity checks,
    // command receipts, Run authority and graph publication are all real.
    const snapshot = vi.spyOn(locations, 'snapshot').mockResolvedValue(f.run.executionLocation!)
    const expectedWorkflowRevision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!.revision)
    const input = { expectedWorkflowRevision, expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, executionSemanticsVersion: 3 as const, workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      workflowVersionId: f.version.id, commandId: randomUUID(), expectedLocationRevision: f.run.executionLocation!.locationRevision, input: { user: 'synthetic private input' } }
    return { f, access, issued, commands, locations, snapshot, input }
  }
  const admit = (pool: typeof db.pool, locations: WorkspaceLocationService,
    principal: Parameters<typeof admitRepeatRun>[2], source: 'http' | 'mcp', input: Parameters<typeof admitRepeatRun>[4],
    options?: Parameters<typeof admitRepeatRun>[6]) => admitRepeatRun(pool, locations, principal, source, input, repeatStartPublication, options)
  const repositoryFor = (locations: WorkspaceLocationService) => new PostgresRunRepository(db.pool,
    new PostgresWorkflowRepository(db.pool), locations, { runtimeRoot: db.directory,
      ...currentRepositoryServices(db, createWorkflowNativeCaptureChannel().verify) })
  it.each(['runs', 'run_graph_batches', 'management_command_receipts'] as const)('rolls back the entire admission if %s fails', async (table) => {
    const { f, issued, locations, input } = await fixture()
    await db.pool.query(`create or replace function a3_admission_crash() returns trigger language plpgsql as $$
      begin raise exception 'A3_ADMISSION_CRASH'; end $$`)
    await db.pool.query(`create trigger a3_admission_fault after insert on ${table} for each row execute function a3_admission_crash()`)
    await expect(admit(db.pool, locations, issued.principal, 'mcp', input)).rejects.toThrow('A3_ADMISSION_CRASH')
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.start'", [issued.principal.id])).rowCount).toBe(0)
    expect((await db.pool.query('select 1 from management_principals where delegated_from=$1', [issued.principal.id])).rowCount).toBe(0)
    await db.pool.query(`drop trigger a3_admission_fault on ${table}`)
    const result = await admit(db.pool, locations, issued.principal, 'mcp', input)
    const sequence = await graphHead(db.pool, result.value.id)
    const body = (await db.pool.query<{ payload: string }>('select payload from run_graph_batches where run_id=$1 and sequence=$2::bigint', [result.value.id, sequence])).rows[0]!.payload
    const batch = RepeatGraphBatchV3Schema.parse(JSON.parse(body))
    expect(batch.events.map((event) => event.fact.type)).toEqual(['repeat.run.state', 'workflow.presentation'])
    expect(body).not.toContain('synthetic private input')
    expect((await db.pool.query('select 1 from run_authority_principals where run_id=$1', [result.value.id])).rowCount).toBe(1)
  })
  it('replays one durable Run without probing the filesystem or creating another execution', async () => {
    const { f, issued, locations, snapshot, input } = await fixture()
    const first = await admit(db.pool, locations, issued.principal, 'http', input)
    snapshot.mockRejectedValue(new Error('directory now unavailable'))
    const replay = await admit(db.pool, locations, issued.principal, 'mcp', input)
    expect(replay).toEqual({ ...first, replayed: true }); expect(snapshot).toHaveBeenCalledTimes(1)
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(1)
    await expect(admit(db.pool, locations, issued.principal, 'mcp', { ...input, input: { changed: true } })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })
  it('rejects a location revision changed during external validation before any Run/receipt is created', async () => {
    const { f, issued, locations, snapshot, input } = await fixture()
    snapshot.mockImplementation(async () => {
      await db.pool.query('update workspaces set location_revision=location_revision+1 where id=$1', [f.scope.workspaceId])
      return f.run.executionLocation!
    })
    await expect(admit(db.pool, locations, issued.principal, 'http', input)).rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
  })
  it('rejects stale pins and revoked authority, including replay under revoked credentials', async () => {
    const { f, issued, locations, input } = await fixture()
    const first = await admit(db.pool, locations, issued.principal, 'mcp', input)
    await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id])
    await expect(admit(db.pool, locations, issued.principal, 'mcp', input)).rejects.toThrow()
    const other = await fixture()
    await db.pool.query('update agents set current_configuration_version_id=null where id=$1', [other.f.configurations[0]!.agentId])
    await expect(admit(db.pool, other.locations, other.issued.principal, 'mcp', other.input)).rejects.toMatchObject({ code: 'WORKFLOW_CONFIGURATION_STALE' })
    expect((await db.pool.query('select 1 from runs where id=$1 and workflow_id=$2', [first.value.id, f.scope.workflowId])).rowCount).toBe(1)
  })
  it('serializes independent admissions at the runner bound rather than deriving capacity from node count', async () => {
    const a = await fixture(), b = await fixture(), runner = `runner-${randomUUID()}`
    for (const value of [a, b]) {
      value.f.run.executionLocation!.runnerId = runner
      value.snapshot.mockResolvedValue(value.f.run.executionLocation!)
      await db.pool.query("update workspaces set execution_location=jsonb_set(execution_location,'{runnerId}',to_jsonb($2::text)) where id=$1", [value.f.scope.workspaceId, runner])
    }
    const results = await Promise.allSettled([a, b].map((value) => admit(db.pool, value.locations, value.issued.principal, 'mcp', value.input, { maximumResidentRuns: 1 })))
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({ reason: { code: 'RUNNER_ADMISSION_FULL' } })
    expect((await db.pool.query('select 1 from runs where runner_id=$1', [runner])).rowCount).toBe(1)
  })
  it('holds live root authority against a revocation race until the effect transaction commits', async () => {
    const { f, issued, locations, input } = await fixture()
    const accepted = await admit(db.pool, locations, issued.principal, 'mcp', input)
    f.run = accepted.value; f.scope.runId = accepted.value.id
    const owner = await RunOwnership.acquire(db.pool, accepted.value.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    const entered = rejectableDeferred(), release = rejectableDeferred()
    let pause = true
    const repository = repositoryFor(locations), store = await repository.repeat(owner)
    const validate = locations.revalidateRunAuthorization.bind(locations)
    vi.spyOn(locations, 'revalidateRunAuthorization').mockImplementation(async (...args) => {
      await validate(...args)
      if (pause) { pause = false; entered.resolve(); await release.promise }
    })
    try {
      const queued = store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => candidateFor(f))
      await entered.promise
      let revoked = false
      const revoker = await db.pool.connect()
      const pid = (await revoker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const revocation = revoker.query(
        'update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id],
      ).then(() => { revoked = true }).finally(() => revoker.release())
      const transactions = Promise.allSettled([queued, revocation])
      try {
        await readUntil(async () => (await db.pool.query<{ blocked: boolean }>(
          'select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid])).rows[0]!.blocked,
        blocked => blocked, { timeoutMs: 2000, description: 'revocation to block on the effect transaction' })
        expect(revoked).toBe(false)
      } finally {
        release.resolve()
        await transactions
      }
      const row = await queued
      await revocation
      if (row.kind !== 'admitted') throw new Error('Expected admitted execution')
      await expect(store.claimLaunch(row.execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/never-created` })).rejects.toThrow()
      expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [accepted.value.id])).rowCount).toBe(0)
      // Revocation forbids native work, not the owner settling the admitted
      // negative attempt. Otherwise revoked permission would strand dependents.
      await repository.requestCleanup(f.run.id, owner)
      await repository.settleOrphan(f.run.id, owner, false)
      const negative = await store.readExecution(row.execution.id)
      expect(negative.execution.result?.outcome).toBe('failed')
      expect(negative.accepted).toBe(false)
      expect((await db.pool.query('select 1 from run_repeat_results where execution_id=$1', [row.execution.id])).rowCount).toBe(0)
      expect((await db.pool.query<{ execution_state: string }>('select execution_state from runs where id=$1', [accepted.value.id])).rows[0]!.execution_state).toBe('completed')

    } finally { release.resolve(); await owner.release() }
  })
  it('rejects cross-Run writes before an owner can mutate a different Run', async () => {
    const a = await fixture(), b = await fixture()
    const first = await admit(db.pool, a.locations, a.issued.principal, 'mcp', a.input)
    const second = await admit(db.pool, b.locations, b.issued.principal, 'mcp', b.input)
    const owner = await RunOwnership.acquire(db.pool, first.value.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    const repository = repositoryFor(a.locations)
    try {
      await expect(repository.get(second.value.id, owner)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
      await expect(repository.updateState(second.value.id, { executionState: 'interrupted', outcome: 'pending' }, owner))
        .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
      expect((await repository.get(second.value.id))!.executionState).toBe('queued')
      expect((await repository.get(first.value.id))!.executionState).toBe('queued')
    } finally { await owner.release() }
  })
  it('public Start refuses an unassembled native runtime and never grants read-only callers admission', async () => {
    const { f, issued, access, commands, locations, input } = await fixture()
    const runs = repositoryFor(locations), start = vi.fn(async () => undefined)
    const management = new RunManagementService(db.pool, commands, runs, { start } as unknown as LangGraphWorkflowEngine, locations)
    await expect(management.start(issued.principal, 'mcp', input)).rejects.toThrow()
    const denied = await access.issue({ name: 'Read only', audience: 'operator',
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300000) })
    await expect(management.start(denied.principal, 'mcp', input)).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
  })
  it('rejects unsupported trigger admission rather than restoring a legacy dispatch route', async () => {
    const { f, issued, locations, input } = await fixture()
    await expect(admit(db.pool, locations, issued.principal, 'mcp', input, { triggerJobId: randomUUID() }))
      .rejects.toMatchObject({ code: 'REPEAT_TRIGGER_UNSUPPORTED' })
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
  })
})
