import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { jobSpec } from './helpers/jobFixture.js'

it('mounts supplied Jobs through shared management composition with authenticated HTTP/MCP reads and denied writes', async () => {
  const principal = ManagementPrincipalSchema.parse({ id: 'job-reader', name: 'Job reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: ['workspace-fixture'] } }] })
  const query = vi.fn(async (sql: string) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 }
    if (sql.startsWith('select id,name,audience,grants')) return { rows: [{ id: principal.id, name: principal.name,
      audience: principal.audience, grants: principal.grants, expires_at: new Date(principal.expiresAt),
      revoked_at: null, delegated_from: null }], rowCount: 1 }
    if (sql.startsWith('select record from job_definitions')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected Job read SQL: ${sql}`)
  })
  const connect = vi.fn(async () => ({ query, release: vi.fn() })), recordDenied = vi.fn(async () => undefined)
  const commands = { recordDenied } as unknown as PostgresCommandCoordinator
  const accept = vi.fn()
  const jobs = new JobService({ connect } as unknown as pg.Pool, commands,
    { preparation: { accept } as never, dispatch: {} as never, artifacts: {} as never })
  const authenticate = vi.fn(async (token: string | undefined) => {
    if (token !== 'recorded-reader') throw new Error('Unexpected authentication input.')
    return principal
  })
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: { authenticate } as unknown as PostgresAccessService,
      services: { jobs, commands } as unknown as OperatorServices } })
  const root = '/api/management/workspaces/workspace-fixture/jobs'
  const headers = { authorization: 'Bearer recorded-reader' }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    expect(response.statusCode).toBe(200)
    return JSON.parse(response.body.startsWith('event:') ? response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : response.body)
  }
  try {
    const read = await app.inject({ method: 'GET', url: `${root}/definitions`, headers })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ definitions: [] })
    expect(decodeMcpToolResult((await rpc('job_definition_list', { workspaceId: 'workspace-fixture' })).result)).toEqual(read.json())
    const acceptedReads = connect.mock.calls.length
    const input = { commandId: 'denied-save', expectedRevision: null, name: 'Denied', spec: jobSpec() }
    expect((await app.inject({ method: 'POST', url: `${root}/definitions`, headers, payload: input })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/management/workspaces/foreign/jobs/definitions', headers })).statusCode).toBe(403)
    expect((await rpc('job_definition_save', { ...input, workspaceId: 'workspace-fixture' })).result.isError).toBe(true)
    expect(connect).toHaveBeenCalledTimes(acceptedReads)
    expect(accept).not.toHaveBeenCalled()
    expect(recordDenied).toHaveBeenCalledWith(principal.id, 'http', 'job.definition.save', 'workspace-fixture')
    expect(recordDenied).toHaveBeenCalledWith(principal.id, 'http', 'job_definitions:read', 'foreign')
    expect(recordDenied).toHaveBeenCalledWith(principal.id, 'mcp', 'job_definition_save', 'mcp:job_definition_save')
    expect(authenticate).toHaveBeenCalled()
  } finally { await app.close() }
})
