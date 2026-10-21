import { afterAll, beforeAll, expect, it } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'
import { withCiTicketLock } from '../src/modules/ci-host/dispatch.js'
import { withTransaction, type SqlQuery } from '../src/infrastructure/transaction.js'
import { sendCiDispatch, type CiDispatchState } from '../src/modules/ci-host/dispatchRecovery.js'
import type { CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/serviceTypes.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
beforeAll(async () => {
  db = await currentDatabase()
  await db.pool.query('create table dispatch_markers(id text primary key, value text not null)')
  await db.pool.query("insert into dispatch_markers values('ticket','queued')")
}, 60_000)
afterAll(async () => { await db?.close() })

it('commits database work and allows cancellation writes while a ticket waits for its host', async () => {
  const entered = deferred()
  const release = deferred()
  const dispatch = withCiTicketLock(db.pool, 'ticket', async client => {
    await client.query("update dispatch_markers set value='dispatched' where id='ticket'")
    entered.resolve()
    await release.promise
    return 'acknowledged'
  })
  const outcome = Promise.allSettled([dispatch])
  try {
    await entered.promise
    await withTransaction(db.pool, async cancellation => {
      await cancellation.query("set local lock_timeout='500ms'")
      expect((await cancellation.query("select value from dispatch_markers where id='ticket'")).rows)
        .toEqual([{ value: 'dispatched' }])
      await cancellation.query("update dispatch_markers set value='cancellation requested' where id='ticket'")
    })
    expect(await withCiTicketLock(db.pool, 'ticket', async () => 'duplicate')).toBeUndefined()
    expect(await withCiTicketLock(db.pool, 'other-ticket', async () => 'independent')).toBe('independent')
    release.resolve()
    expect(await dispatch).toBe('acknowledged')
    expect((await db.pool.query("select value from dispatch_markers where id='ticket'")).rows)
      .toEqual([{ value: 'cancellation requested' }])
  } finally {
    release.resolve()
    await outcome
  }
})

it('releases ticket exclusion after both a successful callback and a failed callback', async () => {
  await expect(withCiTicketLock(db.pool, 'retry-ticket', async () => {
    throw new Error('Host unavailable')
  })).rejects.toThrow('Host unavailable')
  expect(await withCiTicketLock(db.pool, 'retry-ticket', async () => 'retried')).toBe('retried')
  expect(await withCiTicketLock(db.pool, 'retry-ticket', async () => 'finished')).toBe('finished')
})

it('releases every pooled connection during host waits while excluding another dispatcher', async () => {
  const otherPool = new pg.Pool({ ...db.pool.options })
  const entered = deferred()
  const release = deferred()
  const dispatch = withCiTicketLock(db.pool, 'pooled-ticket', async sql => {
    await sql.query('select 1')
    entered.resolve()
    await release.promise
    return 'acknowledged'
  })
  const outcome = Promise.allSettled([dispatch])
  try {
    await entered.promise
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0)
    expect(await withCiTicketLock(otherPool, 'pooled-ticket', async () => 'duplicate')).toBeUndefined()
    expect(await withCiTicketLock(otherPool, 'independent-ticket', async () => 'independent')).toBe('independent')
    release.resolve()
    expect(await dispatch).toBe('acknowledged')
    expect(await withCiTicketLock(otherPool, 'pooled-ticket', async () => 'retried')).toBe('retried')
  } finally {
    release.resolve()
    await outcome
    await otherPool.end()
  }
})

