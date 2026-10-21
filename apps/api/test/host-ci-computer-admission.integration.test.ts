import { randomUUID } from 'node:crypto'
import {
  CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema,
  userSystemdIntegrationFiles,
} from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { DomainError } from '../src/modules/errors.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it('cancels queued and running runs and skips a computer without a GitHub login', async () => {
  const f = await fixture({ github: { builder: false } })
  try {
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.computers.find(value => value.label === 'builder')).toMatchObject({ ready: false,
      reasons: [expect.stringContaining('gh auth login')] })
    const running = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'run' }))
    const queued = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'wait' }))
    await f.ci.dispatch()
    expect(f.started.map(value => value.computer)).toEqual(['laptop'])
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: queued.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: running.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    await f.ci.dispatch()
    expect(f.started).toHaveLength(1)
  } finally { await f.close() }
})

it('fails a ticket at once with the reason when the public mirror refuses its commit', async () => {
  const f = await fixture({ github: { laptop: false, builder: false }, cloud: { github: 1, circleci: 0 } })
  try {
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      if (computer.hostRef.kind === 'cloud' && input.operation === 'start') {
        throw new DomainError('CI_MIRROR_PRIVATE_DATA', 'Not published to the public CI mirror: test/example.test.ts:3', 409)
      }
      return request(computer, input)
    }
    const run = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'private' }))
    await f.ci.dispatch()
    const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), run.ticketId, 'failed')
    expect(read.run).toMatchObject({ state: 'failed', message: expect.stringContaining('test/example.test.ts:3') })
    await f.ci.dispatch()
    expect(f.started).toHaveLength(0)
  } finally { await f.close() }
})

it('runs two host-only tickets on one computer and queues a third through authenticated MCP', async () => {
  const f = await fixture({ hostSlots: 2, cloud: true })
  f.computers.splice(1, 1)
  try {
    const request = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: [[...userSystemdIntegrationFiles][0]!] }
    const denied = await f.connect([...CI_GET_ACTIONS])
    expect((await f.call(denied, 'ci_run', { ...request, commandId: randomUUID() })).isError).toBe(true)
    const tickets = []
    for (let index = 0; index < 3; index++) {
      tickets.push(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
        { ...request, commandId: randomUUID() })).ticketId)
    }
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    expect(f.started.every(start => start.computer === f.computers[0]!.label)).toBe(true)
    const records = await Promise.all(tickets.map((ticketId, index) => f.waitFor(f.operator, ticketId,
      output => output.run.state === (index < 2 ? 'running' : 'queued')
        && (index < 2 || output.run.message?.includes('all CI slots in use (2/2)') === true))))
    expect(records.map(record => CiGetOutputSchema.parse(record).run.state)).toEqual(['running', 'running', 'queued'])
    expect(CiGetOutputSchema.parse(records[2]).run.message).toContain('all CI slots in use (2/2)')
    const listed = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(listed.computers[0]).toMatchObject({ slotsUsed: 2, slotsTotal: 2, running: tickets.slice(0, 2) })
    expect(listed.computers.find(computer => computer.hostRef.kind === 'cloud'))
      .toMatchObject({ slotsUsed: 0, slotsTotal: 1 })
    await f.value(f.operator, 'ci_cancel', { ticketId: tickets[0] })
    await f.ci.dispatch()
    expect((await f.waitFor(f.operator, tickets[2]!, output => output.run.state === 'running')).run.state).toBe('running')
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: tickets[1] })).run.state).toBe('running')
  } finally { await f.close() }
})

