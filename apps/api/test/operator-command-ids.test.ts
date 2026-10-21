import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagementActionSchema, type ManagementPrincipal, RunStopInputSchema } from '@foreman-code/contracts/management'
import pg from 'pg'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'

type RunStopInput = z.infer<typeof RunStopInputSchema>

it('advertises optional command IDs across the Operator tool catalog', async () => {
  const stub = { qualificationSupported: true, current: {}, schedules: {}, inspection: {}, mcp: {}, directories: {}, plugins: {}, claudePlugins: {},
    native: {}, agents: {}, history: {}, lifecycle: {}, runs: {}, skills: {}, triggers: {},
    workspace: { provisioningEnabled: true }, reads: {}, selectors: {} }
  const services = Object.fromEntries([
    'bugReports', 'providerAccounts', 'ci', 'remoteExecution', 'workerExecution', 'jobs', 'jobRuntimeProfiles',
    'ciRuntime', 'ciEnrollment', 'resourceTelemetry', 'workspaceRepositories', 'workspaceRoots', 'harnessInstances',
    'harnessRegistry', 'trustedConnections', 'computerActivity', 'computerAccounts', 'computerMaintenance',
    'computerGitHub', 'computerSync', 'buildComputers', 'devices', 'sources', 'fileReferences', 'executionReadiness',
    'runGraph', 'runPlacements', 'placementChoices', 'operatorChat', 'agentChat', 'fileRetention', 'harnessSettings',
    'extensions', 'workspaces', 'locations', 'workflows', 'agents', 'harnesses', 'harnessCompatibility',
    'harnessQualifications', 'settings', 'runs', 'commands', 'interactions',
  ].map(name => [name, stub])) as unknown as OperatorServices
  const server = await createGraphqlMcpServer({ role: 'operator', operator: services, principal: {
    id: 'catalog-owner', name: 'Catalog owner', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  } })
  const client = new Client({ name: 'catalog-client', version: '1' })
  function requiresCommandId(schema: Record<string, unknown>): boolean {
    if (Array.isArray(schema.required) && schema.required.includes('commandId')) return true
    return ['anyOf', 'oneOf', 'allOf'].some(key => {
      const options = schema[key]
      return Array.isArray(options) && options.some(option => requiresCommandId(option))
    })
  }
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const names: string[] = []
    const required: string[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : {})
      for (const tool of page.tools) {
        names.push(tool.name)
        if (requiresCommandId(tool.inputSchema)) required.push(tool.name)
      }
      cursor = page.nextCursor
    } while (cursor)
    expect(names).toEqual(expect.arrayContaining([
      'run_stop', 'operator_chat_create', 'job_runtime_qualification_run', 'device_connection_configure',
      'workflow_save_v3', 'harness_instance_save', 'reference_file_remove',
    ]))
    expect(required).toEqual([])
  } finally {
    await client.close()
    await server.close()
  }
})

it('generates command IDs for MCP run_stop and preserves caller IDs for replay and denied callers', async () => {
  const owner: ManagementPrincipal = {
    id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z',
    grants: [{ actions: ['runs:stop', 'runs:read'], scope: { workspaceIds: ['workspace'] } }],
  }
  const reader: ManagementPrincipal = {
    ...owner, id: 'reader', grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['workspace'] } }],
  }
  const pool = new pg.Pool()
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Unexpected database connection') })
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'owner' ? owner : reader)
  const commands = new Set<string>()
  const stop = vi.fn(async (_principal: ManagementPrincipal, _source: string, input: RunStopInput) => {
    const replayed = commands.has(input.commandId)
    commands.add(input.commandId)
    return { runId: input.runId, status: 'accepted', processStopped: false, replayed }
  })
  const recordDenied = vi.fn()
  const services = { runs: { stop }, commands: { recordDenied } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'command-id-client', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect('owner')
    const input = { workspaceId: 'workspace', runId: 'run' }
    const omitted = await client.callTool({ name: 'run_stop', arguments: input })
    expect(omitted.isError).not.toBe(true)
    expect(decodeMcpToolResult(omitted)).toMatchObject({ runId: 'run', replayed: false })
    const generated = stop.mock.calls[0]![2].commandId
    expect(generated).toMatch(/^[a-f0-9-]{36}$/)
    await client.callTool({ name: 'run_stop', arguments: input })
    expect(stop.mock.calls[1]![2].commandId).not.toBe(generated)
    const supplied = { ...input, commandId: 'caller-stop-command' }
    const first = await client.callTool({ name: 'run_stop', arguments: supplied })
    const replay = await client.callTool({ name: 'run_stop', arguments: supplied })
    expect(decodeMcpToolResult(first)).toMatchObject({ replayed: false })
    expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true })
    expect(stop).toHaveBeenLastCalledWith(owner, 'mcp', supplied)
    const tool = (await client.listTools()).tools.find(item => item.name === 'run_stop')!
    expect(tool.inputSchema.required ?? []).not.toContain('commandId')
    const calls = stop.mock.calls.length
    const deniedClient = await connect('reader')
    const denied = await deniedClient.callTool({ name: 'run_stop', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(stop).toHaveBeenCalledTimes(calls)
    expect(recordDenied).toHaveBeenCalledWith(reader.id, 'mcp', 'run_stop', 'mcp:run_stop')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
  }
})
