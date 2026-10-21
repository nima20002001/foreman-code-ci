import { readUntil } from './helpers/observableCondition.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import { LocalWorkflowArtifactAuthority } from '../src/modules/runs/remote/localWorkflowArtifactAuthority.js'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './helpers/workHandoffRuntimeFixture.js'

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('PostgreSQL local workflow artifact authority', () => {
  it.each(['artifact context'] as const)(
    'keeps %s reads from locking executions ahead of their Run after acceptance and restart', async boundary => {
    const definition = makeCurrentWorkflowFixture(randomUUID(), 'single')
    definition.version.definition.handoffs = { contractVersion: 1 }
    const f = await workHandoffRuntimeFixture(definition, () => ({ routing: { kind: 'finish' },
      data: { latestDeliverable: 'accepted work', remainingFindings: ['owner direction'] } }))
    let writer: pg.PoolClient | undefined
    let reader: pg.PoolClient | undefined
    let read: Promise<unknown> | undefined
    try {
      await runWorkHandoffWithRestart(f, true, () => true)
      const accepted = (await f.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 and accepted', [f.f.run.id])).rows
      expect(accepted).toHaveLength(1)
      const authority = new LocalWorkflowArtifactAuthority(randomUUID(), f.db.pool, f.locations,
        { assertPinsCurrent: async () => { throw new Error('A node without outputs cannot read artifact placement') } })
      writer = await f.db.pool.connect()
      reader = await f.db.pool.connect()
      const pid = (await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await writer.query('begin')
      await writer.query('select id from runs where id=$1 for update', [f.f.run.id])
      await reader.query('begin')
      read = authority.execution(reader, accepted[0]!.id)
      const result = Promise.allSettled([read])
      const waiting = await readUntil(async () => (await f.db.pool.query<{ waiting: boolean }>(
        "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting === true,
      value => value, { timeoutMs: 2000, description: 'the artifact read to block on the Run lock' })
      expect(waiting).toBe(true)
      expect((await writer.query('select id from harness_executions where id=$1 for update',
        [accepted[0]!.id])).rowCount).toBe(1)
      await writer.query('rollback')
      const [denied] = await result
      expect(denied).toMatchObject({ status: 'rejected', reason: { code: boundary === 'artifact context'
        ? 'NATIVE_ARTIFACT_AUTHORITY_DENIED' : 'WORKFLOW_OUTPUT_PERMISSION_DENIED' } })
    } finally {
      if (writer) { await writer.query('rollback'); writer.release() }
      if (read) await Promise.allSettled([read])
      if (reader) { await reader.query('rollback'); reader.release() }
      await f.close()
    }
  }, 120000)
})
