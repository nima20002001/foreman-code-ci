import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { DEFAULT_REMOTE_EXECUTION_SETTINGS, ManagedRemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateResultSchema, WorkerExecutionSettingsSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { RemoteExecutionSettingsService } from '../src/modules/settings/remoteExecution.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
const resources: Array<() => Promise<void>> = []
const retiredHttpPath = '/api/management/settings/worker-execution'
const startupCases = [
  { label: 'absent', environment: {}, enabled: false },
  { label: 'zero', environment: { FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0' }, enabled: false },
  { label: 'one', environment: { FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1' }, enabled: true },
]

beforeAll(async () => {
  database = await currentDatabase()
}, 60_000)

afterAll(async () => {
  await database.close()
}, 60_000)

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
  await database.pool.query('delete from application_settings where key=$1', ['remote-execution-settings'])
  await database.pool.query('delete from application_setting_versions where setting_key=$1', ['remote-execution-settings'])
})

async function settingsApp(environment: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ...environment })
  const access = new PostgresAccessService(database.pool)
  const workerExecution = new WorkerExecutionPolicy(config.workerExecution)
  const commands = new PostgresCommandCoordinator(database.pool)
  const runtime = {
    configureListener: async () => true,
    listenerStatus: () => ({ listenerEnabled: false, listenerEndpoint: null, restartRequired: false, reason: null }),
  }
  const remoteExecution = new RemoteExecutionSettingsService(new PostgresFoundationSettingsRepository(database.pool),
    commands, workerExecution, runtime, config.remoteExecutionEnvironment ?? {}, config.port, error => { throw error })
  await remoteExecution.initialize()
  const services = {
    remoteExecution,
    workerExecution,
    commands,
  } as unknown as OperatorServices
  const app = buildApp({
    logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  resources.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issue = (name: string, grants: ManagementGrant[]) => access.issue({
    name,
    audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000),
    grants,
  })
  const connect = async (token: string) => {
    const client = new Client({ name: 'Worker settings test', version: '1' })
    resources.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  return { app, access, issue, connect, remoteExecution, workerExecution }
}

it.each(startupCases)(
  'reads effective status with the environment setting $label through authenticated MCP',
  async ({ environment, enabled }) => {
    const { app, access, issue, connect } = await settingsApp(environment)
    const grants: ManagementGrant[] = [{ actions: ['settings:read', 'capabilities:read'], scope: {} }]
    const reader = await issue('Settings reader', grants)
    const expected = { enabled, managedBy: environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED === undefined ? 'settings' : 'startup' }
    // The web app shows this on the Main computer card from build status; the HTTP read is retired.
    expect((await app.inject({ method: 'GET', url: retiredHttpPath, headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(404)

    const client = await connect(reader.token)
    const tools = (await client.listTools()).tools
    const tool = tools.find(value => value.name === 'worker_execution_settings_get')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    const readback = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(readback))).toEqual(expected)
    expect(tools.filter(value => value.name.startsWith('worker_execution_settings_')).map(value => value.name))
      .toEqual(['worker_execution_settings_get'])

    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({
      grants,
      tools: expect.arrayContaining(['worker_execution_settings_get']),
      requirements: expect.arrayContaining([{
        name: 'worker_execution_settings_get',
        actions: ['settings:read'],
        detail: expect.any(String),
      }]),
    })
    expect((await access.authenticate(reader.token)).grants).toEqual(grants)
  },
)

it.each(startupCases)(
  'retains effective status $label across sessions and keeps retired mutation routes unavailable',
  async ({ environment, enabled }) => {
    const { app, issue, connect } = await settingsApp(environment)
    const reader = await issue('Settings reader', [{ actions: ['settings:read'], scope: {} }])
    const expected = { enabled, managedBy: environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED === undefined ? 'settings' : 'startup' }
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: retiredHttpPath,
        headers: { authorization: `Bearer ${reader.token}` },
        payload: { enabled: !enabled },
      })
      expect(response.statusCode).toBe(404)
    }
    const client = await connect(reader.token)
    await expect(client.callTool({
      name: 'worker_execution_settings_update',
      arguments: { enabled: !enabled },
    })).rejects.toThrow()
    const unchanged = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(unchanged))).toEqual(expected)

    const restarted = await settingsApp(environment)
    const persistedReader = await restarted.access.authenticate(reader.token)
    expect(persistedReader.id).toBe(reader.principal.id)
    expect(persistedReader.grants).toEqual(reader.principal.grants)
    const freshClient = await restarted.connect(reader.token)
    const readback = await freshClient.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(readback))).toEqual(expected)
    const settings = await database.pool.query('select count(*)::int count from application_settings')
    expect(settings.rows[0].count).toBe(0)
  },
)

