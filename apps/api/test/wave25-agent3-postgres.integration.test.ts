import { readUntil } from './helpers/observableCondition.js'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, candidateFor, graphHead, postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { rejectableDeferred } from './helpers/deferred.js'

/** Real current Save/Start, independent SQL owners and canonical transactions.
 * No provider is connected; these assertions stop at the native entry boundary. */
describe.skipIf(!postgresEnabled)('Current workflow admission crash and owner races', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const owners: RunOwnership[] = []
  const faultTables = ['harness_executions', 'run_repeat_slots', 'run_graph_batches'] as const
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => {
    vi.restoreAllMocks()
    while (owners.length) await owners.pop()!.release()
    for (const table of faultTables) await db.pool.query(`drop trigger if exists a3_test_fault on ${table}`)
  })
  afterAll(async () => { await db?.close() })
  async function own(t: Awaited<ReturnType<typeof currentRepositoryFixture>>) {
    const owner = await t.repository.acquireOwnership(t.f.run.id, () => undefined)
    if (!owner) throw new Error('Fixture Run already owned')
    owners.push(owner)
    return { owner, store: await t.repository.repeat(owner) }
  }
  async function fresh() {
    const t = await currentRepositoryFixture(db)
    return { ...t, ...await own(t) }
  }
  async function admit(t: Awaited<ReturnType<typeof fresh>>) {
    const result = await t.store.admit({ nodeId: t.f.version.entryNodeId, occurrence: null }, () => candidateFor(t.f))
    if (result.kind !== 'admitted') throw new Error('Expected current admission')
    return result.execution
  }
  const paths = (t: Awaited<ReturnType<typeof fresh>>, execution: Awaited<ReturnType<typeof admit>>) => ({
    workingDirectory: db.directory, runtimeDirectory: repeatRuntimeDirectory(db.directory, t.f.scope, execution) })
  it.each(faultTables)('queue, reservation and canonical receipts roll back when %s fails', async (table) => {
    const t = await fresh(), head = await graphHead(db.pool, t.f.run.id)
    await db.pool.query(`create or replace function a3_test_crash() returns trigger language plpgsql as $$
      begin raise exception 'A3_CRASH_BEFORE_COMMIT'; end $$`)
    await db.pool.query(`create trigger a3_test_fault after insert on ${table} for each row execute function a3_test_crash()`)
    await expect(admit(t)).rejects.toThrow()
    expect(await graphHead(db.pool, t.f.run.id)).toBe(head)
    for (const relation of ['harness_executions', 'workflow_native_entries', 'run_repeat_slots']) {
      expect((await db.pool.query(`select 1 from ${relation} where run_id=$1`, [t.f.run.id])).rowCount).toBe(0)
    }
    await db.pool.query(`drop trigger a3_test_fault on ${table}`)
    const execution = await admit(t)
    expect(await t.store.admit({ nodeId: t.f.version.entryNodeId, occurrence: null }, () => { throw new Error('duplicate attempt') }))
      .toMatchObject({ kind: 'admitted', reused: true, execution: { id: execution.id } })
    expect(execution.nativeSessionId).toBeUndefined(); expect(execution.runtimeDirectory).toBeUndefined()
  })
  it('duplicate admission and launch commit one durable attempt and one ephemeral permit', async () => {
    const t = await fresh(), ref = { nodeId: t.f.version.entryNodeId, occurrence: null }
    const admissions = await Promise.all([t.store.admit(ref, () => candidateFor(t.f)), t.store.admit(ref, () => candidateFor(t.f))])
    expect(admissions.filter((value) => value.kind === 'admitted' && !value.reused)).toHaveLength(1)
    const execution = await admit(t)
    const claims = await Promise.all([t.store.claimLaunch(execution.id, paths(t, execution)), t.store.claimLaunch(execution.id, paths(t, execution))])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(t.store.consumeLaunchPermit(execution.id)).toBe(true)
    expect(t.store.consumeLaunchPermit(execution.id)).toBe(false)
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [t.f.run.id])).rowCount).toBe(1)
  })
  it('restart cannot recreate a launch permit or repair an unacknowledged session', async () => {
    const t = await fresh(), execution = await admit(t)
    await t.store.claimLaunch(execution.id, paths(t, execution)); await t.owner.release()
    const recovered = await own(t)
    expect(await recovered.store.claimLaunch(execution.id, paths(t, execution))).toBeUndefined()
    expect(recovered.store.consumeLaunchPermit(execution.id)).toBe(false)
    expect(await recovered.store.recoverSession(execution.id)).toMatchObject({ id: execution.id, state: 'starting' })
    await expect(recovered.store.exactSession(execution.id)).rejects.toMatchObject({ code: 'NATIVE_SESSION_START_UNCERTAIN' })
    expect((await db.pool.query('select 1 from execution_native_sessions where execution_id=$1', [execution.id])).rowCount).toBe(0)
  })
  it('a lost COMMIT acknowledgement never releases permission despite a committed launch receipt', async () => {
    const t = await fresh(), execution = await admit(t), pid = Number((await t.owner.client.query('select pg_backend_pid() as pid')).rows[0].pid), query = pg.Client.prototype.query
    let lose = true
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((function (this: pg.Client, ...args: unknown[]) {
      const pending = Reflect.apply(query, this, args) as Promise<pg.QueryResult>
      if (args[0] === 'commit' && lose && (this as pg.Client & { processID: number }).processID === pid) { lose = false; return pending.then(() => { throw new Error('A3_LOST_COMMIT_RESPONSE') }) }
      return pending
    }) as typeof pg.Client.prototype.query)
    await expect(t.store.claimLaunch(execution.id, paths(t, execution))).rejects.toThrow('A3_LOST_COMMIT_RESPONSE')
    expect(t.store.consumeLaunchPermit(execution.id)).toBe(false)
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [t.f.run.id])).rowCount).toBe(1)
    vi.restoreAllMocks(); await t.owner.release()
    const recovered = await own(t)
    expect(await recovered.store.claimLaunch(execution.id, paths(t, execution))).toBeUndefined()
    expect(recovered.store.consumeLaunchPermit(execution.id)).toBe(false)
  })
  it('an authorized Stop wins an independently blocked launch without allocating resources', async () => {
    const t = await fresh(), execution = await admit(t), entered = rejectableDeferred(), release = rejectableDeferred()
    const pid = Number((await t.owner.client.query('select pg_backend_pid() as pid')).rows[0].pid)
    const stop = t.repository.requestStop(t.f.run.id, async (sql) => {
      await t.authorizeStop(sql)
      entered.resolve(); await release.promise
    })
    await entered.promise
    const claim = t.store.claimLaunch(execution.id, paths(t, execution))
    const rejection = expect(claim).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    try {
      const blocked = await readUntil(async () => {
        return (await db.pool.query<{ blocked: boolean }>('select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])).rows[0]!.blocked
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      expect(blocked).toBe(true)
    } finally { release.resolve() }
    await stop; await rejection
    expect(await t.repository.getExecution(execution.id, t.owner)).toMatchObject({ state: 'queued' })
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [t.f.run.id])).rowCount).toBe(0)
  })
  it('Stop after launch fences native entry and cannot erase the original claim', async () => {
    const t = await fresh(), execution = await admit(t)
    await t.store.claimLaunch(execution.id, paths(t, execution)); await t.stop()
    await expect(t.store.beginNativeEntry(execution.id)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [t.f.run.id])).rowCount).toBe(1)
    expect((await db.pool.query('select 1 from execution_native_sessions where execution_id=$1', [execution.id])).rowCount).toBe(0)
  })
  it('a released advisory lock fences the old store while its successor reuses the attempt', async () => {
    const t = await fresh(), execution = await admit(t), head = await graphHead(db.pool, t.f.run.id)
    await t.owner.oneShotConnection().query('select pg_advisory_unlock($1,hashtext($2))', [810002, t.f.run.id])
    const successor = await own(t)
    await expect(t.store.claimLaunch(execution.id, paths(t, execution))).rejects.toThrow()
    expect(await graphHead(db.pool, t.f.run.id)).toBe(head)
    expect(await successor.store.admit({ nodeId: execution.workflowNodeId, occurrence: null }, () => { throw new Error('duplicate') }))
      .toMatchObject({ kind: 'admitted', reused: true, execution: { id: execution.id } })
  })
})
