import { workerHarnessCatalogFixture } from './helpers/workerHarnessCatalog.js'
import { createInstalledWorkerProfileChecks } from '../src/modules/harnesses/installedWorkerProfileChecks.js'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import { workerProviderAccountResolver } from '../src/modules/provider-accounts/workerOperations.js'
import { ProviderAccountSchema } from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HarnessOptionsResultSchema } from '@foreman-code/contracts/management'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('refreshes and reads back model options through authenticated HTTP and Operator MCP', async () => {
  const tempRoot = join(homedir(), '.cache/foreman-tmp')
  await mkdir(tempRoot, { recursive: true })
  const directory = await mkdtemp(join(tempRoot, 'native-model-mcp-'))
  const cache = join(directory, 'catalog.json')
  await writeFile(cache, JSON.stringify(['provider/old-model']))
  const database = await migratedDatabase()
  const { pool } = database
  const access = new PostgresAccessService(pool)
  const clients: Client[] = []
  const modelOptions = async () => HarnessOptionsResultSchema.parse({
    harness: 'codex', providerVersion: '0.154.0', authenticated: true,
    models: (JSON.parse(await readFile(cache, 'utf8')) as string[]).map((id) => ({
      id, name: id, reasoningEfforts: [], variants: [''], serviceTiers: [],
    })), nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  const native = {
    options: vi.fn(modelOptions),
    refreshOptions: vi.fn(async (_harness: string, refresh: string) => {
      if (refresh === 'upstream') throw new Error('Upstream refresh is unsupported')
      await writeFile(cache, JSON.stringify(['provider/new-model']))
      return modelOptions()
    }),
  }
  const invalidateChecks = vi.fn()
  const services = { commands: new PostgresCommandCoordinator(pool), harnesses: { invalidateChecks },
    extensions: { native } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  try {
    const readerGrant = await access.issue({ name: 'Model catalog reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const updaterGrant = await access.issue({ name: 'Model catalog updater', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const denied = await access.issue({ name: 'No harness grant', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'model-refresh-test', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const reader = await connect(readerGrant.token)
    const updater = await connect(updaterGrant.token)
    const restricted = await connect(denied.token)
    const readerTools = (await reader.listTools()).tools
    expect(readerTools.map((tool) => tool.name)).toContain('harness_options_refresh')
    expect(readerTools.map((tool) => tool.name)).not.toContain('opencode_models_cache_update')
    expect(readerTools.find((tool) => tool.name === 'harness_options_refresh')?.annotations?.readOnlyHint).toBe(true)
    expect((await updater.listTools()).tools.map(tool => tool.name)).not.toContain('opencode_models_cache_update')
    expect((await restricted.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_options_refresh')
    const deniedCall = await restricted.callTool({ name: 'harness_options_refresh', arguments: { harness: 'codex' } })
      .then((result) => result.isError === true, () => true)
    expect(deniedCall).toBe(true)
    const deniedUpdate = await reader.callTool({ name: 'opencode_models_cache_update', arguments: { harness: 'codex' } })
      .then((result) => result.isError === true, () => true)
    expect(deniedUpdate).toBe(true)
    expect(native.refreshOptions).not.toHaveBeenCalled()
    const before = HarnessOptionsResultSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'harness_options_get', arguments: { harness: 'codex' } }))))
    expect(before.models.map((model) => model.id)).toEqual(['provider/old-model'])
    const local = await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/refresh',
      headers: { authorization: `Bearer ${readerGrant.token}`, host: 'localhost' }, payload: {} })
    expect(local.statusCode).toBe(200)
    expect(HarnessOptionsResultSchema.parse(local.json()).models[0]?.id).toBe('provider/new-model')
    expect(native.refreshOptions).toHaveBeenLastCalledWith('codex', 'catalog', undefined, undefined)
    const localMcp = HarnessOptionsResultSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'harness_options_refresh',
      arguments: { harness: 'codex' } }))))
    expect(localMcp.models.map((model) => model.id)).toEqual(['provider/new-model'])
    expect(invalidateChecks).toHaveBeenCalledTimes(2)
    const readback = HarnessOptionsResultSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'harness_options_get', arguments: { harness: 'codex' } }))))
    expect(readback.models.map((model) => model.id)).toEqual(['provider/new-model'])
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual(['provider/new-model'])
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app.close()
    await database.close()
    await removeFixtureDirectory(directory)
  }
}, 30_000)

vi.mock('../src/modules/harnesses/codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    constructor(_binary: string, _cwd: string, private readonly environment: NodeJS.ProcessEnv) {}
    async start() {}
    async request(method: string) {
      expect(method).toBe('account/read')
      return (await import('./helpers/workerHarnessCatalog.js')).catalogCodexAccount(this.environment)
    }
    async close() {}
  },
}))