it.each(['0', '1'])(
  'denies missing MCP credentials, unrelated grants and workspace-scoped grants with startup status %s',
  async (enabled) => {
    const { app, issue, connect } = await settingsApp({ FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: enabled })
    const anonymousMcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(anonymousMcp.statusCode).toBe(401)
    const deniedGrants: ManagementGrant[][] = [
      [{ actions: ['harnesses:read', 'capabilities:read'], scope: {} }],
      [{ actions: ['settings:read', 'capabilities:read'], scope: { workspaceIds: [randomUUID()] } }],
    ]
    for (const grants of deniedGrants) {
      const denied = await issue('Denied settings reader', grants)
      const client = await connect(denied.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).not.toContain('worker_execution_settings_get')
      const refused = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
      expect(refused.isError).toBe(true)
      const body = refused.content.find((item) => item.type === 'text')
      expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
      expect(decodeMcpToolResult(capabilities)).toMatchObject({
        grants,
        tools: expect.not.arrayContaining(['worker_execution_settings_get']),
      })
    }
  },
)

it('persists remote settings through authenticated MCP with denied writes, revisions, retries and audits', async () => {
  const f = await settingsApp()
  const owner = await f.issue('Remote settings owner', [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }])
  const reader = await f.issue('Remote settings reader', [{ actions: ['settings:read', 'capabilities:read'], scope: {} }])
  const scoped = await f.issue('Scoped settings writer', [{
    actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: { workspaceIds: [randomUUID()] },
  }])
  const client = await f.connect(owner.token)
  const denied = await f.connect(reader.token)
  const workspaceCaller = await f.connect(scoped.token)
  const input = { value: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS, enabled: true }, expectedRevision: 0, commandId: randomUUID() }
  const update = (arguments_: typeof input) => client.callTool({ name: 'remote_execution_settings_update', arguments: arguments_ })
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('remote_execution_settings_update')
  const capabilities = decodeMcpToolResult(await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } }))
  expect(capabilities).toMatchObject({
    tools: expect.arrayContaining(['remote_execution_settings_get', 'remote_execution_settings_update']),
    requirements: expect.arrayContaining([
      { name: 'remote_execution_settings_get', actions: ['settings:read'], detail: expect.any(String) },
      { name: 'remote_execution_settings_update', actions: ['settings:update'], detail: expect.any(String) },
    ]),
  })
  expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('remote_execution_settings_update')
  for (const caller of [denied, workspaceCaller]) {
    const refusal = await caller.callTool({ name: 'remote_execution_settings_update', arguments: input })
    expect(refusal.isError).toBe(true)
    expect(decodeMcpToolResult(refusal)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  }
  expect(await f.remoteExecution.read(reader.principal)).toMatchObject({ revision: 0, value: { enabled: false } })
  const saved = RemoteExecutionSettingsUpdateResultSchema.parse(decodeMcpToolResult(await update(input)))
  expect(saved).toMatchObject({ replayed: false, value: { revision: 1, value: input.value } })
  expect(() => f.workerExecution.requireEnabled({ kind: 'device' })).not.toThrow()
  const readback = ManagedRemoteExecutionSettingsSchema.parse(decodeMcpToolResult(await denied.callTool({
    name: 'remote_execution_settings_get', arguments: {},
  })))
  expect(readback).toMatchObject({ ...saved.value, effective: input.value, environmentOverrides: [] })
  const httpReadback = await f.app.inject({ method: 'GET', url: '/api/management/settings/remote-execution',
    headers: { authorization: `Bearer ${reader.token}` } })
  expect(httpReadback.statusCode).toBe(200)
  expect(httpReadback.json()).toEqual(readback)
  const restarted = await settingsApp()
  const freshClient = await restarted.connect(reader.token)
  expect(decodeMcpToolResult(await freshClient.callTool({ name: 'remote_execution_settings_get', arguments: {} })))
    .toEqual(readback)
  expect(() => restarted.workerExecution.requireEnabled({ kind: 'device' })).not.toThrow()
  expect(RemoteExecutionSettingsUpdateResultSchema.parse(decodeMcpToolResult(await update(input))))
    .toEqual({ ...saved, replayed: true })
  const stale = await update({ ...input, commandId: randomUUID() })
  expect(decodeMcpToolResult(stale)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  const reused = await update({ ...input, value: DEFAULT_REMOTE_EXECUTION_SETTINGS })
  expect(decodeMcpToolResult(reused)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
  const audits = await database.pool.query('select source,outcome from management_audit where action=$1',
    ['remote.execution.settings.update'])
  expect(audits.rows.filter(row => row.outcome === 'succeeded')).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
  const deniedAudits = await database.pool.query('select outcome from management_audit where action=$1',
    ['remote_execution_settings_update'])
  expect(deniedAudits.rows).toEqual([{ outcome: 'denied' }, { outcome: 'denied' }])
  await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
    [owner.principal.id, JSON.stringify(reader.principal.grants)])
  await expect(f.remoteExecution.update(owner.principal, 'mcp', input)).rejects.toMatchObject({ status: 403 })
  expect(await f.remoteExecution.read(reader.principal)).toEqual(readback)
}, 30_000)