it('recovers an expired dispatch claim and rejects writes from its previous owner', async () => {
  const otherPool = new pg.Pool({ ...db.pool.options })
  const entered = deferred()
  const release = deferred()
  let stale: SqlQuery | undefined
  let replacement: Promise<string | undefined> | undefined
  try {
    await db.pool.query("insert into dispatch_markers values('expired-ticket','queued')")
    await withCiTicketLock(db.pool, 'expired-ticket', async sql => {
      stale = sql
      await sql.query(`update ci_dispatch_claims set expires_at=clock_timestamp()-interval '1 second'
        where ticket_id=$1`, ['expired-ticket'])
      replacement = withCiTicketLock(otherPool, 'expired-ticket', async () => {
        entered.resolve()
        await release.promise
        return 'replacement'
      })
      await entered.promise
    })
    expect(await withCiTicketLock(db.pool, 'expired-ticket', async () => 'duplicate')).toBeUndefined()
    await expect(stale!.query("update dispatch_markers set value='stale reply' where id='expired-ticket'"))
      .rejects.toMatchObject({ code: 'CI_DISPATCH_CLAIM_LOST' })
    expect((await db.pool.query("select value from dispatch_markers where id='expired-ticket'")).rows)
      .toEqual([{ value: 'queued' }])
    release.resolve()
    expect(await replacement).toBe('replacement')
    expect(await withCiTicketLock(db.pool, 'expired-ticket', async () => 'retried')).toBe('retried')
  } finally {
    release.resolve()
    if (replacement) await Promise.allSettled([replacement])
    await otherPool.end()
  }
})

it('commits a cloud start before remote I/O and preserves cancellation when its acknowledgement arrives', async () => {
  const workspaceId = randomUUID()
  const computer: HostCiComputer = { key: 'fixture-cloud', label: 'Cloud executor', priority: 0,
    hostRef: { kind: 'cloud', mainId: randomUUID(), provider: 'circleci', slot: 0 } }
  const run = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId, groupId: randomUUID(), suite: 'lint', partition: null,
    commit: 'a'.repeat(40), repository: 'example/project', state: 'starting',
    computer: { hostRef: computer.hostRef, label: computer.label }, step: 'dispatch',
    exitCode: null, message: null, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    initiator: { principalId: 'fixture-operator', executionId: null }, dispatchAttempts: 0,
    dispatchRequest: { operation: 'start', runId: randomUUID(), repository: 'example/project',
      defaultBranch: 'main', commit: 'a'.repeat(40), suite: 'lint' },
  })
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI fixture' })])
  await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record)
    values($1,$2,$3,$4,$5,$6::jsonb)`,
  [run.id, workspaceId, run.groupId, run.state, computer.key, JSON.stringify(run)])
  const entered = deferred()
  const release = deferred()
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, request) => {
    if (request.operation !== 'start') throw new Error('Expected cloud start')
    entered.resolve()
    await release.promise
    return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'lint',
      exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null } }
  } }
  const dispatch = sendCiDispatch({ pool: db.pool, endpoint,
    read: async (id: string, _workspaceId: string, sql: SqlQuery) => {
      const saved = (await sql.query<{ record: unknown }>('select record from ci_runs where id=$1', [id])).rows[0]!
      return CiRunRecordSchema.parse(saved.record)
    },
    settle: async (previous: CiRunRecord, _computer: HostCiComputer, state: CiDispatchState,
      options: { client: SqlQuery }) => {
      const next = { ...previous, ...state }
      const saved = await options.client.query(`update ci_runs set state=$2,record=$3::jsonb
        where id=$1 and record=$4::jsonb`, [run.id, next.state, JSON.stringify(next), JSON.stringify(previous)])
      return Boolean(saved.rowCount)
    },
  }, run, computer)
  const outcome = Promise.allSettled([dispatch])
  try {
    await entered.promise
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0)
    await withTransaction(db.pool, async client => {
      await client.query("set local lock_timeout='500ms'")
      const saved = (await client.query<{ record: unknown }>('select record from ci_runs where id=$1', [run.id])).rows[0]!
      expect(CiRunRecordSchema.parse(saved.record).dispatchAttempts).toBe(1)
      await client.query(`update ci_runs set record=jsonb_set(record,'{cancellation}',$2::jsonb) where id=$1`,
        [run.id, JSON.stringify({ principalId: 'fixture-operator', source: 'mcp', commandId: randomUUID(), reason: 'direct' })])
    })
    release.resolve()
    expect(await dispatch).toBe('settled')
    const saved = (await db.pool.query<{ record: { cancellation: unknown } }>(
      'select record from ci_runs where id=$1', [run.id])).rows[0]!
    expect(saved.record.cancellation).toMatchObject({ principalId: 'fixture-operator' })
    expect(CiRunRecordSchema.parse(saved.record).state).toBe('starting')
  } finally {
    release.resolve()
    await outcome
  }
})
