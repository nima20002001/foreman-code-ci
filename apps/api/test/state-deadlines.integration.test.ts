import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { expireOverdueCiRuns } from '../src/modules/ci-host/deadlines.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { sweepStateDeadlines } from '../src/modules/diagnostics/stateDeadlines.js'
import { RunActivitiesService } from '../src/modules/runs/activities.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { deferred, rejectableDeferred } from './helpers/deferred.js'
import { measuredCiPages } from './helpers/measuredCiPages.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'

it('publishes independent Run activity before a held Run writer and delivers both in commit order', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  const locked = rejectableDeferred<void>()
  const write = deferred()
  const insert = `insert into run_activity(run_id,source,kind,occurred_at,payload)
    values($1,'backend','run_cleanup_checked',clock_timestamp(),jsonb_build_object('failed',$2::boolean))`
  let writer: Promise<void> | undefined
  try {
    const activities = new RunActivitiesService(db.pool)
    const read = (cursor?: string) => activities.read(graph.writer.principal, {
      workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100, ...(cursor ? { cursor } : {}),
    })
    const initial = await read()
    writer = withTransaction(db.pool, async client => {
      await client.query('select id from runs where id=$1 for update', [graph.run.id])
      locked.resolve()
      await write.promise
      await client.query(insert, [graph.run.id, true])
    }).catch((error: unknown) => { locked.reject(error); throw error })
    const result = Promise.allSettled([writer])
    await locked.promise
    await withTransaction(db.pool, async client => {
      await client.query("select set_config('statement_timeout','500ms',true)")
      await client.query(insert, [graph.run.id, false])
      expect((await read(initial.nextCursor)).items).toEqual([])
    })
    const during = await read(initial.nextCursor)
    expect(during.items).toMatchObject([{ kind: 'recovery', status: 'completed' }])
    expect((await read(during.nextCursor)).items).toEqual([])
    write.resolve()
    expect(await result).toEqual([{ status: 'fulfilled', value: undefined }])
    const after = await read(during.nextCursor)
    expect(after.items).toMatchObject([{ kind: 'recovery', status: 'failed' }])
    const delivered = [...during.items, ...after.items]
    expect(new Set(delivered.map(item => item.id)).size).toBe(2)
    expect(BigInt(after.items[0]!.sequence)).toBeGreaterThan(BigInt(during.highWater))
    expect((await read(after.nextCursor)).items).toEqual([])
    const persisted = (await db.pool.query<{ sequence: string; payload: { failed: boolean } }>(`
      select sequence::text,payload from run_activity
      where run_id=$1 and sequence>$2 and kind='run_cleanup_checked' order by run_activity.sequence`,
    [graph.run.id, initial.highWater])).rows
    expect(persisted.map(row => row.payload.failed)).toEqual([false, true])
    expect(persisted.map(row => row.sequence)).toEqual(delivered.map(item => item.sequence))
  } finally {
    write.resolve()
    try { await writer } finally {
      await graph.app.close()
      await db.close()
    }
  }
}, 60_000)

it('fails an overdue Run cleanup episode once in Run activity while native ownership stays retained', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  try {
    await db.pool.query(`insert into run_cleanup_intents(run_id,attempts,last_error,requested_at)
      values($1,4,'Exact native, reviewer or credential settlement is still pending.',now()-interval '31 minutes')`,
    [graph.run.id])
    expect(await sweepStateDeadlines(db.pool)).toMatchObject({ runCleanup: 1 })
    expect(await sweepStateDeadlines(db.pool)).toMatchObject({ runCleanup: 0 })
    const intent = (await db.pool.query<{ pending: boolean; exceeded: boolean }>(`select pending,
      deadline_exceeded_at is not null as exceeded from run_cleanup_intents where run_id=$1`, [graph.run.id])).rows[0]
    expect(intent).toEqual({ pending: true, exceeded: true })
    const activity = (await db.pool.query<{ payload: Record<string, unknown> }>(`select payload from run_activity
      where run_id=$1 and kind='run_cleanup_checked' order by sequence`, [graph.run.id])).rows
    expect(activity.map(row => row.payload)).toEqual([expect.objectContaining({ failed: true, attempt: 4,
      code: 'RUN_CLEANUP_DEADLINE_EXCEEDED', phase: 'cleanup', deadlineMs: 30 * 60_000, ownership: 'retained',
      cause: 'Exact native, reviewer or credential settlement is still pending.' })])

    // A later cleanup episode gets its own deadline.
    await db.pool.query('update run_cleanup_intents set pending=false where run_id=$1', [graph.run.id])
    await db.pool.query('update run_cleanup_intents set pending=true where run_id=$1', [graph.run.id])
    expect((await db.pool.query<{ fresh: boolean; exceeded: boolean }>(`select requested_at > now()-interval '1 minute' as fresh,
      deadline_exceeded_at is not null as exceeded from run_cleanup_intents where run_id=$1`, [graph.run.id])).rows[0])
      .toEqual({ fresh: true, exceeded: false })
    expect(await sweepStateDeadlines(db.pool)).toMatchObject({ runCleanup: 0 })
  } finally {
    await graph.app.close()
    await db.close()
  }
}, 60_000)