vi.mock('../src/modules/harnesses/codexProtocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexProtocol.js')>(),
  qualifyCodex: vi.fn((await import('./helpers/workerHarnessCatalog.js')).catalogCodexQualification),
  assertCodexUnchanged: async () => {},
}))
vi.mock('../src/modules/harnesses/codexModelCatalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexModelCatalog.js')>(),
  readNativeCodexModelCatalog: vi.fn((await import('./helpers/workerHarnessCatalog.js')).catalogCodexModels),
}))
vi.mock('../src/modules/harnesses/claudeSdk/official.js', () => ({
  loadOfficialClaudeSdk: vi.fn(async (profile: string) =>
    (await import('./helpers/workerHarnessCatalog.js')).catalogClaudeClient(profile)),
}))
vi.mock('../src/modules/harnesses/process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/process.js')>(),
  runCommand: async () => ({ stdout: '2.1.284 (Claude Code)', stderr: '', exitCode: 0 }),
}))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

it.each(['codex', 'claude'] as const)(
  'refreshes a Worker managed %s subscription catalog through HTTP and authenticated MCP', async harness => {
    const f = await workerHarnessCatalogFixture()
    const slot = await f.managed(harness)
    await f.setLogin(harness, null)
    const readAccount = async () => ProviderAccountSchema.parse(JSON.parse(await readFile(slot.file, 'utf8')))
    const accounts = workerProviderAccountResolver({ current: f.current, resolve: async () => ({
      account: await readAccount(), homePath: slot.homePath, userHome: join(slot.homePath, '..'),
    }) })
    const worker = await createInstalledWorkerProfileChecks({ ...f.input, pairing: f.pairing, accounts: () => accounts })
    const request = vi.fn(async (input: unknown, options: { signal: AbortSignal }) =>
      worker!.extension.handle(input, f.context(options.signal)))
    const endpoint = { captureRequest: () => ({ binding: f.connection, request }) }
    const native = new NativeConfigurationService('', f.root, undefined, undefined, undefined,
      { mainId: () => f.connection.mainId, endpoint: () => endpoint as never })
    const database = await migratedDatabase()
    const access = new PostgresAccessService(database.pool)
    const services = { commands: new PostgresCommandCoordinator(database.pool), harnesses: { invalidateChecks: vi.fn() },
      extensions: { native }, providerAccounts: { get: async (principal: ManagementPrincipal, raw: {
        accountId: string; target: unknown;
      }) => {
        requireAuthorization(principal, 'provider_accounts:read', { mainId: f.connection.mainId,
          deviceId: f.connection.deviceId, applicationInstallationId: f.connection.workerInstallationId,
          providerAccountId: slot.binding.accountId })
        expect(raw).toEqual({ accountId: slot.binding.accountId, target: slot.binding.target })
        return readAccount()
      } } } as unknown as OperatorServices
    const app = buildApp({ logger: false, readiness: {
      database: { ping: async () => {} }, checkpoints: { ping: async () => {} },
    }, operator: { access, services } })
    let client: Client | undefined
    try {
      const grant = await access.issue({ name: 'Scoped model reader', audience: 'operator',
        grants: [{ actions: ['harnesses:read'], scope: {} }, { actions: ['provider_accounts:read'], scope: {
          mainIds: [f.connection.mainId], deviceIds: [f.connection.deviceId],
          applicationInstallationIds: [f.connection.workerInstallationId], providerAccountIds: [slot.binding.accountId],
        } }], expiresAt: new Date(Date.now() + 120_000) })
      const denied = await access.issue({ name: 'Native catalog reader', audience: 'operator',
        grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      client = new Client({ name: 'worker-catalog-reader', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => grant.token },
      }))
      const input = { harness, hostRef: f.hostRef, accountBinding: slot.binding }
      for (const name of ['harness_options_get', 'harness_options_refresh']) {
        const result = HarnessOptionsResultSchema.parse(decodeMcpToolResult(await client.callTool({ name, arguments: input })))
        expect(result).toMatchObject({ harness, authenticated: true, models: [{ id: 'managed-model', reasoningEfforts: ['high'] }] })
      }
      const beforeDenied = request.mock.calls.length
      const denial = await app.inject({ method: 'POST', url: `/api/management/harnesses/${harness}/refresh`,
        headers: { authorization: `Bearer ${denied.token}` }, payload: { hostRef: f.hostRef, accountBinding: slot.binding } })
      expect(denial.statusCode).toBe(403)
      expect(request).toHaveBeenCalledTimes(beforeDenied)
      const refreshed = await app.inject({ method: 'POST', url: `/api/management/harnesses/${harness}/refresh`,
        headers: { authorization: `Bearer ${grant.token}` }, payload: { hostRef: f.hostRef, accountBinding: slot.binding } })
      expect(refreshed.statusCode).toBe(200)
      expect(HarnessOptionsResultSchema.parse(refreshed.json())).toMatchObject({
        authenticated: true, models: [{ id: 'managed-model', reasoningEfforts: ['high'] }],
      })
      const readback = await app.inject({ method: 'GET',
        url: `/api/management/harnesses/${harness}/options?${new URLSearchParams({
          hostRef: JSON.stringify(f.hostRef), accountBinding: JSON.stringify(slot.binding) })}`,
        headers: { authorization: `Bearer ${grant.token}` } })
      expect(readback.statusCode).toBe(200)
      expect(readback.json().models).toEqual(refreshed.json().models)
      expect((await readAccount()).binding).toEqual(slot.binding)
    } finally {
      await client?.close()
      await app.close()
      await worker?.close()
      await native.shutdownChecks()
      await database.close()
      await f.close()
    }
  })
