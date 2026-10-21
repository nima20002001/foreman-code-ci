import { workerToolServices } from './helpers/workerMcpServices.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { sharedFolderId } from '../src/modules/computers/syncthingComputer.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'

import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'

const scope = { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] }
const worker: ManagementPrincipal = { id: 'worker-1', name: 'Worker', audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['interactions:read'], scope }] }

// A Worker credential is never a scoped conversation credential, which the interaction service checks first.
const rowsFor = (row: unknown) => async (text = ''): Promise<{ rows: unknown[] }> =>
  text.includes('agent_conversation_credentials') ? { rows: [] } : { rows: [row] }

it('advertises only the interaction capabilities whose tools are enabled for the Agent and node', async () => {
  // The Coder's pinned configuration allows only context_get; the node adds nothing.
  const query = vi.fn(rowsFor({ role: 'coder', defaults: ['context_get'], override: null }))
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  const context = await service.context(worker) as { tools: string[]; capabilities: Record<string, boolean> }
  expect(context.tools).toEqual(['bug_report', 'context_get'])
  expect(context.capabilities).toEqual({ contextGet: true, bugReport: false,
    interactionList: false, interactionGet: false, interactionRespond: false })
  query.mockImplementation(rowsFor({ role: 'coder', defaults: ['context_get'], override: { add: ['interaction_get'], remove: [] } }))
  expect((await service.context(worker) as { capabilities: Record<string, boolean> }).capabilities)
    .toMatchObject({ interactionList: false, interactionGet: true })
})

it('keeps scoped bug reporting available when all configurable tools are removed', async () => {
  const query = vi.fn(rowsFor({ role: 'coder', defaults: [], override: { add: [], remove: ['bug_report'] } }))
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  const reporter: ManagementPrincipal = { ...worker, grants: [{ actions: ['bug_reports:report'], scope }] }
  expect(await service.context(reporter)).toMatchObject({
    tools: ['bug_report'],
    capabilities: {
      bugReport: true, interactionList: false, interactionGet: false, interactionRespond: false,
    },
  })
})

it('tells the Agent which worktree and branch it owns', async () => {
  const query = vi.fn(async (text: string): Promise<{ rows: unknown[] }> => text.includes('agent_conversation_credentials') ? { rows: [] }
    : text.includes('execution_native_placements')
    ? { rows: [{ worktree: { repository: 'octo/site', branch: 'foreman/review/coder-1a2b3c4d', commit: 'a'.repeat(40) },
      path: '/home/agent/project/2c1d/tree' }] }
    : { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] })
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  expect((await service.context(worker) as { worktree?: unknown }).worktree).toEqual({ repository: 'octo/site',
    branch: 'foreman/review/coder-1a2b3c4d', baseCommit: 'a'.repeat(40), path: '/home/agent/project/2c1d/tree' })
  query.mockImplementation(rowsFor({ role: 'coder', defaults: ['context_get'], override: null }))
  expect(await service.context(worker)).not.toHaveProperty('worktree')
})

it('tells the Agent where its workspace synced folder is available on its own computer', async () => {
  const deviceId = '22222222-2222-4222-8222-222222222222'
  const query = vi.fn(async (text: string): Promise<{ rows: unknown[] }> => text.includes('agent_conversation_credentials') ? { rows: [] }
    : text.includes('workspaces w')
    ? { rows: [{ device_id: deviceId, workspace_id: 'workspace', name: 'Cross/computer team' }] }
    : text.includes('execution_native_placements') ? { rows: [] }
      : { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] })
  const mounts: unknown[] = []
  const service = Object.assign(new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never), {
    syncedFolder: async (workspaceId: string, hostRef: unknown) => { mounts.push({ workspaceId, hostRef });
      return mounts.length === 1 ? '/home/builder/shared/workspace-folder' : null } })
  expect((await service.context(worker) as { sharedFiles?: unknown }).sharedFiles).toEqual({ provider: 'syncthing',
    path: '/home/builder/shared/workspace-folder' })
  expect(mounts).toEqual([{ workspaceId: 'workspace', hostRef: { kind: 'device', deviceId } }])
  // No sync configured on that computer: no shared folder is offered.
  expect(await service.context(worker)).not.toHaveProperty('sharedFiles')
})

it('gives colliding workspace names distinct synced folders that survive renames and computer changes', async () => {
  let workspaceId = 'workspace-a'
  let name = 'Client/Web'
  let deviceId: string | null = null
  const query = vi.fn(async (text: string): Promise<{ rows: unknown[] }> => {
    if (text.includes('agent_conversation_credentials')) return { rows: [] }
    if (text.includes('workspaces w')) return { rows: [{ device_id: deviceId, workspace_id: workspaceId, name }] }
    if (text.includes('execution_native_placements')) return { rows: [] }
    return { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }
  })
  const service = Object.assign(new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never), {
    syncedFolder: async (id: string, host: { kind: string }) => `${host.kind === 'main' ? '/main/shared' : '/worker/shared'}/${sharedFolderId(id)}`,
  })
  const folder = async () => (await service.context(worker) as { sharedFiles: { path: string } }).sharedFiles.path
  const first = await folder()
  workspaceId = 'workspace-b'
  name = 'Client-Web'
  expect(await folder()).not.toBe(first)
  workspaceId = 'workspace-a'
  name = 'Renamed client'
  expect(await folder()).toBe(first)
  deviceId = '22222222-2222-4222-8222-222222222222'
  expect((await folder()).slice('/worker/shared/'.length)).toBe(first.slice('/main/shared/'.length))
})

it('returns the stable workspace directory through authenticated MCP and denies an invalid caller', async () => {
  let name = 'Client/Web'
  const pool = { query: vi.fn(async (text: string) => {
    if (text.includes('agent_conversation_credentials')) return { rows: [] }
    if (text.includes('workspaces w')) return { rows: [{ device_id: null, workspace_id: 'workspace', name }] }
    if (text.includes('execution_native_placements')) return { rows: [] }
    return { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }
  }) } as unknown as pg.Pool
  const service = Object.assign(new PostgresAppInteractionService(pool, {} as never, {} as never), {
    syncedFolder: async (id: string) => `/main/shared/${sharedFolderId(id)}`,
  })
  const access = new PostgresAccessService(pool)
  const authentication = vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'worker') throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return worker
  })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: workerToolServices(pool, {} as never).appMcp(access, service) })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'workspace-sync-context', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: 'Bearer worker' } } }))
    const first = await client.callTool({ name: 'context_get', arguments: {} })
    expect(first.isError).not.toBe(true)
    expect(first.structuredContent).toEqual(decodeMcpToolResult(first))
    expect((await client.listTools()).tools.find((tool) => tool.name === 'context_get')?.outputSchema).toBeDefined()
    expect(decodeMcpToolResult(first)).toMatchObject({ sharedFiles: { provider: 'syncthing', path: expect.stringMatching(/^\/main\/shared\/workspace-[a-f0-9]{64}$/u) } })
    name = 'Renamed workspace'
    expect(decodeMcpToolResult((await client.callTool({ name: 'context_get', arguments: {} })))).toEqual(decodeMcpToolResult(first))
    const denied = await app.inject({ method: 'POST', url: '/mcp', headers: {
      authorization: 'Bearer invalid', accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} } } })
    expect(denied.statusCode).toBe(401)
  } finally {
    await client.close()
    await app.close()
    authentication.mockRestore()
  }
})
