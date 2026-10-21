import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClaudePluginListResultSchema, ClaudePluginChangeResultSchema, ClaudePluginMarketplaceAddResultSchema,
} from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { ClaudePluginSettingsService } from '../src/modules/harnesses/claudePlugins.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { claudePluginPorts } from './helpers/claudePluginPorts.js'

describe.skipIf(!postgresEnabled)('Claude plugins through authenticated Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
  })

  it('lists, adds marketplaces, changes plugins, persists readback, retries once and rejects denied or stale writes', async () => {
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Plugin maintainer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Plugin reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const fake = claudePluginPorts()
    const commands = new PostgresCommandCoordinator(database.pool)
    const claudePlugins = new ClaudePluginSettingsService(fake.ports, commands)
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { commands, harnessSettings: { claudePlugins } } as unknown as OperatorServices },
    })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'plugin-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const operator = await connect(writer.token)
    const read = async () => ClaudePluginListResultSchema.parse(decodeMcpToolResult((await operator.callTool({
      name: 'claude_plugins_list', arguments: {},
    }))))
    expect((await operator.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'claude_plugins_list', 'claude_plugin_change', 'claude_plugin_marketplace_add',
    ]))
    const noRevisionMarketplace = { source: 'owner/extra', commandId: randomUUID() }
    const added = await operator.callTool({ name: 'claude_plugin_marketplace_add', arguments: noRevisionMarketplace })
    expect(ClaudePluginMarketplaceAddResultSchema.parse(decodeMcpToolResult(added)).marketplaces)
      .toContainEqual({ name: 'extra', source: 'owner/extra' })
    const noRevision = { pluginId: 'review@official', action: 'install', commandId: randomUUID() }
    const installed = await operator.callTool({ name: 'claude_plugin_change', arguments: noRevision })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(installed)).status).toBe('applied')
    expect(decodeMcpToolResult(await operator.callTool({ name: 'claude_plugin_change', arguments: noRevision })))
      .toEqual(decodeMcpToolResult(installed))
    fake.installed.get('review@official')!.enabled = false
    const enabled = await operator.callTool({ name: 'claude_plugin_change', arguments: {
      ...noRevision, action: 'enable', commandId: randomUUID(),
    } })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(enabled)).plugin?.enabled).toBe(true)
    expect((await read()).items.find(item => item.pluginId === 'review@official')?.enabled).toBe(true)
    expect((await operator.callTool({ name: 'claude_plugin_change', arguments: {
      ...noRevision, action: 'uninstall', commandId: randomUUID(),
    } })).isError).not.toBe(true)
    const marketplaceInput = { source: 'owner/official', commandId: randomUUID(), expectedRevision: (await read()).revision }
    const marketplace = await operator.callTool({ name: 'claude_plugin_marketplace_add', arguments: marketplaceInput })
    expect(ClaudePluginMarketplaceAddResultSchema.parse(decodeMcpToolResult(marketplace)).marketplaces)
      .toContainEqual({ name: 'official', source: 'owner/official' })
    const input = { pluginId: 'notes@official', action: 'install', commandId: randomUUID(), expectedRevision: (await read()).revision }
    const applied = await operator.callTool({ name: 'claude_plugin_change', arguments: input })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(applied))).toMatchObject({ status: 'applied', plugin: { installed: true } })
    const replay = await operator.callTool({ name: 'claude_plugin_change', arguments: input })
    expect(decodeMcpToolResult(replay)).toEqual(decodeMcpToolResult(applied))
    expect(fake.changes.filter(change => change === 'install:notes@official')).toHaveLength(1)
    const stale = await operator.callTool({ name: 'claude_plugin_change', arguments: { ...input, commandId: randomUUID(), action: 'disable' } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
    const conflict = await operator.callTool({ name: 'claude_plugin_change', arguments: { ...input, action: 'uninstall' } })
    expect(conflict.isError).toBe(true)
    expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    const http = await app.inject({ url: '/api/management/harnesses/claude/plugins', headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(ClaudePluginListResultSchema.parse(http.json()).items[0]).toMatchObject({ pluginId: 'notes@official', enabled: true })
    for (const action of ['disable', 'enable', 'uninstall']) {
      const changed = await operator.callTool({ name: 'claude_plugin_change', arguments: {
        ...input, action, commandId: randomUUID(), expectedRevision: (await read()).revision,
      } })
      expect(changed.isError).not.toBe(true)
      const items = (await read()).items
      if (action === 'uninstall') expect(items).toHaveLength(0)
      else expect(items[0]?.enabled).toBe(action === 'enable')
    }
    fake.installed.set('review@official', { version: '2.0.0', enabled: true })
    const refreshed = await operator.callTool({ name: 'claude_plugins_list', arguments: { refresh: true } })
    expect(ClaudePluginListResultSchema.parse(decodeMcpToolResult(refreshed)).items[0]?.version).toBe('2.0.0')
    fake.installed.delete('review@official')
    await operator.callTool({ name: 'claude_plugins_list', arguments: { refresh: true } })
    const available = await operator.callTool({ name: 'claude_plugins_list', arguments: { view: 'available', query: 'review', limit: 1 } })
    expect(ClaudePluginListResultSchema.parse(decodeMcpToolResult(available)).items.map(item => item.pluginId)).toEqual(['review@official'])
    const review = await operator.callTool({ name: 'claude_plugin_change', arguments: {
      ...input, pluginId: 'command@official', commandId: randomUUID(), expectedRevision: (await read()).revision,
    } })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(review))).toMatchObject({ status: 'command_review' })
    expect(fake.installed.has('command@official')).toBe(false)
    const nativeRun = fake.ports.run
    let failReadback = false
    fake.ports.run = async (binary, args, options) => {
      if (failReadback && args[1] === 'list') {
        failReadback = false
        return { code: 1, stdout: '', stderr: 'Temporary catalog failure' }
      }
      const value = await nativeRun(binary, args, options)
      if (args[1] === 'install' && args[2] === 'notes@official') failReadback = true
      return value
    }
    const recoveryInput = { ...input, commandId: randomUUID(), expectedRevision: (await read()).revision }
    const uncertain = await operator.callTool({ name: 'claude_plugin_change', arguments: recoveryInput })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(uncertain)).status).toBe('uncertain')
    const recovered = await operator.callTool({ name: 'claude_plugin_change', arguments: recoveryInput })
    expect(ClaudePluginChangeResultSchema.parse(decodeMcpToolResult(recovered)).status).toBe('applied')
    expect(fake.changes.filter(change => change === 'install:notes@official')).toHaveLength(2)
    await operator.callTool({ name: 'claude_plugin_change', arguments: {
      ...input, action: 'uninstall', commandId: randomUUID(), expectedRevision: (await read()).revision,
    } })
    const readOnly = await connect(reader.token)
    expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('claude_plugin_change')
    const denied = await readOnly.callTool({ name: 'claude_plugin_change', arguments: { ...input, commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(fake.installed.size).toBe(0)
    const deniedHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/claude/plugins/change',
      headers: { authorization: `Bearer ${reader.token}` }, payload: { ...input, commandId: randomUUID() } })
    expect(deniedHttp.statusCode).toBe(403)
    const audits = await database.pool.query<{ outcome: string; source: string }>(
      'select outcome, source from management_audit where principal_id in ($1,$2)', [writer.principal.id, reader.principal.id])
    expect(audits.rows).toContainEqual({ outcome: 'succeeded', source: 'mcp' })
    expect(audits.rows).toContainEqual({ outcome: 'denied', source: 'http' })
  })
})
