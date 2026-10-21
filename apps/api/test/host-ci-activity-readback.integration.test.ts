import { randomUUID } from 'node:crypto'
import { CiListOutputSchema, CiTestsOutputSchema, CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { activeCiRuns } from '../src/modules/ci-host/cloud.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it('indexes only active Main tickets after authenticated MCP writes and persisted completion', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'install', commandId: randomUUID() }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await activeCiRuns(f.pool)).ids.size).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect((await activeCiRuns(f.pool)).ids.has(started.ticketId)).toBe(true)
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).run.state).toBe('running')
    f.finish(started.ticketId, 0, 'finished')
    await ciRunReadback(input => f.value(reader, 'ci_get', input), started.ticketId, 'passed')
    expect((await activeCiRuns(f.pool)).ids.has(started.ticketId)).toBe(false)
  } finally { await f.close() }
})

it('exposes an Agent’s Host CI ticket and structured results through the Board route contracts', async () => {
  const f = await fixture({ agent: true })
  try {
    expect((await f.agent!.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'bug_report', 'ci_computers_list', 'ci_get', 'ci_logs_read', 'ci_run', 'context_get',
    ])
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', {
      suite: 'unit', commit: 'a'.repeat(40), scope: 'affected', files: ['apps/web/src/example.test.tsx'],
      commandId: randomUUID(),
    }))
    const ticket = CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: started.ticketId }))
    const executionId = ticket.run.initiator.executionId!
    const row = (await f.pool.query<{ run_id: string }>('select run_id from harness_executions where id=$1', [executionId])).rows[0]!
    const tests = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [{
      file: 'apps/web/src/example.test.tsx', status: 'failed', durationMs: 10,
      tests: [{ name: 'renders output', status: 'failed', durationMs: 10, message: 'Expected output' }],
    }] }
    await f.pool.query('update ci_runs set test_results=$2::jsonb where id=$1', [started.ticketId, JSON.stringify(tests)])
    const caller = await f.credential([...CI_GET_ACTIONS, 'runs:read'])
    const headers = { authorization: `Bearer ${caller.token}` }
    const listed = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/ci?runId=${row.run_id}`, headers })
    expect(listed.statusCode).toBe(200)
    const jobs = CiListOutputSchema.parse(listed.json()).jobs
    expect(jobs).toContainEqual(expect.objectContaining({ ticketId: started.ticketId,
      requester: expect.objectContaining({ executionId }), tests: tests.summary }))
    const results = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/ci/${started.ticketId}/tests?status=failed`, headers })
    expect(CiTestsOutputSchema.parse(results.json()).tests).toEqual(tests)
    const operator = await f.connect([...CI_GET_ACTIONS, 'runs:read'])
    expect(CiListOutputSchema.parse(await f.value(operator, 'ci_list', { runId: row.run_id })).jobs).toEqual(jobs)
    const denied = await f.credential(['runs:read'])
    expect((await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/ci?runId=${row.run_id}`,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
  } finally { await f.close() }
}, 120_000)
