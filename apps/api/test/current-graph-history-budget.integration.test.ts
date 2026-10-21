import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RepeatGraphCurrentV3Schema } from '@foreman-code/contracts/wave25'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue, graphUrl } from './eng04-graph-composition-fixture.js'

it.skipIf(!postgresEnabled)('keeps the real current HTTP response bounded as persisted activity and Run history grow', async () => {
  const db = await currentDatabase()
  const t = await graphFixture(db, { qualifiedReads: true, form: 'single' })
  try {
    const read = () => t.app.inject({ method: 'GET', url: graphUrl(t, 'current'),
      headers: graphHeaders(t.writer.token) })
    const before = await read()
    expect(before.statusCode, before.body).toBe(200)
    const initial = RepeatGraphCurrentV3Schema.parse(before.json())
    expect(Buffer.byteLength(before.body)).toBeLessThan(16 * 1024)
    const initialActivityCount = (await db.pool.query(
      'select count(*)::integer as count from run_activity where run_id=$1', [t.run.id])).rows[0].count
    await db.pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
      select $1,'backend','result_recorded',now(),jsonb_build_object('text',repeat('Retained activity ',100))
      from generate_series(1,252)`, [t.run.id])
    await withExclusiveGraphConnection(db.pool, connection => connection.transaction(async sql => {
      for (let index = 0; index < 61; index++) {
        const run = { ...t.accepted.run, id: randomUUID() }
        await insertRepeatRun(sql, { ...t.accepted, run,
          snapshot: { ...t.accepted.snapshot,
            request: { ...t.accepted.snapshot.request, commandId: randomUUID() } } }, repeatStartPublication)
      }
    }))
    expect((await db.pool.query('select count(*)::integer as count from run_activity where run_id=$1',
      [t.run.id])).rows[0].count).toBe(initialActivityCount + 252)
    expect((await db.pool.query('select count(*)::integer as count from runs where workflow_id=$1',
      [t.scope.workflowId])).rows[0].count).toBe(62)
    const after = await read()
    expect(after.statusCode, after.body).toBe(200)
    expect(RepeatGraphCurrentV3Schema.parse(after.json())).toEqual(initial)
    expect(Buffer.byteLength(after.body)).toBe(Buffer.byteLength(before.body))
    const remote = await graphRpc(t.app, t.writer.token, 'tools/call', {
      name: 'run_graph_current_v1', arguments: t.readRequest,
    })
    expect(remote.result?.isError).not.toBe(true)
    expect(graphRpcValue(remote.result)).toEqual(initial)
  } finally {
    await t.app.close()
    await db.close()
  }
})