it.each([
  { text: 'finished\0 café\n', message: 'Done.\0\ud800', cleanText: 'finished café\n', cleanMessage: 'Done.\ufffd' },
  { text: 'finished\ud800\n', message: 'Done.\udc00', cleanText: 'finished\ufffd\n', cleanMessage: 'Done.\ufffd' },
])('settles invalid log output and dispatches the next queued ticket with persisted MCP readback: $cleanText', async output => {
  const f = await fixture()
  f.computers.splice(1, 1)
  const read = async (ticketId: string) => CiGetOutputSchema.parse(decodeMcpToolResult(await f.operator.callTool({
    name: 'ci_get', arguments: { workspaceId: f.workspaceId, ticketId },
  })))
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'lint', scope: 'affected', files: ['apps/api/src/example.ts'],
      commit: 'a'.repeat(40), commandId: 'nul-log', noSupersede: true,
    }))
    expect(first.partitions).toBeUndefined()
    await f.ci.dispatch()
    expect((await read(first.ticketId)).run).toMatchObject({
      state: 'running', commit: 'a'.repeat(40), scope: 'affected', files: ['apps/api/src/example.ts'],
    })
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'lint', scope: 'affected', files: ['apps/api/src/example.ts'],
      commit: 'a'.repeat(40), commandId: 'after-nul-log', noSupersede: true,
    }))
    expect(second.partitions).toBeUndefined()
    await f.ci.dispatch()
    expect((await read(second.ticketId)).run).toMatchObject({
      state: 'queued', commit: 'a'.repeat(40), scope: 'affected', files: ['apps/api/src/example.ts'],
    })
    f.finish(first.ticketId, 0, output.text, undefined, output.message)
    await f.ci.dispatch()
    const finished = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), first.ticketId, 'passed')
    expect(finished).toMatchObject({ run: { state: 'passed', message: output.cleanMessage }, logTail: output.cleanText })
    const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: first.ticketId }))
    expect(logs.text).toBe(output.cleanText)
    expect(logs.nextOffset).toBe(Buffer.byteLength(output.text))
    const stored = (await f.pool.query<{ record: unknown; log_tail: string }>(
      'select record,log_tail from ci_runs where id=$1', [first.ticketId])).rows[0]!
    expect(stored).toEqual({ record: finished.run, log_tail: finished.logTail })
    expect((await f.waitFor(f.operator, second.ticketId, output => output.run.state === 'running')).run.state)
      .toBe('running')
    const denied = await f.connect(['workflows:read'])
    for (const name of ['ci_get', 'ci_logs_read']) {
      expect((await denied.callTool({ name,
        arguments: { workspaceId: f.workspaceId, ticketId: first.ticketId } })).isError).toBe(true)
    }
  } finally { await f.close() }
})

it('lists cloud CI slots beside build computers through MCP', async () => {
  const f = await fixture({ cloud: true })
  try {
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.computers.find(value => value.label === 'GitHub Actions 1'))
      .toMatchObject({ hostRef: { kind: 'cloud', provider: 'github', slot: 0 }, priority: 30 })
  } finally { await f.close() }
})

it('lists persisted active tickets on their assigned computers even when host status has no runs', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const denied = await f.connect(['workflows:read'])
    expect((await f.call(denied, 'ci_computers_list', {})).isError).toBe(true)
    await f.value(f.operator, 'ci_run', { suite: 'integration', scope: 'full', partitions: 5,
      commandId: 'computer-readback' })
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      const reply = await request(computer, input)
      if (reply.operation === 'start' && computer.hostRef.provider === 'circleci') {
        return { ...reply, run: { ...reply.run, state: 'starting' } }
      }
      return reply.operation === 'status' ? { ...reply, runs: [] } : reply
    }
    await f.ci.dispatch()
    expect(f.started).toHaveLength(4)
    for (const start of f.started) expect(start.request).toMatchObject({ ciMirror: 'octo/site-ci' })
    const read = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    for (const computer of f.computers) {
      const assigned = f.started.filter(start => start.computer === computer.label)
        .map(start => start.request.operation === 'start' ? start.request.runId : '')
      expect(read.computers.find(value => value.label === computer.label)?.running).toEqual(assigned)
    }
    const first = f.started[0]!
    if (first.request.operation !== 'start') throw new Error('Expected a start request')
    await f.value(f.operator, 'ci_cancel', { ticketId: first.request.runId })
    const afterCancel = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(afterCancel.computers.find(value => value.label === first.computer)?.running).toEqual([])
  } finally { await f.close() }
})
