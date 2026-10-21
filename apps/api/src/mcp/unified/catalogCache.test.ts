import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server'
import { ManagedWorkspaceSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from './transport.js'
import { requireAuthorization } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import type { OperatorServices } from '../operator/types.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'

const principal: ManagementPrincipal = {
  id: 'reader', name: 'Reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspaces:read', 'workspace_locations:read', 'capabilities:read', 'ci', 'jobs:read', 'job_logs:read', 'job_artifacts:read', 'job_definitions:read'],
    scope: { workspaceIds: ['workspace'] } }],
}

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const callers = new Map<string, ManagementPrincipal>([['reader', principal]])
  const workspace = ManagedWorkspaceSchema.parse({
    workspace: { id: 'workspace', name: 'Example project' }, revision: 1, archivedAt: null,
    executionLocation: null, locationRevision: 1, locationValidation: { status: 'unconfigured' },
  })
  const get = vi.fn(async (actor: ManagementPrincipal, workspaceId: string) => {
    requireAuthorization(actor, 'workspaces:read', { workspaceId })
    return structuredClone(workspace)
  })
  const recordDenied = vi.fn(async () => undefined)
  const services = { ci: {}, jobRuntimeProfiles: {}, workspaces: { get }, commands: { recordDenied } } as unknown as OperatorServices
  let role: 'coder' | 'orchestrator' = 'coder'
  let tools = ['context_get']
  let canRead = false
  const interactions = {
    toolAccess: async () => ({ role, tools }),
    canRead: vi.fn(async () => canRead), canRespond: vi.fn(async () => false),
    context: async (actor: ManagementPrincipal) => { throw new DomainError('CALLER_FIXTURE', actor.id, 400) },
  } as unknown as AppInteractionService
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
    .send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
  registerGraphqlMcp(app, { operator: services, interactions, access: { authenticate: async (token: string) => {
    const caller = callers.get(token)
    if (!caller) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return structuredClone(caller)
  } } as never })
  async function rpc<Result>(method: string, params?: object, token = 'reader'): Promise<Result> {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })
    expect(response.statusCode).toBe(200)
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    const message = data ? JSON.parse(data.slice(6)) : response.json()
    expect(message.error).toBeUndefined()
    return message.result as Result
  }
  return { app, callers, rpc, get, recordDenied, workspace, interactions,
    workerAccess: (value: typeof role, enabled: string[], read = false) => {
      role = value
      tools = enabled
      canRead = read
    } }
}

it('builds Operator schemas once across authenticated requests while retaining caller grants, scopes and readback', async () => {
  const register = vi.spyOn(McpServer.prototype, 'registerTool')
  const f = fixture()
  try {
    for (let request = 0; request < 3; request++) {
      const list = await f.rpc<ListToolsResult>('tools/list')
      expect(list.tools.map(tool => tool.name)).toContain('workspace_get')
      const result = await f.rpc<CallToolResult>('tools/call', {
        name: 'workspace_get', arguments: { workspaceId: 'workspace' },
      })
      expect(decodeMcpToolResult(result)).toEqual(f.workspace)
    }
    for (const tool of ['ci_computers_list', 'job_runtime_profile_list']) {
      const schemas = register.mock.calls.filter(([name]) => name === tool).map(([, config]) => config.inputSchema)
      expect(schemas.length).toBeGreaterThan(1)
      expect(new Set(schemas).size).toBe(1)
    }
    f.callers.set('other-reader', { ...principal, id: 'other-reader' })
    await f.rpc('tools/call', { name: 'workspace_get', arguments: { workspaceId: 'workspace' } }, 'other-reader')
    expect(f.get.mock.calls.at(-1)?.[0].id).toBe('other-reader')
    const deniedScope = await f.rpc<CallToolResult>('tools/call', {
      name: 'workspace_get', arguments: { workspaceId: 'other-workspace' },
    })
    expect(deniedScope.isError).toBe(true)
    expect(JSON.stringify(deniedScope)).toContain('ACCESS_DENIED')
    f.callers.set('reader', { ...principal, grants: [{ actions: ['capabilities:read'], scope: {} }] })
    expect((await f.rpc<ListToolsResult>('tools/list')).tools.map(tool => tool.name)).not.toContain('workspace_get')
    const count = f.get.mock.calls.length
    const deniedGrant = await f.rpc<CallToolResult>('tools/call', {
      name: 'workspace_get', arguments: { workspaceId: 'workspace' },
    })
    expect(deniedGrant.isError).toBe(true)
    expect(f.get).toHaveBeenCalledTimes(count)
    expect(f.recordDenied).toHaveBeenCalledWith('reader', 'mcp', 'workspace_get', 'mcp:workspace_get')
    for (const caller of [{ ...principal, revokedAt: '2026-01-01T00:00:00.000Z' },
      { ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }]) {
      f.callers.set('reader', caller)
      const denied = await f.rpc<CallToolResult>('tools/call', {
        name: 'workspace_get', arguments: { workspaceId: 'workspace' },
      })
      expect(denied.isError).toBe(true)
      expect(f.get).toHaveBeenCalledTimes(count)
    }
    f.callers.set('reader', principal)
    const schema = decodeMcpToolResult(await f.rpc<CallToolResult>('tools/call', {
      name: 'operator_tool_schema_get', arguments: { name: 'workspace_get' },
    }))
    expect(schema).toMatchObject({ name: 'workspace_get' })
  } finally { await f.app.close() }
})