it('fails overdue CI tickets in the database and keeps a running executor\'s slot', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  const at = (ms: number) => new Date(Date.now() - ms).toISOString()
  const ticket = (state: 'queued' | 'running', fields: Record<string, unknown>) => CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: graph.scope.workspaceId, groupId: randomUUID(), suite: 'lint', commit: 'a'.repeat(40),
    repository: 'example/project', partition: null, state, computer: null, step: null, exitCode: null, message: null,
    queuedAt: at(7 * 60 * 60_000), startedAt: null, finishedAt: null,
    initiator: { principalId: graph.writer.principal.id, executionId: null }, ...fields })
  const queued = ticket('queued', { message: 'No ready computer for lint; no eligible computers' })
  const running = ticket('running', { startedAt: at(4 * 60 * 60_000), step: 'lint',
    computer: { hostRef: { kind: 'main', mainId: 'main' }, label: 'Main computer' } })
  const sources = { ciRuns: (now: Date) => expireOverdueCiRuns(db.pool, now, async run => run) }
  try {
    for (const [run, hostKey] of [[queued, null], [running, 'main:main']] as const) {
      await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record)
        values($1,$2,$3,$4,$5,$6::jsonb)`, [run.id, run.workspaceId, run.groupId, run.state, hostKey, JSON.stringify(run)])
    }
    expect(await sweepStateDeadlines(db.pool, sources)).toMatchObject({ ci: 2 })
    const rows = (await db.pool.query<{ id: string; state: string; host_key: string | null; record: unknown }>(
      'select id,state,host_key,record from ci_runs where id=any($1::uuid[])', [[queued.id, running.id]])).rows
    const saved = new Map(rows.map(row => [row.id, { ...row, record: CiRunRecordSchema.parse(row.record) }]))
    expect(saved.get(queued.id)).toMatchObject({ state: 'failed', host_key: null, record: { deadlineExceeded: {
      code: 'CI_QUEUE_DEADLINE_EXCEEDED', cause: 'No ready computer for lint; no eligible computers', executor: 'none' } } })
    expect(saved.get(running.id)).toMatchObject({ state: 'failed', host_key: 'main:main', record: { collection: 'failed',
      observation: { status: 'unavailable' }, deadlineExceeded: { code: 'CI_RUN_DEADLINE_EXCEEDED', executor: 'retained' } } })
    expect(await sweepStateDeadlines(db.pool, sources)).toMatchObject({ ci: 0 })
  } finally {
    await graph.app.close()
    await db.close()
  }
}, 60_000)

it('finds overdue CI tickets without reading every finished ticket', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  const queued = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: graph.scope.workspaceId, groupId: randomUUID(), suite: 'lint', commit: 'a'.repeat(40),
    repository: 'example/project', partition: null, state: 'queued', computer: null, step: null, exitCode: null, message: null,
    queuedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(), startedAt: null, finishedAt: null,
    initiator: { principalId: graph.writer.principal.id, executionId: null } })
  try {
    await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5::jsonb)`,
      [queued.id, queued.workspaceId, queued.groupId, queued.state, JSON.stringify(queued)])
    // Finished tickets accumulate: every full integration run adds a hundred.
    const finished = await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,log_tail)
      select u.id,t.workspace_id,u.id,'passed',t.record||jsonb_build_object('id',u.id::text,'groupId',u.id::text,
          'state','passed','exitCode',0,'finishedAt',t.record->'queuedAt'),
        (select string_agg(md5(u.id::text||g::text),'') from generate_series(1,40) g)
      from ci_runs t cross join (select gen_random_uuid() as id from generate_series(1,3000)) u where t.id=$1`, [queued.id])
    expect(finished.rowCount).toBe(3000)
    await db.pool.query('analyze ci_runs')
    const measured = measuredCiPages(db.pool)
    const pool = { query: async (text: string, values?: unknown[]) => {
      const client = await measured.pool.connect()
      try { return await client.query(text, values) } finally { client.release() }
    } } as unknown as typeof db.pool
    expect(await expireOverdueCiRuns(pool, new Date())).toBe(1)
    // The finished tickets span hundreds of heap pages; the one overdue ticket needs a handful.
    expect(measured.pages.max).toBeLessThan(100)
    const saved = (await db.pool.query<{ state: string }>('select state from ci_runs where id=$1', [queued.id])).rows[0]
    expect(saved?.state).toBe('failed')
  } finally {
    await graph.app.close()
    await db.close()
  }
}, 60_000)
