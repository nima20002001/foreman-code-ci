import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import Fastify from 'fastify'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { GraphqlAgentTool } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { rejectableDeferred } from './helpers/deferred.js'

const principal: ManagementPrincipal = {
  id: 'worker', name: 'Worker', audience: 'worker', agentId: 'agent',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['interactions:read', 'ci'], scope: {
    workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'],
  } }],
}
const expectedTools = ['context_get', 'ci_run', 'ci_get', 'ci_computers_list', 'ci_logs_read'].sort()
const savedAccess = () => ({
  role: 'coder', defaults: ['context_get', 'interaction_list', 'ci_get'],
  override: { add: ['ci_run', 'ci_computers_list', 'ci_logs_read'], remove: ['interaction_list'] },
})

function fixture(options: { ci?: boolean; defaults?: GraphqlAgentTool[] } = {}) {
  const saved = savedAccess()
  if (options.defaults) {
    saved.defaults = options.defaults
    saved.override = { add: [], remove: [] }
  }
  const query = vi.fn().mockImplementation(async () => ({ rows: [structuredClone(saved)] }))
  const pool = { query } as unknown as pg.Pool
  const interactions = new PostgresAppInteractionService(pool, {} as never, {} as never)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'worker-token') throw new DomainError('AUTH_INVALID', 'Invalid credential.', 401)
    return principal
  })
  const commands = { recordDenied: vi.fn().mockResolvedValue(undefined) }
  const operator = { commands, ...(options.ci === false ? {} : { ci: {} }) } as unknown as OperatorServices
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof DomainError ? error.status : 500).send({ error: {
      code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error),
    } })
  })
  const services = { access, interactions, operator, references: workerToolServices(pool, commands as unknown as PostgresCommandCoordinator).references }
  registerGraphqlMcp(app, services)
  const rpc = (method: string, params?: object, token = 'worker-token') => app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  })
  return { services, app, rpc, query, saved, operator, commands }
}

function decode(body: string) {
  const data = body.split('\n').find(line => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : body) as {
    result?: { tools?: Array<{ name: string }>; nextCursor?: string; isError?: boolean }
    error?: { code: string; message: string }
  }
}

describe('authenticated workflow MCP tool discovery', () => {
  it('initializes and lists the complete saved node selection, then enforces a removed read tool', async () => {
    const f = fixture()
    try {
      const initialized = await f.rpc('initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'discovery-test', version: '1' },
      })
      expect(initialized.statusCode).toBe(200)
      const listed = await f.rpc('tools/list')
      expect(listed.statusCode).toBe(200)
      expect(decode(listed.body).result?.tools?.map(tool => tool.name).sort()).toEqual(expectedTools)
      expect(decode(listed.body).result?.nextCursor).toBeUndefined()
      expect(decode((await f.rpc('tools/list')).body)).toEqual(decode(listed.body))
      const denied = await f.rpc('tools/call', { name: 'interaction_list', arguments: {} })
      expect(decode(denied.body).result?.isError).toBe(true)
      expect(denied.body).toContain('TOOL_NOT_ENABLED')
      expect(f.commands.recordDenied).toHaveBeenCalledOnce()
    } finally { await f.app.close() }
  })

  it('rejects an invalid bearer before reading the node configuration', async () => {
    const f = fixture()
    try {
      expect((await f.rpc('tools/list', undefined, 'invalid')).statusCode).toBe(401)
      expect(f.query).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })

  it('waits for the complete configuration instead of returning a partial catalog during a slow read', async () => {
    const f = fixture()
    const started = rejectableDeferred<void>()
    const result = rejectableDeferred<{ rows: ReturnType<typeof savedAccess>[] }>()
    f.query.mockImplementationOnce(() => { started.resolve(); return result.promise })
    let completed = false
    try {
      const pending = f.rpc('tools/list').then(response => { completed = true; return response })
      await started.promise
      expect(completed).toBe(false)
      result.resolve({ rows: [f.saved] })
      const response = await pending
      expect(response.statusCode).toBe(200)
      expect(decode(response.body).result?.tools?.map(tool => tool.name).sort()).toEqual(expectedTools)
    } finally { result.resolve({ rows: [f.saved] }); await f.app.close() }
  })

  it('discovers selected reference tools along with context from the shared Worker services', async () => {
    const f = fixture({ defaults: ['context_get', 'files.references_list', 'files.reference_read'] })
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(200)
      expect(decode(response.body).result?.tools?.map(tool => tool.name).sort())
        .toEqual(['context_get', 'files.reference_read', 'files.references_list'])
    } finally { await f.app.close() }
  })

  it('still fails discovery when selected reference services are deliberately absent', async () => {
    const f = fixture({ defaults: ['context_get', 'files.references_list', 'files.reference_read'] })
    delete (f.services as { references?: unknown }).references
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(503)
      expect(decode(response.body).error?.code).toBe('MCP_TOOL_DISCOVERY_FAILED')
    } finally { await f.app.close() }
  })

  it('fails discovery when the pinned configuration cannot be read', async () => {
    const f = fixture()
    f.query.mockRejectedValueOnce(Object.assign(new Error('Query read timeout'), { code: '57014' }))
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(500)
      expect(decode(response.body).result).toBeUndefined()
    } finally { await f.app.close() }
  })

  it('fails instead of inventing defaults when the bound configuration or workflow node is missing', async () => {
    const f = fixture()
    f.query.mockResolvedValue({ rows: [] })
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(503)
      expect(decode(response.body).result).toBeUndefined()
      expect(decode(response.body).error?.code).toBe('MCP_TOOL_DISCOVERY_FAILED')
    } finally { await f.app.close() }
  })

  it('fails instead of listing only context when the selected CI service is unavailable', async () => {
    const f = fixture({ ci: false })
    try {
      for (const method of ['initialize', 'tools/list']) {
        const response = await f.rpc(method, method === 'initialize' ? {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'discovery-test', version: '1' },
        } : undefined)
        expect(response.statusCode).toBe(503)
        expect(decode(response.body).result).toBeUndefined()
        expect(decode(response.body).error?.code).toBe('MCP_TOOL_DISCOVERY_FAILED')
      }
      f.operator.ci = {} as NonNullable<OperatorServices['ci']>
      const recovered = await f.rpc('tools/list')
      expect(recovered.statusCode).toBe(200)
      expect(decode(recovered.body).result?.tools?.map(tool => tool.name).sort()).toEqual(expectedTools)
    } finally { await f.app.close() }
  })

  it('keeps intentional node limits when CI is unavailable and no CI tools were selected', async () => {
    const f = fixture({ ci: false, defaults: ['context_get'] })
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(200)
      expect(decode(response.body).result?.tools?.map(tool => tool.name)).toEqual(['context_get'])
    } finally { await f.app.close() }
  })

  it('fails loudly when no authorized tools can be registered', async () => {
    const f = fixture({ defaults: [] })
    try {
      const response = await f.rpc('tools/list')
      expect(response.statusCode).toBe(503)
      expect(decode(response.body).result).toBeUndefined()
      expect(decode(response.body).error?.code).toBe('MCP_TOOL_DISCOVERY_FAILED')
    } finally { await f.app.close() }
  })
})
