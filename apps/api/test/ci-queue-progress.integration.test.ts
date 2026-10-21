import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('dispatches integration prerequisites beyond fifty ineligible tickets', async () => {
  const f = await fixture({ cloud: true })
  f.computers.splice(0, 2)
  try {
    const base = { workspaceId: f.workspaceId, suite: 'integration', scope: 'full', files: [], part: null,
      repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), state: 'queued', computer: null, step: null,
      exitCode: null, message: null, startedAt: null, finishedAt: null,
      initiator: { principalId: 'operator', executionId: null } }
    const records = Array.from({ length: 56 }, (_, index) => CiRunRecordSchema.parse({ ...base,
      id: randomUUID(), groupId: randomUUID(),
      queuedAt: new Date(Date.now() - 60_000 + index).toISOString(),
      partition: { index: 0, count: 1, weights: [1], tier: 'fast', ...(index < 55 ? { hostIndexes: [0] } : {}) },
    }))
    for (const record of records) {
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        values($1,$2,$3,$4,$5::jsonb)`,
      [record.id, f.workspaceId, record.groupId, record.state, JSON.stringify(record)])
    }
    await f.ci.dispatch()
    await f.ci.drain()
    const prerequisite = records.at(-1)!
    const output = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: prerequisite.id }))
    expect(output.run).toMatchObject({ state: 'running', computer: { hostRef: { provider: 'github' } } })
    const stored = (await f.pool.query('select record from ci_runs where id=$1', [prerequisite.id])).rows[0]!
    expect(stored.record).toEqual(output.run)
    expect(f.started.map(({ request }) => request.operation === 'start' ? request.runId : null))
      .toContain(prerequisite.id)
    const denied = await f.connect(['workflows:read'])
    expect((await f.call(denied, 'ci_get', { ticketId: prerequisite.id })).isError).toBe(true)
  } finally { await f.close() }
})
