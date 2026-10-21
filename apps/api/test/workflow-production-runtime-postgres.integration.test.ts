import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type pg from 'pg'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { markRepeatRunRunning, requestRepeatRunStop } from '../src/modules/runs/repeatLifecycle.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { readRepeatRunSourceLocked } from '../src/modules/run-graph/publication.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { agent3Database, graphHead, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { createRepeatFixtureWriter, insertFixtureRepeatRun, repeatReadyAgent3Fixture } from './eng04-repeat-fixture-writer.js'

// Opt-in REAL PostgreSQL/migrations/ownership/authority/canonical publication.
// Setup creates synthetic immutable Runs, NOT authenticated HTTP/MCP Start.
// No native session, receipt, grant bypass or process-absence proof is fabricated.
// No source outside this lane or existing graph fixture suite is changed.
describe.skipIf(!postgresEnabled)('ENG04 production runtime lifecycle PostgreSQL slice', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const owners: RunOwnership[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { for (const owner of owners) await owner.release(); await db?.close() })
  async function fixture(withHead = true) {
    const f = repeatReadyAgent3Fixture(makeCurrentWorkflowFixture(randomUUID()))
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const fixtureWriter = await createRepeatFixtureWriter(db.pool, f)
    const saved = await fixtureWriter.publish(3)
    const version = saved.version
    const grants: ManagementGrant[] = [
      { actions: ['runs:start', 'runs:stop', 'runs:read'],
        scope: { workspaceIds: [version.workspaceId], workflowIds: [version.workflowId] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [version.workspaceId] } },
    ]
    const principal = (await fixtureWriter.credential(grants)).principal
    const run = await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      const authority = await acceptRunAuthority(sql as unknown as pg.PoolClient, principal)
      const { accepted } = await insertFixtureRepeatRun(db.pool, f, saved, authority.principal.id, { insert: false })
      const run = await insertRepeatRun(sql, accepted, repeatStartPublication)
      await bindRunAuthority(sql as unknown as pg.PoolClient, run.id, authority)
      return run
    }))
    if (!withHead) await db.pool.query('delete from run_graph_heads where run_id=$1', [run.id])
    const owner = await RunOwnership.acquire(db.pool, run.id, () => undefined)
    assert.ok(owner); owners.push(owner)
    const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: version.id,
      runId: run.id, executionSemanticsVersion: 3 as const }
    const authorize = async (sql: GraphTransactionSql) => {
      await sql.query('select id from management_principals where id=$1 for share', [principal.id])
      const live = await currentOperatorAuthority(sql as unknown as Pick<pg.Pool, 'query'>, principal.id)
      requireAuthorization(live.principal, 'runs:stop', { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id })
    }
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool))
    const source = () => owner.oneShotConnection().transaction((sql) => readRepeatRunSourceLocked(sql, scope))
    const children = async () => (await db.pool.query<{ count: string }>(
      'select count(*)::text as count from harness_executions where run_id=$1', [run.id])).rows[0]!.count
    return { run, owner, principal, locations, authorize, source, children }
  }

  it('continues a persisted Run after its root starter credential expires', async () => {
    const f = await fixture()
    await db.pool.query('update management_principals set expires_at=now()-interval \'1 second\' where id=$1',
      [f.principal.id])
    await markRepeatRunRunning(f.owner, f.locations, { executionState: 'running', outcome: 'pending' })
    assert.equal((await f.source()).run.executionState, 'running')
    await db.pool.query('update management_principals set revoked_at=now() where id=$1', [f.principal.id])
    await assert.rejects(markRepeatRunRunning(f.owner, f.locations, { executionState: 'running', outcome: 'pending' }))
  })

  it('publishes first running state with exact authority and preserves its original start on replay', async () => {
    const f = await fixture(), input = { executionState: 'running' as const, outcome: 'pending' as const,
      startedAt: '2026-09-25T00:00:00.000Z' }
    assert.equal(await graphHead(db.pool, f.run.id), '1')
    await markRepeatRunRunning(f.owner, f.locations, input)
    const first = await f.source(), head = await graphHead(db.pool, f.run.id)
    assert.equal(first.run.executionState, 'running'); assert.equal(first.replayed, true)
    assert.equal(first.run.authorizationPrincipalId, f.run.authorizationPrincipalId)
    assert.equal(first.run.startedAt, input.startedAt); assert.ok(BigInt(head) > 1n)
    await markRepeatRunRunning(f.owner, f.locations, input)
    assert.equal(await graphHead(db.pool, f.run.id), head); assert.equal(await f.children(), '0')
  })

  it('denies a caller without Stop grants, then persists fence+intent+canonical readback atomically', async () => {
    const f = await fixture(), original = await graphHead(db.pool, f.run.id)
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.principal.id, JSON.stringify([
      { actions: ['runs:read'], scope: { workspaceIds: [f.run.workspaceId] } },
    ])])
    await assert.rejects(requestRepeatRunStop(db.pool, f.run.id, f.authorize))
    assert.equal(await graphHead(db.pool, f.run.id), original)
    assert.equal((await f.source()).stopped, false)
    assert.equal((await db.pool.query('select run_id from run_cleanup_intents where run_id=$1', [f.run.id])).rowCount, 0)
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.principal.id, JSON.stringify(f.principal.grants)])
    await requestRepeatRunStop(db.pool, f.run.id, f.authorize)
    const stopped = await f.source(), head = await graphHead(db.pool, f.run.id)
    assert.equal(stopped.stopped, true); assert.equal(stopped.replayed, true); assert.equal(stopped.run.executionState, 'queued')
    assert.equal((await db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending', [f.run.id])).rowCount, 1)
    await requestRepeatRunStop(db.pool, f.run.id, f.authorize)
    assert.equal(await graphHead(db.pool, f.run.id), head)
    await assert.rejects(markRepeatRunRunning(f.owner, f.locations, { executionState: 'running', outcome: 'pending' }))
    assert.equal(await graphHead(db.pool, f.run.id), head); assert.equal(await f.children(), '0')
  })

  it('revoked accepting root cannot start its tokenless accepted Run authority', async () => {
    const f = await fixture(), head = await graphHead(db.pool, f.run.id)
    await db.pool.query('update management_principals set revoked_at=now() where id=$1', [f.principal.id])
    await assert.rejects(markRepeatRunRunning(f.owner, f.locations, { executionState: 'running', outcome: 'pending' }), { code: 'RUN_AUTHORIZATION_REVOKED' })
    assert.equal(await graphHead(db.pool, f.run.id), head); assert.equal((await f.source()).run.executionState, 'queued')
    assert.equal(await f.children(), '0')
  })

  it('missing admission head is never repaired by a lifecycle writer', async () => {
    const f = await fixture(false)
    await assert.rejects(markRepeatRunRunning(f.owner, f.locations, { executionState: 'running', outcome: 'pending' }))
    await assert.rejects(requestRepeatRunStop(db.pool, f.run.id, f.authorize))
    assert.equal((await db.pool.query('select run_id from run_graph_heads where run_id=$1', [f.run.id])).rowCount, 0)
    const row = (await db.pool.query<{ state: string; stopped: boolean }>(
      'select execution_state as state,stop_requested_at is not null as stopped from runs where id=$1', [f.run.id])).rows[0]!
    assert.equal(row.state, 'queued'); assert.equal(row.stopped, false); assert.equal(await f.children(), '0')
  })
})
