import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { DomainError } from '../src/modules/errors.js'
import { acquireDatabaseConnection } from '../src/infrastructure/databaseReadRetry.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { retryReadOnlyToolConnections } from '../src/mcp/shared/databaseReadRetry.js'
import { toolFailure, toolResult } from '../src/mcp/shared/results.js'

const principal: ManagementPrincipal = {
  id: 'reader', name: 'Reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: { workspaceIds: ['workspace'] } }],
}
const timeout = () => new Error('timeout exceeded when trying to connect')
const workspace = ManagedWorkspaceSchema.parse({
  workspace: { id: 'workspace', name: 'Saved project' }, revision: 1, archivedAt: null,
  executionLocation: null, locationRevision: 1, locationValidation: { status: 'unconfigured' },
})

function decode(body: string) {
  const json = body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body
  return JSON.parse(json) as { result?: { isError?: boolean; content: Array<{ text: string }> } }
}

describe('authenticated MCP database connection recovery', () => {
  it('retries at most once even when a read formats errors, and never retries a mutation', async () => {
    const acquire = vi.fn().mockRejectedValue(timeout())
    const server = new McpServer({ name: 'connection-retry', version: '1' })
    retryReadOnlyToolConnections(server)
    for (const readOnlyHint of [true, false]) {
      server.registerTool(readOnlyHint ? 'read' : 'write', {
        inputSchema: z.object({}), annotations: { readOnlyHint },
      }, async () => {
        try { return toolResult(await acquireDatabaseConnection(acquire)) }
        catch (error) { return toolFailure(error) }
      })
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'reader', version: '1' })
    await client.connect(clientTransport)
    try {
      expect((await client.callTool({ name: 'read', arguments: {} })).isError).toBe(true)
      expect(acquire).toHaveBeenCalledTimes(2)
      acquire.mockClear()
      expect((await client.callTool({ name: 'write', arguments: {} })).isError).toBe(true)
      expect(acquire).toHaveBeenCalledOnce()
    } finally { await client.close(); await server.close() }
  })

  it('retries a read acquisition once, reads the saved value, and preserves scope denial', async () => {
    const acquire = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
    const get = vi.fn(async (actor: ManagementPrincipal, id: string) => {
      await acquireDatabaseConnection(acquire)
      requireAuthorization(actor, 'workspaces:read', { workspaceId: id })
      return workspace
    })
    const recordDenied = vi.fn().mockResolvedValue(undefined)
    const services = { commands: { recordDenied }, workspaces: { get } } as unknown as OperatorServices
    const access = new PostgresAccessService({} as never)
    const authenticateConnection = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
    vi.spyOn(access, 'authenticate').mockImplementation(async token => {
      if (token !== 'reader-token') throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
      await acquireDatabaseConnection(authenticateConnection)
      return principal
    })
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      reply.code(error instanceof DomainError ? error.status : 500).send({ error: 'request failed' })
    })
    registerGraphqlMcp(app, { access, operator: services })
    const read = (id: string, token = 'reader-token') => app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'workspace_get', arguments: { workspaceId: id },
      } },
    })
    try {
      const response = await read('workspace')
      expect(response.statusCode).toBe(200)
      expect(decode(response.body).result?.isError).not.toBe(true)
      expect(response.body).toContain('Saved project')
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(authenticateConnection).toHaveBeenCalledTimes(3)
      expect(get).toHaveBeenCalledOnce()
      const denied = await read('another-workspace')
      expect(decode(denied.body).result?.isError).toBe(true)
      expect(denied.body).toContain('ACCESS_DENIED')
      expect(recordDenied).toHaveBeenCalledOnce()
      const beforeInvalid = get.mock.calls.length
      expect((await read('workspace', 'invalid')).statusCode).toBe(401)
      expect(get).toHaveBeenCalledTimes(beforeInvalid)
    } finally { await app.close() }
  })

  it('does not perform artifact discovery for ordinary Worker reads and still lists artifacts', async () => {
    const access = new PostgresAccessService({} as never)
    vi.spyOn(access, 'authenticate').mockResolvedValue({ ...principal, audience: 'worker', agentId: 'agent' })
    const acquire = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
    const interactions = {
      toolAccess: async () => ({ role: 'coder', tools: ['interaction_list'] }),
      canRead: async () => true, canRespond: async () => false,
      list: async () => {
        await acquireDatabaseConnection(acquire)
        return { items: [], nextCursor: null }
      },
    } as unknown as AppInteractionService
    const register = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockResolvedValue(undefined)
    const app = Fastify()
    registerGraphqlMcp(app, { access, interactions, workerArtifacts: () => ({ register, call }) })
    const rpc = (method: string, params?: object) => app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer worker-token', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    })
    try {
      const response = await rpc('tools/call', { name: 'interaction_list', arguments: {} })
      expect(decode(response.body).result?.isError).not.toBe(true)
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(register).not.toHaveBeenCalled()
      await rpc('tools/list')
      expect(register).toHaveBeenCalledOnce()
      const artifactConnection = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue(undefined)
      call.mockImplementationOnce(async () => {
        await acquireDatabaseConnection(artifactConnection)
        return { jsonrpc: '2.0', id: 1, result: toolResult({ artifact: 'authorized input' }) }
      })
      const artifact = await rpc('tools/call', { name: 'files.read_edge_input', arguments: {} })
      expect(artifact.body).toContain('authorized input')
      expect(artifactConnection).toHaveBeenCalledTimes(2)
      expect(register).toHaveBeenCalledOnce()
    } finally { await app.close() }
  })
})