it('builds worker schemas once per role and keeps selections, discovery checks and identities fresh', async () => {
  const register = vi.spyOn(McpServer.prototype, 'registerTool')
  const f = fixture()
  f.callers.set('worker', { ...principal, id: 'worker', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: { workspaceIds: ['workspace'] } }] })
  try {
    for (const role of ['coder', 'orchestrator'] as const) {
      register.mockClear()
      f.workerAccess(role, ['context_get', 'ci_computers_list'])
      for (let request = 0; request < 3; request++) {
        const list = await f.rpc<ListToolsResult>('tools/list', undefined, 'worker')
        expect(list.tools.map(tool => tool.name).sort()).toEqual(['ci_computers_list', 'context_get'])
        const call = await f.rpc<CallToolResult>('tools/call', { name: 'context_get', arguments: {} }, 'worker')
        expect(JSON.stringify(call)).toContain('worker')
      }
      for (const tool of ['context_get', 'ci_computers_list']) {
        const schemas = register.mock.calls.filter(([name]) => name === tool).map(([, config]) => config.inputSchema)
        expect(schemas.length).toBeGreaterThan(1)
        expect(new Set(schemas).size).toBe(1)
      }
    }
    f.workerAccess('coder', ['context_get', 'interaction_list'], true)
    expect((await f.rpc<ListToolsResult>('tools/list', undefined, 'worker')).tools.map(tool => tool.name))
      .toContain('interaction_list')
    f.workerAccess('coder', ['context_get'], false)
    const denied = await f.rpc<CallToolResult>('tools/call', { name: 'interaction_list', arguments: {} }, 'worker')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('TOOL_NOT_ENABLED')
    expect(f.interactions.canRead).toHaveBeenCalled()
  } finally { await f.app.close() }
})


it('keeps simultaneous callers and schema discovery separate after warming the catalog', async () => {
  const f = fixture()
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await f.rpc('tools/list')
    f.callers.set('other-reader', { ...principal, id: 'other-reader' })
    f.callers.set('limited', { ...principal, id: 'limited', grants: [{ actions: ['capabilities:read'], scope: {} }] })
    f.get.mockImplementation(async (actor, workspaceId) => {
      await gate
      requireAuthorization(actor, 'workspaces:read', { workspaceId })
      return structuredClone(f.workspace)
    })
    const params = { name: 'workspace_get', arguments: { workspaceId: 'workspace' } }
    const pending = Promise.all([f.rpc<CallToolResult>('tools/call', params),
      f.rpc<CallToolResult>('tools/call', params, 'other-reader')])
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2))
    release()
    for (const result of await pending) expect(decodeMcpToolResult(result)).toEqual(f.workspace)
    expect(f.get.mock.calls.map(([actor]) => actor.id).sort()).toEqual(['other-reader', 'reader'])
    const schemaParams = { name: 'operator_tool_schema_get', arguments: { name: 'workspace_get' } }
    const [allowed, denied] = await Promise.all([f.rpc<CallToolResult>('tools/call', schemaParams),
      f.rpc<CallToolResult>('tools/call', schemaParams, 'limited')])
    expect(decodeMcpToolResult(allowed)).toMatchObject({ name: 'workspace_get' })
    expect(denied.isError).toBe(true)
    expect(f.recordDenied).toHaveBeenCalledWith('limited', 'mcp', 'operator_tool_schema_get', 'mcp:operator_tool_schema_get')
  } finally { release(); await f.app.close() }
})
