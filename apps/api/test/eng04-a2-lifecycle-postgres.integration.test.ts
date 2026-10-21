import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type pg from 'pg'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphFixture, graphPosition, type GraphFixture } from './eng04-graph-composition-fixture.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { admitWorkflowStopIntent, immutableWorkflowRunPins } from '../src/modules/runs/workflowStopAdmission.js'
import type { CurrentStopContext } from '../src/modules/runs/currentProduction.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'

// REAL migrated PostgreSQL and current typed Save/canonical Start publication
// fixtures. This is deliberately NOT a real native/provider or public Start
// qualification: no native proof, successful cleanup or receipt is fabricated.
const enabled = postgresEnabled
describe.skipIf(!enabled)('A2 current lifecycle SQL boundaries', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: GraphFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60000)
  afterAll(async () => { for (const t of fixtures) await t.app.close(); await db?.close() })
  async function setup() {
    const t = await graphFixture(db, { form: 'sequential', qualifiedReads: true }); fixtures.push(t)
    let authorizations = 0
    const context: CurrentStopContext = { principal: t.writer.principal, source: 'http', run: t.run,
      input: { workspaceId: t.run.workspaceId, runId: t.run.id, commandId: randomUUID() },
      async authorizeLocked(sql) {
        authorizations++
        // Same parent-row lock as the actual Stop transaction. A different
        // client or later unlocked authorization cannot satisfy this test.
        assert.equal((await sql.query('select id from runs where id=$1 for update', [t.run.id])).rowCount, 1)
        const live = await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, t.writer.principal.id)
        requireAuthorization(live, 'runs:stop', { workspaceId: t.run.workspaceId, workflowId: t.run.workflowId, runId: t.run.id })
      } }
    return { t, context, authorizations: () => authorizations }
  }
  it('clean bootstrap registers proof, Stop, projection and distinct detachment constraints', async () => {
    assert.equal((await db.pool.query('select version from application_migrations where version=264602')).rowCount, 1)
    const tables = ['workflow_native_entries', 'workflow_native_proofs', 'review_native_entries', 'review_native_proofs',
      'workflow_stop_intents', 'run_graph_public_projection']
    for (const table of tables) assert.ok((await db.pool.query('select to_regclass($1)::text as name', [table])).rows[0]?.name)
    const columns = (await db.pool.query<{ column_name: string }>(`select column_name from information_schema.columns
      where table_schema=$1 and table_name='execution_native_closures'`, [db.schema])).rows.map((r) => r.column_name)
    for (const name of ['closed_without_session', 'detached_at', 'detached_reference']) assert.ok(columns.includes(name))
    const deferred = (await db.pool.query<{ tgname: string }>(`select tgname from pg_trigger
      where tgrelid in ('workflow_native_proofs'::regclass,'review_native_proofs'::regclass,'workflow_stop_intents'::regclass)
      and tgdeferrable and tginitdeferred`)).rows.map((r) => r.tgname)
    assert.ok(deferred.includes('a2_native_receipt')); assert.ok(deferred.includes('a2_stop_intent_receipt'))
  })
  it('Stop does not reacquire B\'s session command lock and stays intent-only', async () => {
    const { t, context, authorizations } = await setup(), original = await graphPosition(db, t)
    const client = await db.pool.connect(), key = `command:${context.principal.id}:run.stop:${context.input.commandId}`
    try {
      await client.query('select pg_advisory_lock(hashtext($1))', [key])
      // A reentrant lock on a different connection would fail the fixture's
      // finite lock_timeout. The production helper must never take this lock.
      const first = await admitWorkflowStopIntent(db.pool, context)
      assert.equal(first.receipt.status, 'accepted'); assert.equal(first.receipt.processStopped, false)
      assert.ok(authorizations() >= 2); assert.ok(BigInt(await graphPosition(db, t)) > BigInt(original))
      assert.equal((await db.pool.query('select 1 from workflow_stop_intents where run_id=$1', [t.run.id])).rowCount, 1)
      const live = (await db.pool.query('select stop_requested_at,execution_state from runs where id=$1', [t.run.id])).rows[0]
      assert.ok(live.stop_requested_at); assert.equal(live.execution_state, 'queued')
      assert.equal((await db.pool.query('select 1 from harness_executions where run_id=$1', [t.run.id])).rowCount, 0)
      for (const table of ['run_repeat_occurrences', 'run_repeat_decisions']) {
        assert.equal((await db.pool.query(`select 1 from ${table} where run_id=$1`, [t.run.id])).rowCount, 0)
      }
    } finally { await client.query('select pg_advisory_unlock(hashtext($1))', [key]); client.release() }
  }, 15000)
  it('exact lost-reply replay uses the same immutable intent and emits no second batch', async () => {
    const { t, context } = await setup(), first = await admitWorkflowStopIntent(db.pool, context)
    const head = await graphPosition(db, t)
    const replay = await admitWorkflowStopIntent(db.pool, { ...context, source: 'mcp' })
    assert.deepEqual(replay, first); assert.equal(await graphPosition(db, t), head)
    assert.deepEqual(first.pins, immutableWorkflowRunPins(t.run))
    await assert.rejects(admitWorkflowStopIntent(db.pool, { ...context, run: { ...context.run, workflowVersionId: 'wrong' } }))
    assert.equal(await graphPosition(db, t), head)
    await assert.rejects(db.pool.query('delete from workflow_stop_intents where run_id=$1', [t.run.id]), { code: 'P2602' })
  })
  it('revocation fails before Stop effects', async () => {
    const { t, context } = await setup(), head = await graphPosition(db, t)
    await db.pool.query('update management_principals set revoked_at=now() where id=$1', [t.writer.principal.id])
    await assert.rejects(admitWorkflowStopIntent(db.pool, context), { code: 'AUTH_REVOKED' })
    assert.equal(await graphPosition(db, t), head)
    assert.equal((await db.pool.query('select 1 from workflow_stop_intents where run_id=$1', [t.run.id])).rowCount, 0)
    assert.equal((await db.pool.query('select stop_requested_at from runs where id=$1', [t.run.id])).rows[0].stop_requested_at, null)
  })
  it('an existing exact Stop intent cannot bypass later live revocation', async () => {
    const { t, context } = await setup()
    await admitWorkflowStopIntent(db.pool, context)
    const head = await graphPosition(db, t)
    await db.pool.query('update management_principals set revoked_at=now() where id=$1', [t.writer.principal.id])
    await assert.rejects(admitWorkflowStopIntent(db.pool, context), { code: 'AUTH_REVOKED' })
    assert.equal(await graphPosition(db, t), head)
    assert.equal((await db.pool.query('select 1 from workflow_stop_intents where run_id=$1', [t.run.id])).rowCount, 1)
  })
  it('missing execution/session/closure rows never prove physical settlement', async () => {
    const { t } = await setup()
    const unknown = { ...t.f.identities[0], id: 'not-created-a2', runId: t.run.id }
    // readWorkflowClosure must return unknown without parsing or upgrading this
    // deliberately nonexistent test selector to a positive durable fact.
    assert.equal(await readWorkflowClosure(db.pool, unknown as never), undefined)
  })
})
