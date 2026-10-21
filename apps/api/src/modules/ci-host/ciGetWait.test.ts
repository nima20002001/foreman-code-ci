import { EventEmitter } from 'node:events'
import type pg from 'pg'
import Fastify from 'fastify'
import { CI_WAIT_MAX_SECONDS, CiRunRecordSchema, CiGetOutputSchema, CiGetInputSchema, OperatorCiGetInputSchema }
  from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { ciCapabilities } from '../../mcp/shared/ciTools.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  const caller: ManagementPrincipal = {
    id: 'reader', name: 'CI reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  let record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'running', computer: null, step: 'lint', exitCode: null, message: null,
    queuedAt: '2026-10-14T00:00:00.000Z', startedAt: '2026-10-14T00:00:01.000Z', finishedAt: null,
    initiator: { principalId: caller.id, executionId: null },
  })
  const logTail = 'x'.repeat(32_768)
  const query = vi.fn(async (_statement: unknown, parameters?: unknown[]) => ({
    rows: parameters?.[1] === record.groupId ? [] : [{ record: structuredClone(record), log_tail: logTail }],
  }))
  const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })
  const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: vi.fn(async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'workspace' }
  }) }
  const endpoint: HostCiEndpoint = { computers: vi.fn(async () => []),
    request: vi.fn(async () => { throw new Error('CI reads must not contact a computer') }) }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, authority, {} as CiCommits, endpoint)
  const ci = create()
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return caller
    if (token === 'denied') return { ...caller, id: 'denied', grants: [] }
    throw new DomainError('AUTH_INVALID', 'Invalid token.', 401)
  })
  const services = { ci, commands: { recordDenied: vi.fn(async () => undefined),
    recordAudit: vi.fn(async () => undefined) } } as unknown as OperatorServices
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: services })
  const rpc = (payload: Record<string, unknown>, token = 'reader') => app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, payload })
  const call = async (input: Record<string, unknown>, id: string | number = 1, token = 'reader') => {
    const response = await rpc({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: record.id, ...input } } }, token)
    const line = response.body.split('\n').find(value => value.startsWith('data: '))
    return line ? JSON.parse(line.slice(6)) : response.json()
  }
  const persist = (changes: Partial<typeof record>) => {
    const before = record
    record = CiRunRecordSchema.parse({ ...record, ...changes })
    if (before.state !== record.state || before.step !== record.step) {
      client.emit('notification', { channel: 'ci_ticket_changed',
        payload: JSON.stringify({ workspaceId: record.workspaceId, ticketId: record.id, groupId: record.groupId }) })
    }
  }
  return { app, call, rpc, ci, create, services, caller, pool, client, query, endpoint, persist,
    read: () => record, close: async () => { await ci.close(); await app.close() } }
}

const value = (message: { result: Parameters<typeof decodeMcpToolResult>[0] }) =>
  CiGetOutputSchema.parse(decodeMcpToolResult(message.result))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it('accepts bounded waitSeconds and optional logTail for both MCP roles', () => {
  for (const schema of [CiGetInputSchema, OperatorCiGetInputSchema]) {
    const input = { workspaceId: 'workspace', ticketId: 'ticket', waitSeconds: 60, logTail: false }
    const scoped = schema === CiGetInputSchema ? { ticketId: input.ticketId, waitSeconds: 60, logTail: false } : input
    expect(schema.safeParse(scoped).success).toBe(true)
    expect(schema.safeParse({ ...scoped, waitSeconds: 0 }).success).toBe(true)
    expect(schema.safeParse({ ...scoped, waitSeconds: 0.1 }).success).toBe(true)
    for (const waitSeconds of [-1, CI_WAIT_MAX_SECONDS + 1, '10']) {
      expect(schema.safeParse({ ...scoped, waitSeconds }).success).toBe(false)
    }
  }
})

