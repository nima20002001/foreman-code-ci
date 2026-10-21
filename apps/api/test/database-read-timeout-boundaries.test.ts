import { afterEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
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
  grants: [{ actions: ['workspaces:read'], scope: {} }],
}
const timeouts = [
  { error: () => new Error('Query read timeout'), details: { retryable: true, reason: 'query_read_timeout' } },
  { error: () => Object.assign(new Error('private SQL and values'), { code: '57014' }),
    details: { retryable: true, reason: 'query_canceled', sqlState: '57014' } },
  { error: () => Object.assign(new Error('private lock details'), { code: '55P03' }),
    details: { retryable: true, reason: 'lock_timeout', sqlState: '55P03' } },
]

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

it.each(timeouts)('maps an unhandled HTTP database deadline to a retryable 503: $details.reason', async timeout => {
  const app = buildApp({ readiness })
  apps.push(app)
  app.get('/database-read', async () => { throw timeout.error() })
  const response = await app.inject('/database-read')
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual({ error: {
    code: 'DATABASE_READ_TIMEOUT', message: 'The database read exceeded its deadline. Retry the request.',
    details: timeout.details, requestId: expect.any(String),
  } })
})

it.each(timeouts)('maps MCP authentication deadlines before parsing the body: $details.reason', async timeout => {
  const query = vi.fn().mockRejectedValue(timeout.error())
  const recordDenied = vi.fn().mockResolvedValue(undefined)
  const access = new PostgresAccessService({ query } as unknown as pg.Pool)
  const services = { commands: { recordDenied } } as unknown as OperatorServices
  const app = buildApp({ readiness, operator: { access, services } })
  apps.push(app)
  const response = await app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    payload: '{invalid json',
  })
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual({ error: {
    code: 'DATABASE_READ_TIMEOUT', message: 'The database read exceeded its deadline. Retry the request.',
    details: timeout.details, requestId: expect.any(String),
  } })
  expect(query).toHaveBeenCalledOnce()
  expect(recordDenied).not.toHaveBeenCalled()
})

it('maps a database reply deadline inside an authenticated MCP tool', async () => {
  const access = new PostgresAccessService({} as pg.Pool)
  vi.spyOn(access, 'authenticate').mockResolvedValue(principal)
  const get = vi.fn().mockRejectedValue(new Error('Query read timeout'))
  const services = { commands: { recordDenied: vi.fn() }, workspaces: { get } } as unknown as OperatorServices
  const app = buildApp({ readiness, operator: { access, services } })
  apps.push(app)
  const response = await app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer fixture-token', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'workspace_get', arguments: { workspaceId: 'workspace' } } },
  })
  expect(response.statusCode).toBe(200)
  const data = response.body.startsWith('event:')
    ? response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : response.body
  const reply = JSON.parse(data)
  expect(reply.result.isError).toBe(true)
  expect(JSON.parse(reply.result.content[0].text)).toEqual({ error: {
    code: 'DATABASE_READ_TIMEOUT', message: 'The database read exceeded its deadline. Retry the request.',
    details: { retryable: true, reason: 'query_read_timeout' },
  } })
  expect(get).toHaveBeenCalledOnce()
})

it('preserves an explicit refusal even when its cause is a database timeout', async () => {
  const app = buildApp({ readiness })
  apps.push(app)
  app.get('/refused', async () => {
    throw new DomainError('ACCESS_DENIED', 'This resource is outside the caller scope.', 403,
      { retryable: false }, { cause: new Error('Query read timeout') })
  })
  const response = await app.inject('/refused')
  expect(response.statusCode).toBe(403)
  expect(response.json().error).toMatchObject({ code: 'ACCESS_DENIED', details: { retryable: false } })
})
