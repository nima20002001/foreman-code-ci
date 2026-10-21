import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server'
import { ManagedWorkspaceSchema, WorkspaceGetInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'

import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { DomainError } from '../src/modules/errors.js'
import { installOperatorPresentation } from '../src/mcp/operator/presentation.js'
import { registerOperatorTools } from '../src/mcp/operator/server.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { cacheToolSchemaConversions } from '../src/mcp/shared/schemaCache.js'
import { stripMcpInputSchemas } from '../src/mcp/shared/inputSchemas.js'
import { paginateToolLists } from '../src/mcp/toolListPagination.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'

it('reuses input and output conversions across servers while preserving defaults and validation', async () => {
  const schema = z.object({ value: z.string().default('default') }).strict()
  const converters = schema['~standard'].jsonSchema
  const inputConversion = vi.spyOn(converters, 'input')
  const outputConversion = vi.spyOn(converters, 'output')
  const clients: Client[] = []
  const servers: McpServer[] = []
  async function connect(cached: boolean) {
    const server = new McpServer({ name: 'schema-fixture', version: '1' })
    servers.push(server)
    if (cached) cacheToolSchemaConversions(server, 'test')
    server.registerTool('echo', { inputSchema: schema, outputSchema: schema }, async input => ({
      content: [], structuredContent: input,
    }))
    server.registerTool('invalid_output', { inputSchema: schema, outputSchema: schema }, async () => ({
      content: [], structuredContent: { value: 7 },
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'schema-client', version: '1' })
    clients.push(client)
    await client.connect(clientTransport)
    return client
  }
  try {
    const reference = await connect(false)
    const referenceList = await reference.listTools()
    const referenceCall = await reference.callTool({ name: 'echo', arguments: {} })
    const invalidInput = await reference.callTool({ name: 'echo', arguments: { value: 7 } })
    const invalidOutput = await reference.callTool({ name: 'invalid_output', arguments: {} })
    inputConversion.mockClear()
    outputConversion.mockClear()
    for (let request = 0; request < 3; request++) {
      const client = await connect(true)
      expect(await client.listTools()).toEqual(referenceList)
      expect(await client.callTool({ name: 'echo', arguments: {} })).toEqual(referenceCall)
      expect(await client.callTool({ name: 'echo', arguments: { value: 7 } })).toEqual(invalidInput)
      expect(await client.callTool({ name: 'invalid_output', arguments: {} })).toEqual(invalidOutput)
    }
    expect(referenceCall.structuredContent).toEqual({ value: 'default' })
    expect(invalidInput.isError).toBe(true)
    expect(invalidOutput.isError).toBe(true)
    expect(inputConversion).toHaveBeenCalledExactlyOnceWith({ target: 'draft-2020-12' })
    expect(outputConversion).toHaveBeenCalledExactlyOnceWith({ target: 'draft-2020-12' })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await Promise.all(servers.map(server => server.close()))
    vi.restoreAllMocks()
  }
})

it('keeps authenticated HTTP catalogs, calls and caller scopes fresh after warming the schema cache', async () => {
  const principal: ManagementPrincipal = {
    id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: { workspaceIds: ['workspace'] } }],
  }
  let caller = principal
  const workspace = ManagedWorkspaceSchema.parse({
    workspace: { id: 'workspace', name: 'Example project' }, revision: 1, archivedAt: null,
    executionLocation: null, locationRevision: 1, locationValidation: { status: 'unconfigured' },
  })
  const get = vi.fn(async (actor: ManagementPrincipal, workspaceId: string) => {
    requireAuthorization(actor, 'workspaces:read', { workspaceId })
    return workspace
  })
  const recordDenied = vi.fn(async () => undefined)
  const services = { commands: { recordDenied }, circleAccounts: {}, workspaces: { get } } as unknown as OperatorServices
  const access = new PostgresAccessService({} as never)
  const authenticate = vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'synthetic-token') throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return caller
  })
  const inputConversion = vi.spyOn(WorkspaceGetInputSchema['~standard'].jsonSchema, 'input')
  const outputConversion = vi.spyOn(ManagedWorkspaceSchema['~standard'].jsonSchema, 'output')
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    if (!(error instanceof DomainError)) throw error
    return reply.code(error.status).send({ error: { code: error.code } })
  })
  registerGraphqlMcp(app, { access, operator: services })
  const referenceServer = new McpServer({ name: 'operator-reference', version: '1' })
  stripMcpInputSchemas(referenceServer)
  paginateToolLists(referenceServer)
  const catalog = installOperatorPresentation(referenceServer)
  registerOperatorTools(referenceServer, { principal, services }, catalog)
  const reference = new Client({ name: 'operator-reference-client', version: '1' })
  async function rpc<Result>(method: string, params?: Record<string, unknown>): Promise<Result> {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer synthetic-token', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    })
    expect(response.statusCode).toBe(200)
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    const message = data ? JSON.parse(data.slice(6)) : response.json()
    expect(message.error).toBeUndefined()
    return message.result as Result
  }
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await referenceServer.connect(serverTransport)
    await reference.connect(clientTransport)
    const referenceList = await reference.listTools()
    const params = { name: 'workspace_get', arguments: { workspaceId: 'workspace' } }
    const referenceCall = await reference.callTool(params)
    expect(await rpc<ListToolsResult>('tools/list')).toEqual(referenceList)
    inputConversion.mockClear()
    outputConversion.mockClear()
    for (let request = 0; request < 3; request++) {
      expect(await rpc<ListToolsResult>('tools/list')).toEqual(referenceList)
      expect(await rpc<CallToolResult>('tools/call', params)).toEqual(referenceCall)
    }
    expect(inputConversion).not.toHaveBeenCalled()
    expect(outputConversion).not.toHaveBeenCalled()
    expect(decodeMcpToolResult(referenceCall)).toEqual(workspace)
    const scopeDenied = await rpc<CallToolResult>('tools/call', {
      name: 'workspace_get', arguments: { workspaceId: 'other-workspace' },
    })
    expect(scopeDenied.isError).toBe(true)
    expect(JSON.stringify(scopeDenied.content)).toContain('ACCESS_DENIED')
    expect(recordDenied).toHaveBeenCalledWith('reader', 'mcp', 'workspace_get', 'mcp:workspace_get')
    caller = { ...principal, id: 'denied-reader', grants: [{ actions: ['capabilities:read'], scope: {} }] }
    const deniedCatalog = await rpc<ListToolsResult>('tools/list')
    expect(deniedCatalog.tools.map(tool => tool.name)).toContain('operator_tool_schema_get')
    expect(deniedCatalog.tools.map(tool => tool.name)).not.toContain('workspace_get')
    caller = { ...principal, id: 'settings-reader', grants: [{ actions: ['settings:read'], scope: {} }] }
    const settingsCatalog = await rpc<ListToolsResult>('tools/list')
    expect(settingsCatalog.tools.map(tool => tool.name)).toContain('circle_accounts_list')
    expect(settingsCatalog.tools.map(tool => tool.name)).not.toContain('circle_account_add')
    caller = { ...caller, grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] }
    const writerCatalog = await rpc<ListToolsResult>('tools/list')
    expect(writerCatalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'circle_accounts_list', 'circle_account_add', 'circle_account_remove',
    ]))
    caller = { ...caller, grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] }
    const schema = await rpc<CallToolResult>('tools/call', {
      name: 'operator_tool_schema_get', arguments: { name: 'circle_account_add' },
    })
    expect(schema.isError).not.toBe(true)
    expect(JSON.stringify(schema)).toContain('organizations')
    caller = { ...principal, id: 'denied-reader', grants: [{ actions: ['capabilities:read'], scope: {} }] }
    const callsBeforeDenial = get.mock.calls.length
    const grantDenied = await rpc<CallToolResult>('tools/call', params)
    expect(grantDenied.isError).toBe(true)
    expect(JSON.stringify(grantDenied.content)).toContain('ACCESS_DENIED')
    expect(recordDenied).toHaveBeenCalledWith('denied-reader', 'mcp', 'workspace_get', 'mcp:workspace_get')
    expect(get).toHaveBeenCalledTimes(callsBeforeDenial)
    const rejected = await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: 'Bearer invalid-token' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(rejected.statusCode).toBe(401)
    expect(authenticate).toHaveBeenCalledWith('invalid-token', ['operator'])
  } finally {
    await reference.close()
    await referenceServer.close()
    await app.close()
    vi.restoreAllMocks()
  }
})
