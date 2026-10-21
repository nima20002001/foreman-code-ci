import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('commits collection and its duration sample before waiting for expired history pruning', async () => {
  const f = await fixture()
  const file = 'apps/api/test/measured.integration.test.ts'
  const expired = 'apps/api/test/expired.integration.test.ts'
  let collecting: Promise<void> | undefined
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'prune-after-collection',
    }))
    await f.ci.dispatch()
    await f.pool.query(`insert into ci_file_durations(repository,file,duration_ms,updated_at)
      values('octo/site',$1,1000,now()),('octo/site',$2,1000,now() - interval '31 days')`, [file, expired])

    await withTransaction(f.pool, async blocker => {
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await blocker.query('select file from ci_file_durations where repository=$1 and file=$2 for update',
        ['octo/site', expired])
      f.finish(started.ticketId, 0, 'passed\n', { [file]: 3000 })
      collecting = f.ci.dispatch()

      // Observe the database lock wait rather than assuming dispatch has reached pruning after a delay.
      await vi.waitFor(async () => {
        const { rows } = await f.pool.query<{ blocked: boolean }>(`select exists(
          select 1 from pg_stat_activity where datname=current_database()
            and $1::int=any(pg_blocking_pids(pid))) as blocked`, [pid])
        expect(rows[0]!.blocked).toBe(true)
      }, { timeout: 5000, interval: 10 })

      // Read through MCP directly: the fixture's convenience reader first awaits dispatch, which is blocked.
      const response = await f.operator.callTool({ name: 'ci_get', arguments: {
        workspaceId: f.workspaceId, ticketId: started.ticketId,
      } })
      expect(response.isError).not.toBe(true)
      expect(CiGetOutputSchema.parse(decodeMcpToolResult(response)).run)
        .toMatchObject({ state: 'passed', collection: 'complete' })
      expect((await f.pool.query(`select duration_ms,samples from ci_file_durations
        where repository=$1 and file=$2`, ['octo/site', file])).rows)
        .toEqual([{ duration_ms: 2000, samples: 2 }])
    })

    await collecting
    await f.ci.drain()
    expect((await f.pool.query('select file from ci_file_durations where repository=$1 order by file',
      ['octo/site'])).rows).toEqual([{ file }])
  } finally {
    await collecting
    await f.close()
  }
})
