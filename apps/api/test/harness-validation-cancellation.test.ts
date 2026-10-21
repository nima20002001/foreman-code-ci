import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessConfigurationCheckResultSchema, ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'

const principal = ManagementPrincipalSchema.parse({ id: 'reader', name: 'Reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['harnesses:read'], scope: {} }] })
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function qualification(configuration: HarnessConfiguration) {
  return { harness: configuration.harness, version: 'fixture', authenticated: true, ready: true,
    structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
    supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }
}

async function fixture() {
  let paused = true
  const active: Array<{ configuration: HarnessConfiguration; signal: AbortSignal; resolve(): void }> = []
  const qualify = vi.fn(async (configuration: HarnessConfiguration, _directory: string, signal: AbortSignal) => {
    if (paused) await new Promise<void>((resolve, reject) => {
      active.push({ configuration, signal, resolve })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return qualification(configuration)
  })
  const catalog = new HarnessCatalogService({ qualify }, {} as PostgresSettingsRepository,
    {} as PostgresCommandCoordinator, '/unit/qualification')
  closes.push(() => catalog.shutdownChecks())
  const access = { authenticate: async (token: string) => {
    if (token === 'reader-token') return principal
    if (token === 'denied-token') return { ...principal, id: 'denied', grants: [{ actions: ['capabilities:read'], scope: {} }] }
    throw new DomainError('AUTH_REQUIRED', 'Invalid credential.', 401)
  } } as unknown as PostgresAccessService
  const recordDenied = vi.fn(async () => undefined)
  const services = { harnesses: catalog, extensions: { native: {} },
    commands: { recordDenied } } as unknown as OperatorServices
  const app = buildApp({ logger: false, operator: { access, services },
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
  closes.push(async () => {
    await catalog.shutdownChecks()
    await app.close()
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const check = (configuration: HarnessConfiguration, signal: AbortSignal) => fetch(
    new URL('/api/management/harnesses/validate', address), {
      method: 'POST', headers: { authorization: 'Bearer reader-token', 'content-type': 'application/json' },
      body: JSON.stringify({ configuration }), signal,
    })
  return { app, address, catalog, qualify, active, check, recordDenied,
    resume: () => { paused = false }, pause: () => { paused = true } }
}

it('cancels abandoned HTTP drafts while preserving another reader of the same configuration', async () => {
  const { active, check, qualify } = await fixture()
  const one = new AbortController()
  const two = new AbortController()
  const other = new AbortController()
  const configuration = DEFAULT_HARNESS_DEFAULTS.codex
  const next = { ...configuration, reasoningEffort: 'high' as const }
  const a = check(configuration, one.signal)
  const b = check(configuration, two.signal)
  const c = check(next, other.signal)
  const canceled = Promise.allSettled([a, c])
  await vi.waitFor(() => expect(active).toHaveLength(2))
  const shared = active.find(item => item.configuration.harness === 'codex'
    && item.configuration.reasoningEffort === 'medium')!
  const distinct = active.find(item => item.configuration.harness === 'codex'
    && item.configuration.reasoningEffort === 'high')!
  one.abort()
  other.abort()
  await canceled
  await vi.waitFor(() => expect(distinct.signal.aborted).toBe(true))
  expect(shared.signal.aborted).toBe(false)
  shared.resolve()
  const response = await b
  expect(response.status).toBe(200)
  expect(HarnessConfigurationCheckResultSchema.parse(await response.json()).qualification.ready).toBe(true)
  expect(qualify).toHaveBeenCalledTimes(2)
})

it('cancels the native qualification after the last HTTP reader leaves', async () => {
  const { active, check } = await fixture()
  const controller = new AbortController()
  const request = check(DEFAULT_HARNESS_DEFAULTS.codex, controller.signal)
  const canceled = Promise.allSettled([request])
  await vi.waitFor(() => expect(active).toHaveLength(1))
  controller.abort()
  await canceled
  await vi.waitFor(() => expect(active[0]!.signal.aborted).toBe(true))
})

it('awaits an expired draft check and cancels its refresh when the HTTP reader leaves', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { active, check, resume, pause } = await fixture()
  resume()
  const initial = await check(DEFAULT_HARNESS_DEFAULTS.codex, AbortSignal.timeout(1000))
  expect(initial.status).toBe(200)
  await initial.json()
  pause()
  now += 300_001
  const controller = new AbortController()
  let settled = false
  const request = check(DEFAULT_HARNESS_DEFAULTS.codex, controller.signal).finally(() => { settled = true })
  const canceled = Promise.allSettled([request])
  await vi.waitFor(() => expect(active).toHaveLength(1))
  expect(settled).toBe(false)
  controller.abort()
  await canceled
  await vi.waitFor(() => expect(active[0]!.signal.aborted).toBe(true))
})

it('reads the same qualification through authenticated MCP and denies a caller without the read grant', async () => {
  const { address, resume, qualify, app, recordDenied } = await fixture()
  resume()
  const connect = async (token: string) => {
    const client = new Client({ name: 'validation-read-test', version: '1' })
    closes.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  const reader = await connect('reader-token')
  const denied = await connect('denied-token')
  const discovered = (await reader.listTools()).tools.map(tool => tool.name)
  expect(discovered).toContain('harness_configuration_check')
  expect(discovered).not.toContain('workspace_location_provision')
  const input = { configuration: DEFAULT_HARNESS_DEFAULTS.codex }
  const read = () => reader.callTool({ name: 'harness_configuration_check', arguments: input })
  const first = HarnessConfigurationCheckResultSchema.parse(decodeMcpToolResult(await read()))
  expect(first.qualification.ready).toBe(true)
  expect(HarnessConfigurationCheckResultSchema.parse(decodeMcpToolResult(await read()))).toEqual(first)
  expect(qualify).toHaveBeenCalledTimes(1)
  expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_configuration_check')
  const rejected = await denied.callTool({ name: 'harness_configuration_check', arguments: input })
  expect(rejected).toMatchObject({ isError: true })
  expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
  expect(recordDenied).toHaveBeenCalledWith('denied', 'mcp', 'harness_configuration_check',
    'mcp:harness_configuration_check')
  expect((await app.inject({ method: 'POST', url: '/api/management/harnesses/validate', payload: input,
    headers: { authorization: 'Bearer denied-token' } })).statusCode).toBe(403)
  expect(qualify).toHaveBeenCalledTimes(1)
})
