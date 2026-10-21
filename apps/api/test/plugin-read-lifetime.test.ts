import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CodexPluginDetailResultSchema, CodexPluginListResultSchema, ManagementPrincipalSchema,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { ClaudePluginSettingsService } from '../src/modules/harnesses/claudePlugins.js'
import { normalizeCodexPluginCatalog } from '../src/modules/harnesses/codexPluginCatalog.js'
import { CodexPluginSettingsService } from '../src/modules/harnesses/codexPluginSettings.js'
import type { CodexPluginAdapter } from '../src/modules/harnesses/codexPlugins.js'
import { claudePluginPorts } from './helpers/claudePluginPorts.js'

const principal = ManagementPrincipalSchema.parse({ id: 'reader', name: 'Reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['harnesses:read'], scope: {} }] })
const input = { view: 'available' as const, query: '', offset: 0, limit: 24 }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function gate() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const signals: AbortSignal[] = []
  const wait = (signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void pending.then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
    })
  }
  return { release, signals, wait }
}

function codexFixture(wait?: (signal: AbortSignal) => Promise<void>) {
  let installed = false
  const plugin = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1',
    enabled: true, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_USE',
    source: { source: 'remote', id: 'notes' } }
  const list = vi.fn(async (signal: AbortSignal) => {
    await wait?.(signal)
    const item = { ...plugin, installed }
    return normalizeCodexPluginCatalog({ installed: installed ? [item] : [], available: installed ? [] : [item] },
      { file: '/unit/config.toml', userConfig: { plugins: installed ? { [item.pluginId]: { enabled: true } } : {} } },
      'complete')
  })
  const adapter: CodexPluginAdapter = { recoveryIdentity: 'fixture-writer', list, detail: async () => ({ status: 'unknown' }),
    change: async () => ({ acknowledged: true, version: '1' }) }
  const service = new CodexPluginSettingsService({} as pg.Pool, adapter)
  cleanup.push(() => service.shutdown())
  return { service, list, install: () => { installed = true } }
}

function claudeFixture(wait: (signal: AbortSignal) => Promise<void>) {
  const fake = claudePluginPorts()
  const run = fake.ports.run
  const list = vi.fn(async (binary: string, args: string[], options: Parameters<typeof run>[2]) => {
    if (args[1] === 'list') await wait(options.signal)
    return run(binary, args, options)
  })
  const service = new ClaudePluginSettingsService({ ...fake.ports, run: list }, {} as PostgresCommandCoordinator)
  return { service, list }
}

describe.each(['codex', 'claude'] as const)('%s plugin catalog reader ownership', (harness) => {
  const fixture = (wait: (signal: AbortSignal) => Promise<void>) =>
    harness === 'codex' ? codexFixture(wait) : claudeFixture(wait)

  it('keeps one cold discovery alive after its first reader cancels', async () => {
    const blocked = gate()
    const { service } = fixture(blocked.wait)
    const first = new AbortController()
    const second = new AbortController()
    const a = service.list(principal, input, first.signal)
    const b = service.list(principal, input, second.signal)
    const canceled = expect(a).rejects.toThrow('closed first view')
    await vi.waitFor(() => expect(blocked.signals).toHaveLength(1))
    first.abort(new Error('closed first view'))
    await canceled
    expect(blocked.signals[0]!.aborted).toBe(false)
    blocked.release()
    expect((await b).items.length).toBeGreaterThan(0)
    expect(blocked.signals).toHaveLength(1)
  })

  it('cancels native discovery when every reader abandons it', async () => {
    const blocked = gate()
    const { service } = fixture(blocked.wait)
    const first = new AbortController()
    const second = new AbortController()
    const a = service.list(principal, input, first.signal)
    const b = service.list(principal, input, second.signal)
    const canceled = Promise.allSettled([a, b])
    await vi.waitFor(() => expect(blocked.signals).toHaveLength(1))
    first.abort()
    expect(blocked.signals[0]!.aborted).toBe(false)
    second.abort()
    await canceled
    expect(blocked.signals[0]!.aborted).toBe(true)
    blocked.release()
  })

  it('shares a forced refresh without giving the first reader cancellation ownership', async () => {
    const held: { blocked?: ReturnType<typeof gate> } = {}
    const { service } = fixture((signal) => held.blocked ? held.blocked.wait(signal) : Promise.resolve())
    await service.list(principal, input)
    held.blocked = gate()
    const first = new AbortController()
    const second = new AbortController()
    const a = service.list(principal, { ...input, refresh: true }, first.signal)
    const b = service.list(principal, { ...input, refresh: true }, second.signal)
    const canceled = expect(a).rejects.toThrow('closed refresh')
    await vi.waitFor(() => expect(held.blocked!.signals).toHaveLength(1))
    first.abort(new Error('closed refresh'))
    await canceled
    expect(held.blocked.signals[0]!.aborted).toBe(false)
    held.blocked.release()
    expect((await b).items.length).toBeGreaterThan(0)
    expect(held.blocked.signals).toHaveLength(1)
  })
})

