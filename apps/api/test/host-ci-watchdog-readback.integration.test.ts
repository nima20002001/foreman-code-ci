import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('persists a CI watchdog failure for authenticated MCP status and log readback and denies ungranted callers', async () => {
  const f = await fixture()
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      commandId: randomUUID(), suite: 'unit', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/loop.test.ts'],
    }))
    await f.ci.dispatch()
    const reason = 'CI hang watchdog: no test progress for 60000 ms; running: apps/api/test/loop.test.ts > planner never returns'
    f.finish(started.ticketId, 1, `[ci-watchdog] ${reason}\n`, undefined, reason)
    const result = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 5,
    }))
    expect(result.wait?.status).toBe('settled')
    expect(result.run).toMatchObject({ state: 'failed', exitCode: 1, message: reason })
    expect(result.logTail).toContain(reason)
    const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: started.ticketId }))
    expect(logs.text).toContain(reason)
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!
    expect(CiRunRecordSchema.parse(stored.record)).toMatchObject({ state: 'failed', message: reason })
    const denied = await f.connect(['workflows:read'])
    for (const tool of ['ci_get', 'ci_logs_read']) {
      expect((await f.call(denied, tool, { ticketId: started.ticketId })).isError).toBe(true)
    }
  } finally { await f.close() }
})
