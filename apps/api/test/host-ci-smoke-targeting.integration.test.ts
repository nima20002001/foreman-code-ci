import { z } from 'zod'
import { CiHostRequestSchema, CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { DomainError } from '../src/modules/errors.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each(['mcp', 'http'] as const)('dispatches affected smoke selections with valid host scope through %s', async transport => {
  const f = await fixture()
  try {
    const computer = f.computers[0]!
    const input = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/ci-smoke.integration.test.ts'], smokeComputer: computer.hostRef,
      commandId: `smoke-scope-${transport}` }
    let started
    if (transport === 'mcp') {
      started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    } else {
      const token = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
      const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.workspaceId}/ci`,
        headers: { authorization: `Bearer ${token.token}` }, payload: input })
      expect(response.statusCode, response.body).toBe(200)
      started = CiRunOutputSchema.parse(response.json())
    }
    await f.ci.dispatch()
    const read = await f.waitFor(f.operator, started.ticketId, output => output.run.state === 'running')
    expect(read.run).toMatchObject({ state: 'running', scope: 'affected', files: input.files,
      smokeComputer: computer.hostRef, computer: { hostRef: computer.hostRef } })
    expect(CiHostRequestSchema.safeParse(f.started[0]!.request).success).toBe(true)
    expect(f.started).toEqual([{ computer: computer.label, request: expect.objectContaining({
      operation: 'start', runId: started.ticketId, scope: 'full', gate: true,
      files: input.files, integrationShards: 7,
    }) }])
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(CiRunRecordSchema.parse(stored)).toMatchObject({ state: 'running', scope: 'affected',
      files: input.files, computer: { hostRef: computer.hostRef } })
  } finally { await f.close() }
})

it('targets one smoke computer through authenticated MCP and HTTP with grants, retries and persisted readback', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/ci-smoke.integration.test.ts'], noSupersede: true }
    for (const [index, computer] of f.computers.entries()) {
      const request = { ...input, smokeComputer: computer.hostRef, commandId: `smoke-${index}` }
      expect((await f.call(reader, 'ci_run', request)).isError).toBe(true)
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', request))
      expect(started.partitions).toBeUndefined()
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', request))).toEqual(started)
      const read = await f.waitFor(f.operator, started.ticketId, output => output.run.state === 'running')
      expect(read.run.computer?.hostRef).toEqual(computer.hostRef)
      expect(CiHostRequestSchema.safeParse(f.started.at(-1)!.request).success).toBe(true)
      expect(read.run).toMatchObject({ smokeComputer: computer.hostRef, integrationShards: 7 })
      expect(f.started.at(-1)).toMatchObject({ computer: computer.label,
        request: { operation: 'start', runId: started.ticketId, integrationShards: 7 } })
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
        [started.ticketId])).rows[0]!.record
      const retainedReleaseSchema = z.object(CiRunRecordSchema.shape).omit({ smokeComputer: true }).strict()
      expect(retainedReleaseSchema.safeParse(stored).success).toBe(true)
      expect(CiRunRecordSchema.parse(stored).integrationShards).toBe(7)
      f.finish(started.ticketId, 0, 'one test passed')
      const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
        ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 5,
      }))
      expect(finished.wait?.status).toBe('settled')
      expect(finished.run.state).toBe('passed')
    }
    const token = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.workspaceId}/ci`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: { ...input, commandId: 'http-smoke', smokeComputer: f.computers[1]!.hostRef } })
    expect(response.statusCode, response.body).toBe(200)
    const ticket = CiRunOutputSchema.parse(response.json())
    await f.ci.dispatch()
    await f.waitFor(reader, ticket.ticketId, output => output.run.state === 'running')
    const httpRead = await f.app.inject({ url: `/api/management/workspaces/${f.workspaceId}/ci/${ticket.ticketId}`,
      headers: { authorization: `Bearer ${token.token}` } })
    expect(httpRead.json().run.smokeComputer).toEqual(f.computers[1]!.hostRef)
    expect(httpRead.json().run.computer.hostRef).toEqual(f.computers[1]!.hostRef)
  } finally { await f.close() }
})

it('persists two memory-limited shards through authenticated MCP on a sixteen-CPU host', async () => {
  const f = await fixture()
  try {
    const requestHost = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, request) => {
      const reply = await requestHost(computer, request)
      return reply.operation === 'status' ? { ...reply, cpuCount: 16, memoryBytes: 6 * 2 ** 30 } : reply
    }
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = {
      suite: 'integration', scope: 'affected', commit: 'a'.repeat(40), commandId: 'memory-limited-smoke',
      files: ['apps/api/test/ci-smoke.integration.test.ts'], smokeComputer: f.computers[0]!.hostRef,
    }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.started).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = await f.waitFor(reader, started.ticketId, output => output.run.state === 'running')
    expect(read.run).toMatchObject({ state: 'running', integrationShards: 2 })
    expect(f.started[0]!.request).toMatchObject({ operation: 'start', integrationShards: 2 })
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(CiRunRecordSchema.parse(stored).integrationShards).toBe(2)
  } finally { await f.close() }
})

it('rejects Agent smoke targeting and never falls back to another computer when a target is unavailable', async () => {
  const f = await fixture({ agent: true })
  try {
    const request = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/ci-smoke.integration.test.ts'], commandId: 'smoke-denied',
      smokeComputer: f.computers[0]!.hostRef }
    expect((await f.agent!.callTool({ name: 'ci_run', arguments: request })).isError).toBe(true)
    const computer = f.computers.shift()!
    expect((await f.call(f.operator, 'ci_run', request)).isError).toBe(true)
    expect(f.started).toHaveLength(0)
    f.computers.push(computer)
    const endpointRequest = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (target, input) => {
      if (input.operation === 'start' && target.key === computer.key) {
        throw new DomainError('CI_HOST_BUSY', 'Target is busy.', 409)
      }
      return endpointRequest(target, input)
    }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...request, commandId: 'smoke-busy' }))
    const queued = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(queued.run.state).toBe('queued')
    f.computers.pop()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.state).toBe('queued')
    expect(read.run.computer).toBeNull()
    expect(f.started).toHaveLength(0)
  } finally { await f.close() }
})