it('awaits fresh Codex inventory and revisions instead of returning the cached catalog', async () => {
  const held: { blocked?: ReturnType<typeof gate> } = {}
  const { service, install, list } = codexFixture((signal) => held.blocked ? held.blocked.wait(signal) : Promise.resolve())
  const before = await service.list(principal, input)
  install()
  expect((await service.list(principal, input)).items).toEqual(before.items)
  held.blocked = gate()
  let settled = false
  const fresh = service.list(principal, { ...input, view: 'installed', refresh: true }).then(result => {
    settled = true
    return result
  })
  await vi.waitFor(() => expect(held.blocked!.signals).toHaveLength(1))
  expect(settled).toBe(false)
  held.blocked.release()
  const after = await fresh
  expect(after.items[0]).toMatchObject({ installed: true })
  expect(after.revision).not.toBe(before.revision)
  expect((await service.get(principal, 'notes@trusted')).revision).toBe(after.revision)
  expect(list).toHaveBeenCalledTimes(2)
})

it('supports fresh plugin reads through authenticated MCP and preserves read grants', async () => {
  const { service, install, list } = codexFixture()
  const denied: ManagementPrincipal = { ...principal, id: 'denied', grants: [{ actions: ['capabilities:read'], scope: {} }] }
  const access = { authenticate: async (token: string) => {
    if (token === 'reader-token') return principal
    if (token === 'denied-token') return denied
    throw new DomainError('AUTH_REQUIRED', 'Invalid credential.', 401)
  } } as unknown as PostgresAccessService
  const recordDenied = vi.fn(async () => undefined)
  const fakeClaude = claudePluginPorts()
  const claude = new ClaudePluginSettingsService(fakeClaude.ports, {} as PostgresCommandCoordinator)
  const services = { harnessSettings: { plugins: service, claudePlugins: claude, mcp: {}, directories: {} },
    commands: { recordDenied } } as unknown as OperatorServices
  const app = buildApp({ logger: false, operator: { access, services },
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
  cleanup.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'plugin-read-test', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  const allowed = await connect('reader-token')
  const disallowed = await connect('denied-token')
  expect((await allowed.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'codex_plugins_list', 'codex_plugin_get', 'claude_plugins_list',
  ]))
  const read = async (arguments_: Record<string, unknown>) => CodexPluginListResultSchema.parse(
    decodeMcpToolResult(await allowed.callTool({ name: 'codex_plugins_list', arguments: arguments_ })))
  const before = await read(input)
  install()
  expect((await read(input)).revision).toBe(before.revision)
  const after = await read({ view: 'installed', refresh: true })
  expect(after.items[0]).toMatchObject({ installed: true })
  expect(after.revision).not.toBe(before.revision)
  const detail = CodexPluginDetailResultSchema.parse(decodeMcpToolResult(await allowed.callTool({
    name: 'codex_plugin_get', arguments: { pluginId: 'notes@trusted', refresh: true },
  })))
  expect(detail.plugin.installed).toBe(true)
  expect((await read({ view: 'installed' })).revision).toBe(detail.revision)
  expect((await app.inject({ url: '/api/management/harnesses/codex/plugins/notes%40trusted?refresh=true',
    headers: { authorization: 'Bearer reader-token' } })).json()).toMatchObject({ plugin: { installed: true } })
  await allowed.callTool({ name: 'claude_plugins_list', arguments: { view: 'installed' } })
  fakeClaude.installed.set('notes@official', { version: '2', enabled: true })
  const claudeRead = decodeMcpToolResult(await allowed.callTool({ name: 'claude_plugins_list',
    arguments: { view: 'installed', refresh: true } }))
  expect(claudeRead).toMatchObject({ items: [{ pluginId: 'notes@official', version: '2' }] })
  expect(decodeMcpToolResult(await allowed.callTool({ name: 'claude_plugins_list',
    arguments: { view: 'installed' } }))).toMatchObject({ items: [{ pluginId: 'notes@official', version: '2' }] })
  const reads = list.mock.calls.length
  expect((await disallowed.listTools()).tools.map(tool => tool.name)).not.toContain('codex_plugins_list')
  for (const name of ['codex_plugins_list', 'codex_plugin_get', 'claude_plugins_list']) {
    const rejected = await disallowed.callTool({ name, arguments: { refresh: true } })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
  }
  expect((await app.inject({ url: '/api/management/harnesses/codex/plugins?refresh=true',
    headers: { authorization: 'Bearer denied-token' } })).statusCode).toBe(403)
  expect(list).toHaveBeenCalledTimes(reads)
  expect(recordDenied).toHaveBeenCalled()
})
