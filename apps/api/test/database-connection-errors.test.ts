import { afterEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'

const apps: ReturnType<typeof buildApp>[] = []
const readiness = {
  database: { ping: async () => undefined },
  checkpoints: { ping: async () => undefined },
}
const principal: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['ci', 'workspaces:read'], scope: {} }],
}
const failures = [
  { name: 'pool checkout timeout', error: () => new Error('timeout exceeded when trying to connect') },
  { name: 'connection establishment timeout',
    error: () => new Error('Connection terminated due to connection timeout', {
      cause: new Error('private connection credentials'),
    }) },
  { name: 'server connection limit', error: () => Object.assign(new Error('private database role'), { code: '53300' }) },
  { name: 'server starting', error: () => Object.assign(new Error('private database address'), { code: '57P03' }) },
]
const busy = { error: {
  code: 'DATABASE_BUSY',
  message: 'A database connection is temporarily unavailable. Retry shortly with the same commandId if supplied.',
  details: { retryable: true, newCommandRequired: false },
} }

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  vi.restoreAllMocks()
})

function fixture(run = vi.fn(), recordAudit = vi.fn().mockResolvedValue(undefined)) {
  const access = new PostgresAccessService({} as pg.Pool)
  vi.spyOn(access, 'authenticate').mockResolvedValue(principal)
  const commands = { recordAudit, recordDenied: vi.fn().mockResolvedValue(undefined) }
  const get = vi.fn()
  const services = { commands, ci: { run }, workspaces: { get } } as unknown as OperatorServices
  const app = buildApp({ readiness, operator: { access, services } })
  apps.push(app)
  return { app, run, commands, get, access }
}

async function callTool(app: ReturnType<typeof buildApp>, name: string, arguments_: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer fixture-token', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
  })
  expect(response.statusCode).toBe(200)
  const data = response.body.startsWith('event:')
    ? response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : response.body
  return JSON.parse(data).result
}

it.each(failures)('returns a retryable HTTP 503 for $name', async failure => {
  const { app } = fixture()
  app.post('/database-command', async () => { throw failure.error() })
  const response = await app.inject({ method: 'POST', url: '/database-command', payload: { commandId: 'original' } })
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual({ error: { ...busy.error, requestId: expect.any(String) } })
  expect(response.body).not.toContain('private')
})

it.each(failures)('returns DATABASE_BUSY from an authenticated MCP write for $name', async failure => {
  const f = fixture(vi.fn().mockRejectedValue(failure.error()))
  const input = { workspaceId: 'workspace', suite: 'unit', commandId: 'original' }
  const result = await callTool(f.app, 'ci_run', input)
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0].text)).toEqual(busy)
  expect(f.run).toHaveBeenCalledExactlyOnceWith(principal, input)
  expect(f.commands.recordAudit).toHaveBeenCalledWith('operator', 'mcp', 'ci_run', 'mcp:ci_run', 'failed', {
    code: 'DATABASE_BUSY',
  })
})

it('keeps the MCP availability error when recording its audit also cannot connect', async () => {
  const failure = failures[1]!.error()
  const f = fixture(vi.fn().mockRejectedValue(failure), vi.fn().mockRejectedValue(failure))
  const result = await callTool(f.app, 'ci_run', { workspaceId: 'workspace', suite: 'unit', commandId: 'original' })
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0].text)).toEqual(busy)
  expect(f.commands.recordAudit).toHaveBeenCalledOnce()
})

it('uses the same command identity when the caller retries a failed MCP write', async () => {
  const accepted = { ticketId: 'ticket' }
  const f = fixture(vi.fn().mockRejectedValueOnce(failures[0]!.error()).mockResolvedValue(accepted))
  const input = { workspaceId: 'workspace', suite: 'unit', commandId: 'original' }
  const failed = await callTool(f.app, 'ci_run', input)
  expect(JSON.parse(failed.content[0].text)).toEqual(busy)
  expect(f.run).toHaveBeenCalledOnce()
  const retried = await callTool(f.app, 'ci_run', input)
  expect(retried.isError).not.toBe(true)
  expect(decodeMcpToolResult(retried)).toEqual(accepted)
  expect(f.run.mock.calls.map(call => call[1])).toEqual([input, input])
})

it('maps database acquisition failures during MCP authentication to HTTP 503', async () => {
  const f = fixture()
  vi.mocked(f.access.authenticate).mockRejectedValue(failures[0]!.error())
  const response = await f.app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer fixture-token' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ci_run', arguments: { workspaceId: 'workspace', suite: 'unit' } } },
  })
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual({ error: { ...busy.error, requestId: expect.any(String) } })
  expect(f.run).not.toHaveBeenCalled()
})

it('maps acquisition failures through the ordinary Operator tool boundary', async () => {
  const f = fixture()
  f.get.mockRejectedValue(failures[1]!.error())
  const result = await callTool(f.app, 'workspace_get', { workspaceId: 'workspace' })
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0].text)).toEqual(busy)
})

it('keeps a denied caller denied and does not invoke CI', async () => {
  const f = fixture()
  vi.mocked(f.access.authenticate).mockResolvedValue({ ...principal, grants: [] })
  const result = await callTool(f.app, 'ci_run', { workspaceId: 'workspace', suite: 'unit' })
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0].text).error.code).toBe('ACCESS_DENIED')
  expect(f.run).not.toHaveBeenCalled()
})

it('preserves an explicit nonretryable refusal with a connection timeout cause', async () => {
  const f = fixture(vi.fn().mockRejectedValue(new DomainError('ACCESS_DENIED', 'Access denied.', 403,
    { retryable: false }, { cause: failures[0]!.error() })))
  const result = await callTool(f.app, 'ci_run', { workspaceId: 'workspace', suite: 'unit' })
  expect(JSON.parse(result.content[0].text).error).toEqual({
    code: 'ACCESS_DENIED', message: 'Access denied.', details: { retryable: false },
  })
})

it('does not mislabel an unrelated socket failure as a database acquisition failure', async () => {
  const f = fixture(vi.fn().mockRejectedValue(Object.assign(new Error('private provider address'), { code: 'ETIMEDOUT' })))
  const result = await callTool(f.app, 'ci_run', { workspaceId: 'workspace', suite: 'unit' })
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0].text).error.code).toBe('INTERNAL_ERROR')
  expect(result.content[0].text).not.toContain('private')
})
