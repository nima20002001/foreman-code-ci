import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { CodexPluginChangeResultSchema, CodexPluginDetailResultSchema, CodexPluginListResultSchema, type CodexPluginSummary } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CodexPluginSettingsService } from '../src/modules/harnesses/codexPluginSettings.js'
import { normalizeCodexPluginCatalog } from '../src/modules/harnesses/codexPluginCatalog.js'
import type { CodexPluginAdapter } from '../src/modules/harnesses/codexPlugins.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const connectionString = process.env.TEST_DATABASE_URL!
const admin = new pg.Pool({ connectionString })
const schema = `codex_plugins_${randomUUID().replaceAll('-', '')}`
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
beforeAll(async () => {
  await createFixtureSchema(admin, schema)
  await applyApplicationMigrations(pool)
}, 60_000)
afterAll(async () => {
  await pool.end()
  try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
}, 60_000)
const clients: Client[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.close() })

it('lists, reads, installs and removes Codex plugins through authenticated MCP with native readback', async () => {
  const item: CodexPluginSummary = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1.0.0',
    installed: false, enabled: false, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL' }
  let installed = false
  let changes = 0
  let failChange = false
  const nativeMcp = { linear: { url: 'https://mcp.linear.app/mcp/readonly' } }
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const home = await mkdtemp(join(cache, 'plugin-settings-test-'))
  const file = join(home, 'config.toml'); await writeFile(file, '')
  const adapter: CodexPluginAdapter = {
    recoveryIdentity: 'integration-writer',
    list: async () => normalizeCodexPluginCatalog({ installed: installed ? [{ ...item, installed: true, enabled: true, source: { source: 'remote', id: 'notes' } }] : [],
      available: installed ? [] : [{ ...item, source: { source: 'remote', id: 'notes' } }] },
      { file, userConfig: { mcp_servers: nativeMcp, plugins: installed ? { [item.pluginId]: { enabled: true } } : {} } }, 'complete'),
    detail: async (plugin) => plugin.installed ? { status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes'], apps: [] } : { status: 'unknown' },
    change: async (_id, action) => { changes++; if (failChange) throw new Error('native response unavailable'); installed = action === 'install'; return { acknowledged: true, version: installed ? '1.0.0' : null } },
  }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const plugins = new CodexPluginSettingsService(pool, adapter)
  const services = { commands, harnessSettings: { plugins, mcp: {}, directories: {} } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    const owner = await access.issue({ name: 'Plugin owner', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const delegated = await access.issue({ name: 'Plugin requester', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const reader = await access.issue({ name: 'Plugin reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const denied = await access.issue({ name: 'Denied', audience: 'operator', grants: [{ actions: ['capabilities:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'plugin-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const allowed = await connect(reader.token)
    const disallowed = await connect(denied.token)
    expect((await disallowed.listTools()).tools.map((tool) => tool.name)).not.toContain('codex_plugins_list')
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).toContain('codex_plugins_list')
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).not.toContain('codex_plugin_change')
    const operator = await connect(delegated.token)
    expect((await operator.listTools()).tools.map((tool) => tool.name)).toContain('codex_plugin_change')
    const list = async (view: 'installed' | 'available') => CodexPluginListResultSchema.parse(
      decodeMcpToolResult((await allowed.callTool({ name: 'codex_plugins_list', arguments: { view } }))))
    expect((await list('available')).items.map((plugin) => plugin.pluginId)).toEqual(['notes@trusted'])
    expect(CodexPluginDetailResultSchema.parse(decodeMcpToolResult((await allowed.callTool({ name: 'codex_plugin_get',
      arguments: { pluginId: item.pluginId } })))).contents).toEqual({ status: 'unknown' })
    const before = await list('available')
    const input = { pluginId: item.pluginId, action: 'install' as const, expectedRevision: before.revision, artifactIdentity: (await plugins.get(owner.principal, item.pluginId)).artifactIdentity, commandId: randomUUID() }
    const readerChange = await allowed.callTool({ name: 'codex_plugin_change', arguments: input })
    expect(readerChange.isError).toBe(true)
    expect(JSON.stringify(readerChange.content)).toContain('ACCESS_DENIED')
    // The delegated Operator installs the plugin itself: no human browser step. The same command never repeats.
    const change = async () => CodexPluginChangeResultSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'codex_plugin_change', arguments: input }))))
    expect((await change()).status).toBe('applied')
    expect((await change()).status).toBe('applied')
    expect(changes).toBe(1)
    const audit = await pool.query<{ source: string }>("select source from management_audit where principal_id=$1 and action like 'codex.plugin.%'", [delegated.principal.id])
    expect(audit.rows.length).toBeGreaterThan(0)
    expect(new Set(audit.rows.map((row) => row.source))).toEqual(new Set(['mcp']))
    expect((await list('installed')).items).toMatchObject([{ pluginId: item.pluginId, installed: true }])
    expect(CodexPluginDetailResultSchema.parse(decodeMcpToolResult((await allowed.callTool({ name: 'codex_plugin_get',
      arguments: { pluginId: item.pluginId } })))).contents).toEqual({ status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes'], apps: [] })
    const removal = { pluginId: item.pluginId, action: 'remove' as const, expectedRevision: (await list('installed')).revision, artifactIdentity: (await plugins.get(owner.principal, item.pluginId)).artifactIdentity, commandId: randomUUID() }
    const removeHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/plugins/change',
      headers: { authorization: `Bearer ${owner.token}` }, payload: removal })
    expect(removeHttp.statusCode).toBe(200)
    expect(CodexPluginChangeResultSchema.parse(removeHttp.json()).status).toBe('applied')
    const deniedHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/plugins/change',
      headers: { authorization: `Bearer ${reader.token}` }, payload: { ...removal, commandId: randomUUID() } })
    expect(deniedHttp.statusCode).toBe(403)
    expect(deniedHttp.json().error.code).toBe('ACCESS_DENIED')
    expect((await list('available')).items).toHaveLength(1)
    expect(nativeMcp.linear.url).toBe('https://mcp.linear.app/mcp/readonly')
    failChange = true
    const uncertainInput = { ...input, expectedRevision: (await list('available')).revision, commandId: randomUUID() }
    expect((await plugins.change(owner.principal, uncertainInput)).status).toBe('uncertain')
    expect((await plugins.change(owner.principal, uncertainInput)).status).toBe('uncertain')
    const operations = await app.inject({ url: '/api/management/harnesses/codex/plugins/operations',
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(operations.statusCode, operations.body).toBe(200)
    expect(operations.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedBy: owner.principal.id, commandId: uncertainInput.commandId,
        input: uncertainInput, result: expect.objectContaining({ status: 'uncertain' }) }),
    ]))
    const reconciliation = { commandId: uncertainInput.commandId, requestedBy: owner.principal.id,
      acceptObservedState: true, expectedRevision: (await list('available')).revision }
    const deniedReconcile = await allowed.callTool({ name: 'codex_plugin_reconcile', arguments: reconciliation })
    expect(deniedReconcile.isError).toBe(true)
    expect(JSON.stringify(deniedReconcile.content)).toContain('ACCESS_DENIED')
    const mcpReconciled = await operator.callTool({ name: 'codex_plugin_reconcile', arguments: reconciliation })
    expect(mcpReconciled.isError, JSON.stringify(mcpReconciled)).not.toBe(true)
    expect(CodexPluginChangeResultSchema.parse(decodeMcpToolResult(mcpReconciled)).status).toBe('reconciled')
    const reconciled = await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/plugins/reconcile',
      headers: { authorization: `Bearer ${owner.token}` }, payload: reconciliation })
    expect(reconciled.statusCode).toBe(200)
    expect(CodexPluginChangeResultSchema.parse(reconciled.json()).status).toBe('reconciled')
    expect((await list('available')).items).toHaveLength(1)
    expect(changes).toBe(3)
  } finally {
    await plugins.shutdown(); await app.close(); await rm(home, { recursive: true, force: true })
  }
})