it('omits the tail on request and preserves default persisted readback across service recreation', async () => {
  const f = fixture()
  try {
    const withoutTail = value(await f.call({ logTail: false }))
    expect(withoutTail.run).toEqual(f.read())
    expect(withoutTail).not.toHaveProperty('logTail')
    expect(value(await f.call({})).logTail).toHaveLength(32_768)
    expect((await f.create().get(f.caller, { workspaceId: 'workspace', ticketId: f.read().id })).run).toEqual(f.read())
    expect(f.endpoint.request).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each([{ step: 'collecting' }, { state: 'passed' as const, exitCode: 0 }, { state: 'canceled' as const }])(
  'wakes an authenticated MCP wait on persisted change %j', async changes => {
    const f = fixture()
    try {
      let settled = false
      const pending = f.call({ waitSeconds: 2, logTail: false }).then(result => { settled = true; return result })
      await pause(100)
      expect(settled).toBe(false)
      const reads = f.query.mock.calls.length
      f.persist({ message: 'More output' })
      f.client.emit('notification', { channel: 'ci_ticket_changed',
        payload: JSON.stringify({ workspaceId: 'other-workspace', ticketId: f.read().id }) })
      await pause(100)
      expect(settled).toBe(false)
      expect(f.query).toHaveBeenCalledTimes(reads)
      f.persist(changes)
      const result = value(await pending)
      expect(result.run).toEqual(f.read())
      expect(result).not.toHaveProperty('logTail')
      expect(f.client.release).toHaveBeenCalledTimes(1)
      expect(f.endpoint.request).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

it('returns at the deadline without repeatedly reading the ticket', async () => {
  const f = fixture()
  try {
    const started = performance.now()
    const pending = f.call({ waitSeconds: 0.3, logTail: false })
    await pause(100)
    const reads = f.query.mock.calls.length
    await pause(100)
    expect(f.query).toHaveBeenCalledTimes(reads)
    expect(value(await pending).run.state).toBe('running')
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it.each(['passed', 'failed', 'canceled', 'lost'] as const)('returns a terminal %s ticket immediately', async state => {
  const f = fixture()
  try {
    f.persist({ state })
    const started = performance.now()
    expect(value(await f.call({ waitSeconds: 60, logTail: false })).run.state).toBe(state)
    expect(performance.now() - started).toBeLessThan(1000)
  } finally { await f.close() }
})

it('cancels an authenticated MCP wait and releases its subscription', async () => {
  const f = fixture()
  try {
    const pending = f.call({ waitSeconds: 60, logTail: false }, 'waiting')
    await pause(100)
    const response = await f.rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'waiting' } })
    expect(response.statusCode).toBe(202)
    const message = await pending
    expect(message.result.isError).toBe(true)
    expect(f.client.release).toHaveBeenCalledTimes(1)
    expect(value(await f.call({ waitSeconds: 0, logTail: false }, 'waiting')).run.state).toBe('running')
  } finally { await f.close() }
})

it('denies an ungranted MCP caller before opening a wait', async () => {
  const f = fixture()
  try {
    const denied = await f.call({ waitSeconds: 60, logTail: false }, 1, 'denied')
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    expect(f.pool.connect).not.toHaveBeenCalled()
    expect(f.services.commands.recordDenied).toHaveBeenCalledWith('denied', 'mcp', 'ci_get', 'mcp:ci_get')
  } finally { await f.close() }
})

it('shares one subscription connection and cancels only the requested MCP wait', async () => {
  const f = fixture()
  try {
    const first = f.call({ waitSeconds: 2, logTail: false }, 'first')
    const second = f.call({ waitSeconds: 2, logTail: false }, 'second')
    await pause(100)
    expect(f.pool.connect).toHaveBeenCalledTimes(1)
    await f.rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'first' } })
    expect((await first).result.isError).toBe(true)
    expect(f.client.release).not.toHaveBeenCalled()
    f.persist({ step: 'collecting' })
    expect(value(await second).run.step).toBe('collecting')
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('reads back a state change that commits while the subscription connection is being acquired', async () => {
  const f = fixture()
  try {
    vi.mocked(f.pool.connect).mockImplementation(async () => {
      f.persist({ state: 'passed', exitCode: 0 })
      return f.client as unknown as pg.PoolClient
    })
    expect(value(await f.call({ waitSeconds: 2, logTail: false })).run.state).toBe('passed')
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('releases the wait when the HTTP client aborts its MCP request', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 })
    const pending = fetch(new URL('/mcp', address), {
      method: 'POST', signal: controller.signal,
      headers: { authorization: 'Bearer reader', accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'disconnect', method: 'tools/call',
        params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.read().id,
          waitSeconds: 60, logTail: false } } }),
    }).then(async response => response.text()).catch(error => error)
    await pause(100)
    expect(f.client.release).not.toHaveBeenCalled()
    controller.abort()
    expect(await pending).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(f.client.release).toHaveBeenCalledTimes(1))
  } finally { controller.abort(); await f.close() }
})

it('describes waiting and tail omission in Operator discovery and tools/list', async () => {
  const f = fixture()
  try {
    const capabilities = ciCapabilities({ principal: f.caller, services: f.services }, { workspaceId: 'workspace' })
    expect(capabilities.find(tool => tool.name === 'ci_get')?.detail).toContain('waitSeconds')
    expect(capabilities.find(tool => tool.name === 'ci_get')?.detail).toContain('logTail=false')
    const response = await f.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    const tool = message.result.tools.find((entry: { name: string }) => entry.name === 'ci_get')
    expect(tool.inputSchema.properties.waitSeconds).toMatchObject({ minimum: 0, maximum: CI_WAIT_MAX_SECONDS })
    expect(tool.inputSchema.properties.logTail.type).toBe('boolean')
  } finally { await f.close() }
})

it('accepts only the group-terminal wait mode for both MCP roles', () => {
  for (const schema of [CiGetInputSchema, OperatorCiGetInputSchema]) {
    const scoped = schema === CiGetInputSchema ? { ticketId: 'ticket' } : { workspaceId: 'workspace', ticketId: 'ticket' }
    expect(schema.safeParse({ ...scoped, waitUntil: 'group-terminal', waitSeconds: 300 }).success).toBe(true)
    expect(schema.safeParse({ ...scoped, waitUntil: 'ticket', waitSeconds: 300 }).success).toBe(false)
  }
})

it('advertises the group-terminal wait in the ci_get schema and description', async () => {
  const f = fixture()
  try {
    const response = await f.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    const tool = message.result.tools.find((entry: { name: string }) => entry.name === 'ci_get')
    expect(JSON.stringify(tool.inputSchema.properties.waitUntil)).toContain('group-terminal')
    expect(tool.description).toContain('waitUntil')
  } finally { await f.close() }
})

it('refuses a group-terminal wait from an ungranted MCP caller before reading the group', async () => {
  const f = fixture()
  try {
    const denied = await f.call({ waitUntil: 'group-terminal', waitSeconds: 300 }, 1, 'denied')
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    expect(f.pool.connect).not.toHaveBeenCalled()
    expect(f.query).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each([{}, { waitUntil: 'group-terminal' as const }])(
  'answers a long %j wait within one 60-second chunk, below the bridge and relay deadlines', async mode => {
    const f = fixture()
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let settled = false
      const pending = f.ci.get(f.caller, { workspaceId: 'workspace', ticketId: f.read().id, logTail: false,
        waitSeconds: CI_WAIT_MAX_SECONDS, ...mode }).then(result => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(59_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(settled).toBe(true)
      const result = await pending
      expect(result.run.state).toBe('running')
      if (mode.waitUntil) expect(result).toMatchObject({ wait: { status: 'still-running', tickets: 1, settledTickets: 0 } })
    } finally { await f.close() }
  })

it('settles a one-ticket group wait only after its results are collected', async () => {
  const f = fixture()
  try {
    let settled = false
    const pending = f.call({ waitUntil: 'group-terminal', waitSeconds: 30, logTail: false })
      .then(result => { settled = true; return result })
    await pause(100)
    f.persist({ state: 'passed', exitCode: 0, collection: 'pending' })
    await pause(100)
    expect(settled).toBe(false)
    f.persist({ collection: 'complete' })
    f.client.emit('notification', { channel: 'ci_ticket_changed',
      payload: JSON.stringify({ workspaceId: 'workspace', ticketId: f.read().id, groupId: f.read().groupId }) })
    expect(value(await pending)).toMatchObject({ run: { state: 'passed', collection: 'complete' },
      wait: { until: 'group-terminal', status: 'settled', tickets: 1, settledTickets: 1 } })
  } finally { await f.close() }
})

it('reports the requested ticket from the same read as the group that settled', async () => {
  const f = fixture()
  try {
    const stale = f.read()
    f.persist({ state: 'passed', exitCode: 0, collection: 'complete' })
    const sibling = CiRunRecordSchema.parse({ ...f.read(), id: '33333333-3333-4333-8333-333333333333', part: 'lint-api' })
    // The ticket row is read first; the group read that follows already sees the collection finish.
    f.query.mockImplementationOnce(async () => ({ rows: [{ record: { ...stale, state: 'passed', exitCode: 0,
      collection: 'pending' }, log_tail: '' }] }))
    f.query.mockImplementationOnce(async () => ({ rows: [{ record: f.read(), log_tail: '' }, { record: sibling, log_tail: '' }] }))
    const result = await f.ci.get(f.caller, { workspaceId: 'workspace', ticketId: f.read().id, logTail: false,
      waitUntil: 'group-terminal' })
    expect(result).toMatchObject({ run: { collection: 'complete' },
      wait: { status: 'settled', tickets: 2, settledTickets: 2 } })
  } finally { await f.close() }
})

it.each([{}, { waitUntil: 'group-terminal' as const }])(
  'returns the collected log with the settled record when collection finishes between %j readbacks', async mode => {
    const f = fixture()
    try {
      const collecting = { ...f.read(), state: 'passed' as const, exitCode: 0, collection: 'pending' as const }
      f.persist({ state: 'passed', exitCode: 0, collection: 'complete' })
      f.query.mockResolvedValueOnce({ rows: [{ record: collecting, log_tail: '' }] })
      f.query.mockResolvedValueOnce({ rows: [{ record: f.read(), log_tail: 'npm run integration\n' }] })
      const result = value(await f.call(mode))
      expect(result.run).toEqual(f.read())
      expect(result.logTail).toBe('npm run integration\n')
      if (mode.waitUntil) expect(result).toMatchObject({ wait: { status: 'settled' } })
    } finally { await f.close() }
  })
