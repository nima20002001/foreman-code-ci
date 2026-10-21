import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { checkpointOwnerMigration } from '../src/infrastructure/checkpointOwnerMigration.js'
import { workflowRestartRecoveryMigration } from '../src/infrastructure/workflowRestartRecoveryMigration.js'
import { recoverWorkflowNativeClosure, readWorkflowClosure, readUnboundWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { recoveryExecution, recoveryIdentity } from './helpers/eng06Recovery.testSupport.js'

/** Real PostgreSQL guard test with an isolated CURRENT closure-table preimage.
 * This is intentionally not a public Run seeder or a fake native terminal/G1
 * receipt. Only the physical registry port is synthetic; no provider is started.
 * Full canonical engine, HTTP/MCP and real-provider restart tests remain separate. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('ENG06-A PostgreSQL recovery receipt guards', () => {
  let admin: pg.Pool, pool: pg.Pool, schema: string
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL
    if (!url) throw new Error('TEST_DATABASE_URL is required')
    const parsed = new URL(url)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
      throw new Error('Use a disposable loopback PostgreSQL database explicitly named for tests')
    }
    schema = `eng06_recovery_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString: url, max: 1 })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: url, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    await pool.query(`
      create table runs(id text primary key,execution_state text not null,record jsonb not null,stop_requested_at timestamptz);
      create table harness_executions(id text primary key,run_id text not null references runs(id),record jsonb not null);
      create table workflow_native_entries(execution_id text primary key references harness_executions(id),run_id text not null,phase text not null);
      create table execution_native_sessions(execution_id text primary key references harness_executions(id),reference jsonb not null);
      create table run_cleanup_intents(run_id text primary key references runs(id),pending boolean not null);
      create table execution_native_closures(generation bigint generated always as identity primary key,
        execution_id text not null references harness_executions(id),execution_identity jsonb not null,
        expected_reference jsonb,closed_reference jsonb,closed_at timestamptz,
        detached_at timestamptz,detached_reference jsonb,closed_without_session boolean not null default false);
      create index execution_native_closures_latest_idx on execution_native_closures(execution_id,generation desc);
    `)
    await pool.query(checkpointOwnerMigration.sql)
    await pool.query(workflowRestartRecoveryMigration.sql)
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
    if (schema && admin) await dropFixtureSchema(admin, schema)
    await admin?.end()
  })

  async function seed(options: { bound?: boolean; detached?: boolean; fenced?: boolean } = {}) {
    const suffix = randomUUID(), execution = recoveryExecution()
    execution.id += suffix; execution.runId += suffix
    if (options.bound === false) { delete execution.nativeSessionId; execution.state = 'starting' }
    const reference = execution.nativeSessionId ? { harness: 'codex', providerVersion: '1.0.0', nativeSessionId: execution.nativeSessionId } : null
    await pool.query('insert into runs(id,execution_state,record) values($1,$2,$3::jsonb)',
      [execution.runId, 'running', JSON.stringify({ id: execution.runId, executionState: 'running', executionSemanticsVersion: 3 })])
    await pool.query('insert into harness_executions values($1,$2,$3::jsonb)', [execution.id, execution.runId, JSON.stringify(execution)])
    await pool.query('insert into workflow_native_entries values($1,$2,$3)', [execution.id, execution.runId, 'entered'])
    if (reference) await pool.query('insert into execution_native_sessions values($1,$2::jsonb)', [execution.id, JSON.stringify(reference)])
    if (options.fenced !== false) await pool.query('insert into run_cleanup_intents values($1,true)', [execution.runId])
    const row = (await pool.query<{ generation: string }>(`insert into execution_native_closures
      (execution_id,execution_identity,expected_reference,detached_reference,detached_at)
      values($1,$2::jsonb,$3::jsonb,$4::jsonb,case when $5 then clock_timestamp() else null end) returning generation::text`,
    [execution.id, JSON.stringify(recoveryIdentity(execution)), reference ? JSON.stringify(reference) : null,
      options.detached && reference ? JSON.stringify(reference) : null, options.detached === true])).rows[0]!
    const owner = await RunOwnership.acquire(pool, execution.runId, () => undefined)
    assert.ok(owner)
    return { execution, reference, owner, generation: row.generation }
  }

  it('advances checkpoint ownership when a recovery owner is replaced', async () => {
    const f = await seed()
    try {
      assert.equal(f.owner.checkpointGeneration, '1')
      const competing = await RunOwnership.acquire(pool, f.execution.runId, () => undefined)
      if (competing) await competing.release()
      assert.equal(competing, undefined)
    } finally {
      await f.owner.release()
    }

    const successor = await RunOwnership.acquire(pool, f.execution.runId, () => undefined)
    assert.ok(successor)
    try {
      assert.equal(successor.checkpointGeneration, '2')
      await recoverWorkflowNativeClosure(successor, f.execution, async () => true, new AbortController().signal)
      const closure = await readWorkflowClosure(successor.oneShotConnection(), f.execution)
      assert.equal(closure?.durableGeneration, f.generation)
    } finally {
      await successor.release()
    }
  })

  for (const detached of [false, true]) it(`persists and reuses exact ${detached ? 'detached' : 'crashed'} closure across Run owners`, async () => {
    const f = await seed({ detached })
    const original = (await pool.query('select * from execution_native_closures where generation=$1', [f.generation])).rows[0]
    let calls = 0
    try {
      await recoverWorkflowNativeClosure(f.owner, f.execution, async () => { calls++; return true }, new AbortController().signal)
      assert.equal((await readWorkflowClosure(f.owner.oneShotConnection(), f.execution))?.durableGeneration, f.generation)
    } finally { await f.owner.release() }
    const successor = await RunOwnership.acquire(pool, f.execution.runId, () => undefined)
    assert.ok(successor)
    try {
      await recoverWorkflowNativeClosure(successor, f.execution, async () => { calls++; return true }, new AbortController().signal)
      assert.equal(calls, 1)
      assert.deepEqual((await pool.query('select * from execution_native_closures where generation=$1', [f.generation])).rows[0], original)
      assert.equal((await pool.query('select 1 from execution_native_recoveries where generation=$1', [f.generation])).rowCount, 1)
      await assert.rejects(pool.query('update execution_native_recoveries set owner_fence=$1 where generation=$2', ['changed', f.generation]))
      await assert.rejects(pool.query('delete from execution_native_recoveries where generation=$1', [f.generation]))
      await assert.rejects(pool.query('truncate execution_native_recoveries'))
    } finally { await successor.release() }
  })

  it('retains no-session uncertainty until positive closure, without binding a fabricated session', async () => {
    const f = await seed({ bound: false })
    try {
      await assert.rejects(recoverWorkflowNativeClosure(f.owner, f.execution, async () => false, new AbortController().signal))
      assert.equal(await readUnboundWorkflowClosure(f.owner.oneShotConnection(), f.execution), undefined)
      await recoverWorkflowNativeClosure(f.owner, f.execution, async () => true, new AbortController().signal)
      assert.equal((await readUnboundWorkflowClosure(f.owner.oneShotConnection(), f.execution))?.durableGeneration, f.generation)
      assert.equal((await pool.query('select 1 from execution_native_sessions where execution_id=$1', [f.execution.id])).rowCount, 0)
    } finally { await f.owner.release() }
  })

  it('cannot close a live unfenced Run or insert evidence from a non-owner connection', async () => {
    const f = await seed({ fenced: false }); let calls = 0
    try {
      await assert.rejects(recoverWorkflowNativeClosure(f.owner, f.execution, async () => { calls++; return true }, new AbortController().signal))
      assert.equal(calls, 0)
      await pool.query('insert into run_cleanup_intents values($1,true)', [f.execution.runId])
      await assert.rejects(pool.query(`insert into execution_native_recoveries
        (generation,execution_id,execution_identity,reference,owner_id,owner_fence) values($1,$2,$3::jsonb,$4::jsonb,$5,$6)`,
      [f.generation, f.execution.id, JSON.stringify(recoveryIdentity(f.execution)), JSON.stringify(f.reference), 'forged', 'forged']))
      assert.equal((await pool.query('select 1 from execution_native_recoveries where generation=$1', [f.generation])).rowCount, 0)
    } finally { await f.owner.release() }
  })

  it('does not transfer closure to a replaced native session after physical IO', async () => {
    const f = await seed()
    try {
      await assert.rejects(recoverWorkflowNativeClosure(f.owner, f.execution, async () => {
        await pool.query('update execution_native_sessions set reference=$2::jsonb where execution_id=$1',
          [f.execution.id, JSON.stringify({ ...f.reference, providerVersion: 'different' })])
        return true
      }, new AbortController().signal))
      assert.equal((await pool.query('select 1 from execution_native_recoveries where generation=$1', [f.generation])).rowCount, 0)
    } finally { await f.owner.release() }
  })
})
