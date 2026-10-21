import { randomUUID } from 'node:crypto'
import { CiRunRecordSchema, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from './helpers/deferred.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

afterEach(() => { vi.restoreAllMocks() })

it('settles finished tickets and keeps observing the rest while their result collection is slow', async () => {
  const f = await fixture()
  const host = f.computers[0]!
  const slowResults = deferred()
  const startedAt = new Date(Date.now() - 10_000).toISOString()
  const finishedAt = new Date().toISOString()
  try {
    const ids: string[] = []
    // More tickets than the observation limit: slow collection of the first ones must not starve the others.
    for (let index = 0; index < 7; index++) {
      const record = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: f.workspaceId,
        suite: 'unit', scope: 'full', files: [], part: null, partition: null, repository: 'fixture/project',
        commit: 'a'.repeat(40), state: 'running', computer: { hostRef: host.hostRef, label: host.label },
        step: 'unit', exitCode: null, message: null, queuedAt: startedAt, startedAt, finishedAt: null,
        initiator: { principalId: 'operator', executionId: null } })
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,log_tail)
        values($1,$2,$3,$4,$5,$6::jsonb,$7)`, [record.id, record.workspaceId, record.groupId, record.state,
        host.key, JSON.stringify(record), 'saved output'])
      ids.push(record.id)
    }
    const request = f.endpoint.request.bind(f.endpoint)
    vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input, options): Promise<CiHostReply> => {
      if (input.operation !== 'read') return request(computer, input, options)
      const run: CiHostRun = { runId: input.runId, state: 'failed', step: 'unit', startedAt, finishedAt,
        exitCode: 1, message: 'Test failure', logBytes: 12 }
      if (!input.testResults) return { operation: 'read', run, text: 'fresh output', nextOffset: 12 }
      await slowResults.promise
      return { operation: 'read', run: { ...run, collection: 'complete' }, text: '', nextOffset: 0,
        testResults: { summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false } }
    })

    await f.ci.dispatch()
    for (const id of ids) {
      await f.waitFor(f.operator, id, output => output.run.state === 'failed' && output.run.collection === 'pending')
    }
    // Their executor slots are free while results are still being collected.
    expect((await f.pool.query('select count(*)::int as count from ci_runs where host_key is not null')).rows[0].count)
      .toBe(0)

    slowResults.resolve()
    await f.ci.drain()
    for (const id of ids) {
      const completed = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), id, 'failed')
      expect(completed.run.collection).toBe('complete')
    }
  } finally {
    slowResults.resolve()
    await f.close()
  }
})