it.each(['0', '1'])('keeps explicit execution override %s visible while persisting the Operator save', async enabled => {
  const f = await settingsApp({ FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: enabled })
  const owner = await f.issue('Override settings owner', [{ actions: ['settings:read', 'settings:update'], scope: {} }])
  const client = await f.connect(owner.token)
  const value = { ...DEFAULT_REMOTE_EXECUTION_SETTINGS, enabled: enabled !== '1' }
  const result = await client.callTool({ name: 'remote_execution_settings_update',
    arguments: { value, expectedRevision: 0, commandId: randomUUID() } })
  expect(result.isError).not.toBe(true)
  const readback = ManagedRemoteExecutionSettingsSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'remote_execution_settings_get', arguments: {},
  })))
  expect(readback).toMatchObject({ value, revision: 1, effective: { enabled: enabled === '1' },
    environmentOverrides: ['FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED'] })
  expect(f.workerExecution.read(owner.principal)).toEqual({ enabled: enabled === '1', managedBy: 'startup' })
})

it('rejects incomplete listener settings through MCP without changing persisted settings', async () => {
  const f = await settingsApp()
  const owner = await f.issue('Listener settings owner', [{ actions: ['settings:read', 'settings:update'], scope: {} }])
  const client = await f.connect(owner.token)
  const invalid = await client.callTool({ name: 'remote_execution_settings_update', arguments: {
    value: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS, listener: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS.listener, enabled: true } },
    expectedRevision: 0, commandId: randomUUID(),
  } })
  expect(invalid.isError).toBe(true)
  expect(await f.remoteExecution.read(owner.principal)).toMatchObject({ revision: 0, value: DEFAULT_REMOTE_EXECUTION_SETTINGS })
})
