import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { createClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'

async function claudeMcpFixture() {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
  const schema = `claude_resume_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ ...admin.options, options: `-c search_path=${schema}` })
  let app: ReturnType<typeof buildApp> | undefined
  const clients: Client[] = []
  const close = async () => {
    await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
  }
  try {
    await applyApplicationMigrations(pool)
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const locations = new WorkspaceLocationService(pool, commands)
    const services = { commands, locations, workspaces: new WorkspaceManagementService(pool, commands, locations) } as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const writer = await access.issue({ name: 'Claude resumed writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workspaces:create', 'workspaces:read'], scope: {} }] })
    const connect = async (token: string) => {
      const client = new Client({ name: 'claude-resume-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    return { db: { pool }, access, address, writer, connect, close }
  } catch (error) { await close(); throw error }
}

// Provider frames are synthetic; authentication, MCP dispatch, grants, audits
// and persisted workspace readback use the real endpoint and PostgreSQL.
describe('NEW-CLAUDE F-13 authenticated resumed query', () => {
  it('uses the resumed scoped credential for an allowed write/readback and denies a read-only caller', async () => {
    const f = await claudeMcpFixture()
    const managers: ReturnType<typeof createClaudeNativeSessionManager>[] = []
    const url = new URL('/mcp', f.address).toString()
    const servers = { graphql: { type: 'http', url } }
    const saved = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'persisted-claude' }
    const workspaceName = `Claude resume ${randomUUID()}`
    let createdId: string | undefined
    try {
      const reader = await f.access.issue({ name: 'Claude resumed reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workspaces:read'], scope: {} }] })
      for (const [token, allowed] of [[f.writer.token, true], [reader.token, false]] as const) {
        const opened: Array<{ resume: unknown; control: ReturnType<typeof vi.fn<(entries: Readonly<Record<string, unknown>>) => Promise<unknown>>>; transport?: Client }> = []
        const sdk: ClaudeSdkClient = {
          sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
          getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused-fork' }),
          query(input) {
            const frames = new ClaudeBoundedQueue<unknown>(32)
            const query: (typeof opened)[number] = { resume: input.options.resume, control: vi.fn<(entries: Readonly<Record<string, unknown>>) => Promise<unknown>>(async entries => {
              const entry = entries.graphql as typeof servers.graphql & { headers: { Authorization: string } }
              query.transport = await f.connect(entry.headers.Authorization.slice('Bearer '.length))
              await query.transport.listTools()
              return { added: ['graphql'], removed: [], errors: {} }
            }) }
            opened.push(query)
            void (async () => {
              for await (const message of input.prompt) {
                const create = { name: 'workspace_create', arguments: { commandId: randomUUID(), name: workspaceName } }
                const names = (await query.transport!.listTools()).tools.map(tool => tool.name)
                if (allowed) {
                  expect(names).toContain('workspace_create')
                  const result = await query.transport!.callTool(create)
                  expect(result.isError).not.toBe(true)
                  const id = (decodeMcpToolResult(result) as { value: { workspace: { id: string } } }).value.workspace.id
                  createdId = id
                  const read = await query.transport!.callTool({ name: 'workspace_get', arguments: { workspaceId: id } })
                  expect(decodeMcpToolResult(read)).toMatchObject({ workspace: { id, name: workspaceName } })
                  expect((await f.db.pool.query('select record from workspaces where id=$1', [id])).rows[0]?.record).toMatchObject({ id, name: workspaceName })
                } else {
                  expect(names).not.toContain('workspace_create')
                  await expectMcpAccessDenied(query.transport!.callTool(create))
                  const read = await query.transport!.callTool({ name: 'workspace_get', arguments: { workspaceId: createdId! } })
                  expect(decodeMcpToolResult(read)).toMatchObject({ workspace: { id: createdId, name: workspaceName } })
                }
                void frames.offer({ type: 'system', subtype: 'init', session_id: saved.nativeSessionId, claude_code_version: saved.providerVersion, cwd: '/work' })
                void frames.offer({ type: 'assistant', uuid: 'reply', session_id: saved.nativeSessionId, user_message_uuid: message.uuid })
                void frames.offer({ type: 'result', uuid: 'result', session_id: saved.nativeSessionId, user_message_uuid: message.uuid,
                  subtype: 'success', is_error: false, result: 'MCP checked' })
              }
            })().catch(error => frames.close(error))
            return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(), interrupt: async () => undefined,
              initializationResult: async () => ({}), setMcpServers: query.control,
              mcpServerStatus: async () => [{ name: 'graphql', status: query.transport ? 'connected' : 'needs-auth', config: servers.graphql, tools: [] }] }
          },
        }
        const manager = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
          scope: { deviceId: 'main', profilePath: '/profile', configRevision: '1', cwd: '/work' }, sdkOptions: { mcpServers: servers },
          qualification: { sdkVersion: sdk.sdkVersion, cliVersion: saved.providerVersion, basicTurns: true, resume: true, fork: false, history: true },
          appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url } })
        managers.push(manager)
        const start = { kind: 'operator', correlationId: `resume:${allowed}`, configuration: {}, workingDirectory: '/work',
          environment: { agentId: 'operator', variables: {} } } as NativeSessionStart
        await manager.prepareInspection(start)
        const scoped = { ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: token } } }
        await manager.refreshInspectionCredentials(scoped, { graphql: { ...servers.graphql, headers: { Authorization: `Bearer ${token}` } } })
        const attached = await manager.attachSession(saved, scoped)
        expect(opened[1]?.resume).toBe(saved.nativeSessionId)
        expect(opened[1]?.control).toHaveBeenCalledOnce()
        for await (const event of manager.startTurn(attached, { prompt: 'Exercise MCP', clientCorrelationId: start.correlationId! })) void event
        await manager.dispose?.()
      }
      expect((await f.db.pool.query("select record from workspaces where record->>'name'=$1", [workspaceName])).rows).toHaveLength(1)
    } finally {
      await Promise.allSettled(managers.map(manager => manager.dispose?.()))
      await f.close()
    }
  }, 60000)
})
