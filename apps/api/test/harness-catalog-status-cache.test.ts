import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessCatalogEntrySchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import { logger } from '../src/modules/diagnostics/logger.js'
import Fastify from 'fastify'
import { registerGraphqlMcp, type GraphqlMcpServices } from '../src/mcp/unified/transport.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['harnesses:read'], scope: {} }] }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(ready = () => true) {
  const qualify = vi.fn(async (configuration: HarnessConfiguration) => ({ harness: configuration.harness,
    version: 'fixture', authenticated: ready(), ready: ready(), structuredEvents: true, supportsResume: true,
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }))
  const settings = { getManagedHarnessDefaults: async () => ({ revision: 3,
    defaults: HarnessDefaultsSchema.parse({ ...DEFAULT_HARNESS_DEFAULTS, claude: {
      harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/unit/claude-profile',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } }) }) } as unknown as PostgresSettingsRepository
  const catalog = new HarnessCatalogService({ qualify }, settings, {} as PostgresCommandCoordinator, '/unit/qualification')
  return { catalog, qualify }
}

describe('harness catalog status reads', () => {
  it('returns freshness through authenticated MCP and denies callers without harness read access', async () => {
    const { catalog } = fixture()
    const app = Fastify()
    const recordDenied = vi.fn(async () => undefined)
    const services = { access: { authenticate: async (token: string) => token === 'reader' ? principal
      : { ...principal, id: 'denied-reader', grants: [] } },
      operator: { harnesses: catalog, commands: { recordDenied } } } as unknown as GraphqlMcpServices
    registerGraphqlMcp(app, services)
    const call = async (token: string) => {
      const response = await app.inject({ method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'harness_get', arguments: { harness: 'codex' } } } })
      expect(response.statusCode).toBe(200)
      const data = response.body.startsWith('event:')
        ? JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : response.json()
      return data.result
    }
    try {
      const first = await call('reader')
      expect(first.isError).not.toBe(true)
      expect(decodeMcpToolResult(first)).toMatchObject({ observation: { stale: false, refreshing: false, lastError: null } })
      expect(decodeMcpToolResult(await call('reader'))).toEqual(decodeMcpToolResult(first))
      const denied = await call('denied')
      expect(denied.isError).toBe(true)
      expect(recordDenied).toHaveBeenCalledOnce()
    } finally {
      await catalog.shutdownChecks()
      await app.close()
    }
  })

  it('exposes expired checks, pending refresh and a failed background refresh to readers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = new Date('2026-10-01T00:00:00Z')
    vi.setSystemTime(start)
    const warn = vi.spyOn(logger, 'warn')
    const { catalog, qualify } = fixture()
    const first = HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))
    expect(first).toMatchObject({ observation: { checkedAt: start.toISOString(), stale: false, refreshing: false,
      refreshCount: 0, failureCount: 0, staleReadCount: 0, lastError: null } })
    let reject!: (error: Error) => void
    qualify.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.setSystemTime(new Date(start.getTime() + 300_001))
    const pending = HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))
    expect(pending).toMatchObject({ capability: { ready: true }, observation: {
      checkedAt: start.toISOString(), stale: true, refreshing: true, refreshCount: 1, staleReadCount: 1,
    } })
    const readiness = new ExecutionReadinessService({ enabled: () => true }, catalog)
    expect(await readiness.get(principal, 'codex')).toMatchObject({ status: 'unverified',
      checkedAt: start.toISOString(), reason: { code: 'HARNESS_STATUS_REFRESHING' } })
    reject(new Error('Native probe failed'))
    await expect(catalog.checkConfiguration(principal, DEFAULT_HARNESS_DEFAULTS.codex))
      .rejects.toMatchObject({ code: 'HARNESS_QUALIFICATION_FAILED' })
    const failed = HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))
    expect(failed).toMatchObject({ observation: { checkedAt: start.toISOString(),
      stale: false, refreshing: false, refreshCount: 1, failureCount: 1, lastError: expect.any(String) } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ failureCount: 1 }),
      'Native readiness refresh failed')
    expect(failed.capability).toEqual(first.capability)
    expect(HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))).toEqual(failed)
    expect(qualify).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date(start.getTime() + 315_002))
    const retrying = HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))
    expect(retrying).toMatchObject({ capability: first.capability, observation: {
      checkedAt: start.toISOString(), stale: true, refreshing: true, refreshCount: 2, failureCount: 1,
    } })
    await catalog.checkConfiguration(principal, DEFAULT_HARNESS_DEFAULTS.codex)
    const recovered = HarnessCatalogEntrySchema.parse(await catalog.get(principal, 'codex'))
    expect(recovered).toMatchObject({ capability: first.capability, discoveryError: null, observation: {
      checkedAt: new Date().toISOString(), stale: false, refreshing: false,
      refreshCount: 2, failureCount: 1, lastError: null,
    } })
    expect(qualify).toHaveBeenCalledTimes(3)
    await catalog.shutdownChecks()
  })

  it('reuses a settled check across polled reads without native work', async () => {
    const { catalog, qualify } = fixture()
    const first = await catalog.list(principal)
    expect(first.map(entry => entry.discoveryError)).toEqual([null, null])
    expect(qualify).toHaveBeenCalledTimes(2)
    expect(await catalog.list(principal)).toEqual(first)
    expect((await catalog.get(principal, 'codex')).capability).toEqual(first[0]!.capability)
    expect(qualify).toHaveBeenCalledTimes(2)
  })

  it('keeps writer qualification fresh and re-reads after invalidation', async () => {
    let ready = true
    const { catalog, qualify } = fixture(() => ready)
    await catalog.list(principal)
    expect((await catalog.checkConfiguration(principal, DEFAULT_HARNESS_DEFAULTS.codex)).qualification.ready).toBe(true)
    expect(qualify).toHaveBeenCalledTimes(2)
    ready = false
    await expect(catalog.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex)).rejects.toMatchObject({ code: 'HARNESS_DEFAULTS_UNQUALIFIED' })
    expect(qualify).toHaveBeenCalledTimes(3)
    expect((await catalog.get(principal, 'codex')).discoveryError).toBeNull()
    catalog.invalidateChecks()
    expect((await catalog.get(principal, 'codex')).discoveryError).toMatchObject({ code: 'HARNESS_DEFAULTS_UNQUALIFIED' })
    expect(qualify).toHaveBeenCalledTimes(4)
  })
})
