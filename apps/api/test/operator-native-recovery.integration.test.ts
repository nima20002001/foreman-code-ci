import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CodexPluginChangeResultSchema, CodexPluginDetailResultSchema, CodexPluginOperationsResultSchema,
  HarnessMcpPlanResultSchema, HarnessMcpPlanSchema, HarnessMcpPlansResultSchema,
  type ManagementAction,
} from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CodexPluginSettingsService } from '../src/modules/harnesses/codexPluginSettings.js'
import { normalizeCodexPluginCatalog } from '../src/modules/harnesses/codexPluginCatalog.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import {
  applyMcpEdits, fingerprint, mcpEdits, type NativeMcpAdapter, type NativeMcpSnapshot,
} from '../src/modules/harnesses/nativeMcpCommon.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const connectionString = process.env.TEST_DATABASE_URL!
  const admin = new pg.Pool({ connectionString })
  const schema = `native_recovery_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  cleanups.push(async () => {
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
  })
  await applyApplicationMigrations(pool)
  const directory = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, 'operator-native-recovery-'))
  cleanups.push(() => removeFixtureDirectory(directory))
  const file = join(directory, 'config.toml')
  await writeFile(file, '')
  let snapshot: NativeMcpSnapshot = {
    harness: 'codex', revision: fingerprint({}), effective: {}, user: {}, userConfig: {}, file, version: '1',
  }
  const writes = { mcp: 0, plugin: 0 }
  const adapter: NativeMcpAdapter = {
    read: async () => structuredClone(snapshot),
    apply: async (before, change, _signal, managed) => {
      writes.mcp++
      const user = applyMcpEdits(before.user, mcpEdits(before, change, managed))
      await writeFile(file, JSON.stringify(user))
      snapshot = { ...before, user, effective: structuredClone(user), revision: fingerprint(user) }
    },
  }
  const plugin = {
    pluginId: 'notes@catalog', name: 'notes', marketplaceName: 'catalog', version: '1.0.0',
    installed: false, enabled: false, source: { source: 'remote', id: 'catalog-source' },
    installPolicy: 'AVAILABLE', authPolicy: 'ON_USE',
  }
  const plugins = new CodexPluginSettingsService(pool, {
    recoveryIdentity: 'fixture-plugin-writer',
    list: async () => normalizeCodexPluginCatalog({ installed: [], available: [plugin] },
      { file, userConfig: {} }, 'complete'),
    detail: async () => ({ status: 'unknown' }),
    change: async () => {
      writes.plugin++
      throw new Error('Native plugin response was lost')
    },
  })
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const mcp = new HarnessMcpSettingsService(pool, commands, { codex: adapter }, () => {})
  cleanups.push(async () => { await plugins.shutdown(); await mcp.shutdown() })
  const services = { commands, harnessSettings: { mcp, plugins } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  cleanups.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issue = (actions: ManagementAction[]) => access.issue({ name: 'Recovery caller', audience: 'operator',
    grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 3600_000) })
  const connect = async (token: string) => {
    const client = new Client({ name: 'native-recovery-test', version: '1' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    return client
  }
  const owner = await issue(['harnesses:read', 'harnesses:update', 'capabilities:read'])
  return { pool, app, owner, issue, connect, writes }
}

async function denied(client: Client, name: string, args: Record<string, unknown>) {
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain(name)
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
}

async function discovered(client: Client, names: string[]) {
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(names))
  const capabilities = decodeMcpToolResult(await client.callTool({
    name: 'operator_get_capabilities', arguments: { detail: 'full' },
  })) as { tools: string[]; requirements: Array<{ name: string; actions: string[] }> }
  expect(capabilities.tools).toEqual(expect.arrayContaining(names))
  for (const name of names) {
    expect(capabilities.requirements).toContainEqual(expect.objectContaining({ name }))
  }
}

it('rediscovers persisted plugin operations and reconciles the original command through authenticated MCP', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const detail = CodexPluginDetailResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'codex_plugin_get', arguments: { pluginId: 'notes@catalog' },
  })))
  const input = { pluginId: 'notes@catalog', action: 'install', commandId: randomUUID(),
    expectedRevision: detail.revision, artifactIdentity: detail.artifactIdentity }
  const changed = CodexPluginChangeResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'codex_plugin_change', arguments: input,
  })))
  expect(changed.status).toBe('uncertain')
  await client.close()
  const recovered = await f.connect(f.owner.token)
  const operations = CodexPluginOperationsResultSchema.parse(decodeMcpToolResult(await recovered.callTool({
    name: 'codex_plugin_operations_list', arguments: {},
  })))
  expect(operations.items).toEqual([{ requestedBy: f.owner.principal.id, commandId: input.commandId,
    input, result: changed }])
  const reader = await f.issue(['harnesses:read'])
  await denied(await f.connect(reader.token), 'codex_plugin_operations_list', {})
  await discovered(recovered, ['codex_plugin_operations_list'])
  const original = operations.items[0]!
  const reconcile = { requestedBy: original.requestedBy, commandId: original.commandId, acceptObservedState: false }
  const observed = CodexPluginChangeResultSchema.parse(decodeMcpToolResult(await recovered.callTool({
    name: 'codex_plugin_reconcile', arguments: reconcile,
  })))
  expect(observed.status).toBe('uncertain')
  expect(observed.observedRevision).toBeDefined()
  const settled = CodexPluginChangeResultSchema.parse(decodeMcpToolResult(await recovered.callTool({
    name: 'codex_plugin_reconcile', arguments: { ...reconcile, acceptObservedState: true,
      expectedRevision: observed.observedRevision },
  })))
  expect(settled.status).toBe('reconciled')
  expect(CodexPluginOperationsResultSchema.parse(decodeMcpToolResult(await recovered.callTool({
    name: 'codex_plugin_operations_list', arguments: {},
  }))).items).toEqual([])
  expect(CodexPluginChangeResultSchema.parse(decodeMcpToolResult(await recovered.callTool({
    name: 'codex_plugin_change', arguments: original.input!,
  })))).toEqual(settled)
  expect(f.writes.plugin).toBe(1)
})

it('lists existing plans, approves or rejects their IDs, and preserves direct apply through authenticated MCP', async () => {
  const f = await fixture()
  const requester = await f.issue(['harnesses:read', 'harnesses:update', 'capabilities:read'])
  await f.pool.query('update management_principals set delegated_from=$2 where id=$1',
    [requester.principal.id, f.owner.principal.id])
  const client = await f.connect(requester.token)
  const createPlan = async (token: string, name: string) => {
    const response = await f.app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/plans',
      headers: { authorization: `Bearer ${token}` }, payload: { harness: 'codex', change: {
        kind: 'add', name, connection: { transport: 'remote', url: 'https://example.test/mcp' },
      } } })
    expect(response.statusCode).toBe(200)
    return HarnessMcpPlanResultSchema.parse(response.json()).value
  }
  const pending = await createPlan(requester.token, 'notes')
  const other = await createPlan(f.owner.token, 'other')
  const list = async () => HarnessMcpPlansResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'harness_mcp_plans_list', arguments: { harness: 'codex' },
  })))
  expect((await list()).items).toEqual([pending])
  const reader = await f.issue(['harnesses:read'])
  await denied(await f.connect(reader.token), 'harness_mcp_change_decide', { planId: pending.id, approve: true })
  const noRead = await f.issue(['harnesses:update'])
  await denied(await f.connect(noRead.token), 'harness_mcp_plans_list', { harness: 'codex' })
  const hidden = await client.callTool({ name: 'harness_mcp_change_get', arguments: { planId: other.id } })
  expect(hidden.isError).toBe(true)
  expect(JSON.stringify(hidden.content)).toContain('MCP_PLAN_NOT_FOUND')
  await discovered(client, ['harness_mcp_plans_list', 'harness_mcp_change_decide'])
  for (const approve of [false, true]) {
    const plan = approve ? await createPlan(requester.token, 'approved') : pending
    const args = { planId: plan.id, approve }
    const decision = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_change_decide', arguments: args,
    })))
    expect(decision).toMatchObject({ id: plan.id, status: approve ? 'applied' : 'rejected' })
    expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_change_get', arguments: { planId: plan.id },
    })))).toEqual(decision)
    expect((await list()).items).toContainEqual(decision)
    expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_change_decide', arguments: args,
    })))).toEqual(decision)
    expect(f.writes.mcp).toBe(approve ? 1 : 0)
  }
  const direct = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'harness_mcp_change_request', arguments: { harness: 'codex',
      change: { kind: 'remove', name: 'approved' } },
  })))
  expect(direct.status).toBe('applied')
  expect((await list()).items).toContainEqual(direct)
  expect(f.writes.mcp).toBe(2)
  const audit = await f.pool.query<{ source: string; details: { decision: string } }>(
    "select source, details from management_audit where principal_id=$1 and action='harness.mcp.review'",
    [requester.principal.id])
  expect(audit.rows).toEqual(expect.arrayContaining([
    { source: 'mcp', details: expect.objectContaining({ decision: 'reject' }) },
    { source: 'mcp', details: expect.objectContaining({ decision: 'approve' }) },
  ]))
})

it.each([
  { approve: false, settled: false },
  { approve: true, settled: false },
  { approve: false, settled: true },
  { approve: true, settled: true },
])('denies another caller\'s plan decision without changes or disclosure (approve=$approve, settled=$settled)',
  async ({ approve, settled }) => {
    const f = await fixture()
    const requester = await f.issue(['harnesses:read', 'harnesses:update'])
    await f.pool.query('update management_principals set delegated_from=$2 where id=$1',
      [requester.principal.id, f.owner.principal.id])
    const client = await f.connect(requester.token)
    const owner = await f.connect(f.owner.token)
    const response = await f.app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/plans',
      headers: { authorization: `Bearer ${f.owner.token}` }, payload: { harness: 'codex', change: {
        kind: 'add', name: 'private-notes', connection: { transport: 'remote', url: 'https://example.test/mcp' },
      } } })
    expect(response.statusCode).toBe(200)
    const plan = HarnessMcpPlanResultSchema.parse(response.json()).value
    let before = plan
    if (settled) {
      before = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await owner.callTool({
        name: 'harness_mcp_change_decide', arguments: { planId: plan.id, approve: false },
      })))
      expect(before.status).toBe('rejected')
    }
    expect(HarnessMcpPlansResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_plans_list', arguments: { harness: 'codex' },
    }))).items).toEqual([])
    const hidden = await client.callTool({ name: 'harness_mcp_change_get', arguments: { planId: plan.id } })
    expect(hidden.isError).toBe(true)
    expect(JSON.stringify(hidden.content)).toContain('MCP_PLAN_NOT_FOUND')
    const decision = await client.callTool({
      name: 'harness_mcp_change_decide', arguments: { planId: plan.id, approve },
    })
    const persisted = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await owner.callTool({
      name: 'harness_mcp_change_get', arguments: { planId: plan.id },
    })))
    expect(persisted).toEqual(before)
    expect(f.writes.mcp).toBe(0)
    expect(decision.isError).toBe(true)
    expect(JSON.stringify(decision.content)).toContain('MCP_PLAN_NOT_FOUND')
    expect(JSON.stringify(decision)).not.toContain('private-notes')
  })
