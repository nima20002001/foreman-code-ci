import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../src/modules/devices/deviceWire.js'
import { DomainError } from '../src/modules/errors.js'

it.each([
  ['ci_run', new DeviceApplicationAdmissionError(), { workspaceId: 'workspace', suite: 'unit' }],
  ['ci_logs_read', new DeviceApplicationError('backpressure'), { workspaceId: 'workspace', ticketId: 'ticket' }],
  ['ci_logs_read', new DeviceConnectionError('backpressure'), { workspaceId: 'workspace', ticketId: 'ticket' }],
] as const)('returns retryable device pressure to an authenticated %s caller', async (name, failure, input) => {
  const principal: ManagementPrincipal = {
    id: 'operator', name: 'Operator', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null, grants: [{ actions: ['ci', 'jobs:read', 'job_logs:read', 'job_artifacts:read'], scope: {} }],
  }
  const run = vi.fn(async () => { throw failure })
  const logs = vi.fn(async () => { throw failure })
  const recordDenied = vi.fn().mockResolvedValue(undefined)
  const recordAudit = vi.fn().mockResolvedValue(undefined)
  const services = { ci: { run, logs }, commands: { recordDenied, recordAudit } } as unknown as OperatorServices
  const access = new PostgresAccessService({} as never)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'caller-token') return principal
    if (token === 'denied-token') return { ...principal, grants: [] }
    throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
  })
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'request failed' })
  })
  registerGraphqlMcp(app, { access, operator: services })
  const call = (token: string) => app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } },
  })
  try {
    const response = await call('caller-token')
    expect(response.statusCode).toBe(200)
    const json = response.body.startsWith('event:')
      ? response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : response.body
    const result = JSON.parse(json).result
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.parse(result.content[0].text).error).toMatchObject({
      code: 'DEVICE_BUSY', details: { retryable: true, reason: 'backpressure' },
    })
    expect(recordAudit).toHaveBeenCalledWith('operator', 'mcp', name, `mcp:${name}`, 'failed', { code: 'DEVICE_BUSY' })
    await call('denied-token')
    expect(recordDenied).toHaveBeenCalled()
    expect(run.mock.calls.length + logs.mock.calls.length).toBe(1)
    expect((await call('invalid-token')).statusCode).toBe(401)
  } finally { await app.close() }
})
