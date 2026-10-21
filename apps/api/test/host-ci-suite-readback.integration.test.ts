import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it.each([
  ['unit', 11], ['lint', 2], ['typecheck', 2], ['build', 2],
] as const)('persists and dispatches all %s parts through authenticated MCP', async (suite, count) => {
  const f = await fixture({ cloud: { github: suite === 'unit' ? 5 : 0, circleci: 0 } })
  try {
    const input = { suite, commandId: `parts-${suite}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(count)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const read = await f.waitFor(f.operator, started.ticketId, output => output.partitions!.some(run =>
      run.state === 'running') && output.partitions!.every(run =>
      run.state === 'queued' && run.message !== null || run.observation?.status === 'available'))
    expect(read.partitions).toHaveLength(count)
    expect(read.partitions!.every(run => run.suite === suite && run.part?.startsWith(`${suite}-`)
      && run.groupId === read.run.groupId)).toBe(true)
    if (suite === 'unit') {
      const expectedShards = { 'unit-api': 5, 'unit-web': 3, 'unit-web-heavy': 2, 'unit-other': 1 }
      for (const [part, shards] of Object.entries(expectedShards)) {
        const runs = read.partitions!.filter(run => run.part === part)
        expect(runs).toHaveLength(shards)
        expect(runs.map(run => run.partition).sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0)))
          .toEqual(shards === 1 ? [null] : Array.from({ length: shards }, (_, index) => ({ index, count: shards })))
      }
    }
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows
    expect(stored).toHaveLength(count)
    expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      const reply = await request(computer, input)
      if (input.operation === 'start') f.finish(input.runId, 0, `${input.part} passed\n`)
      return reply
    }
    for (const { request } of f.started) {
      if (request.operation === 'start') f.finish(request.runId, 0, `${request.part} passed\n`)
    }
    const done = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 10, logTail: false,
    }))
    expect(done.wait).toMatchObject({ status: 'settled', tickets: count, settledTickets: count })
    expect(done.group).toMatchObject({ groupId: read.run.groupId, state: 'passed' })
    expect(f.started).toHaveLength(count)
    expect(f.started.every(item => item.request.operation === 'start' && item.request.part)).toBe(true)
    for (const run of done.partitions!) {
      const computer = f.computers.find(value => value.label === run.computer?.label)!
      const status = await f.endpoint.request(computer, { operation: 'status' })
      expect(status.operation === 'status' && status.runs.some(value => value.runId === run.id)).toBe(true)
      const dispatched = f.started.filter(item => item.request.operation === 'start' && item.request.runId === run.id)
      expect(dispatched).toHaveLength(1)
      const request = dispatched[0]!.request
      expect(request).toMatchObject({ operation: 'start', suite, part: run.part })
      if (request.operation === 'start') expect(request.partition ?? null).toEqual(run.partition)
    }
    const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, group: true, maxBytes: 4096,
    }))
    expect(logs.parts).toHaveLength(count)
    for (const part of logs.parts!) expect(part.text).toBe(`${part.run.part} passed\n`)
  } finally { await f.close() }
})

it('shares split suite and group log readback between authenticated HTTP and MCP', async () => {
  const f = await fixture()
  try {
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const input = { suite: 'build', commandId: 'http-parts' }
    const reader = await f.credential(CI_GET_ACTIONS)
    expect((await f.app.inject({ method: 'POST', url, payload: input,
      headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    expect(started.partitions).toHaveLength(2)
    await f.ci.dispatch()
    for (const [index, ticket] of started.partitions!.entries()) f.finish(ticket.ticketId, index, `result ${index}\n`)
    const completed = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'passed')
    expect(completed.partitions!.map(run => run.state).sort()).toEqual(['failed', 'passed'])
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.group?.state).toBe('failed')
    expect(result.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))).toEqual(result)
    const httpLogs = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}/logs?group=true&maxBytes=500000`, headers })
    expect(httpLogs.statusCode).toBe(200)
    const mcpLogs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, group: true, maxBytes: 500_000,
    }))
    expect(mcpLogs.maxBytes).toBe(65_536)
    expect(mcpLogs.parts!.every(part => part.maxBytes === 32_768)).toBe(true)
    expect(CiLogsOutputSchema.parse(httpLogs.json())).toEqual(mcpLogs)
    expect(mcpLogs.parts!.map(part => part.text).sort()).toEqual(['result 0\n', 'result 1\n'])
  } finally { await f.close() }
})

it('clamps failed unit log pages for Agents, Operators and HTTP while preserving access checks', async () => {
  const f = await fixture({ agent: true })
  try {
    const agent = f.agent!
    const started = CiRunOutputSchema.parse(decodeMcpToolResult(await agent.callTool({ name: 'ci_run', arguments: {
      suite: 'unit', commandId: 'log-pages', commit: 'a'.repeat(40), scope: 'affected',
      files: ['apps/api/test/example.test.ts'],
    } })))
    await f.ci.dispatch()
    const log = 'x'.repeat(70_000) + '\nunit failed\n'
    f.finish(started.ticketId, 1, log)
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 10, logTail: false,
    }))
    expect(failed.wait).toMatchObject({ status: 'settled', tickets: 1, settledTickets: 1 })
    expect(failed.run.state).toBe('failed')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(failed.run)
    const credential = await f.credential(CI_GET_ACTIONS)
    const headers = { authorization: `Bearer ${credential.token}` }
    const url = `/api/management/workspaces/${f.workspaceId}/ci/${started.ticketId}/logs`
    const input = { ticketId: started.ticketId, afterOffset: 0, maxBytes: 500_000 }
    const first = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', input))
    expect(first).toEqual({ text: log.slice(0, 65_536), maxBytes: 65_536, nextOffset: 65_536, logBytes: log.length })
    const agentResult = await agent.callTool({ name: 'ci_logs_read', arguments: input })
    expect(agentResult.isError).not.toBe(true)
    expect(CiLogsOutputSchema.parse(decodeMcpToolResult(agentResult))).toEqual(first)
    const http = await f.app.inject({ method: 'GET', url: `${url}?afterOffset=0&maxBytes=500000`, headers })
    expect(http.statusCode).toBe(200)
    expect(CiLogsOutputSchema.parse(http.json())).toEqual(first)
    const next = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ...input, afterOffset: first.nextOffset,
    }))
    expect(first.text + next.text).toBe(log)
    expect(next.nextOffset).toBe(log.length)
    const tail = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, maxBytes: 500_000,
    }))
    expect(tail).toEqual({ text: log.slice(-65_536), maxBytes: 65_536, nextOffset: log.length, logBytes: log.length })
    const small = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ...input, maxBytes: 10 }))
    expect(small).toEqual({ text: log.slice(0, 10), maxBytes: 10, nextOffset: 10, logBytes: log.length })
    const denied = await f.connect(CI_GET_ACTIONS, { workspaceIds: [randomUUID()] })
    expect((await f.call(denied, 'ci_logs_read', input)).isError).toBe(true)
    const deniedCredential = await f.credential(['jobs:cancel'])
    expect((await f.app.inject({ method: 'GET', url: `${url}?maxBytes=500000`,
      headers: { authorization: `Bearer ${deniedCredential.token}` } })).statusCode).toBe(403)
    for (const maxBytes of [0, -1, 1.5]) {
      expect((await f.call(f.operator, 'ci_logs_read', { ...input, maxBytes })).isError).toBe(true)
      expect((await f.app.inject({ method: 'GET', url: `${url}?maxBytes=${maxBytes}`, headers })).statusCode).toBe(400)
    }
  } finally { await f.close() }
}, 60_000)
