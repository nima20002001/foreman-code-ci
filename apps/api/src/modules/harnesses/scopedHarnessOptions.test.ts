import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { buildApp } from '../../app.js'
import { requireAuthorization } from '../access/policy.js'
import { NativeConfigurationService } from './nativeConfiguration.js'

const metadata = (harness: 'codex' | 'claude', id: string) => ({ harness, providerVersion: 'fixture', authenticated: true,
  models: [{ id, reasoningEfforts: ['high'], variants: [], serviceTiers: [] }], nativeAgents: [],
  settings: [], restrictions: [], checkedAt: new Date().toISOString() })

it.each(['codex', 'claude'] as const)('reads Worker %s catalogs through HTTP and authenticated Operator MCP', async harness => {
  const hostRef = { kind: 'device' as const, mainId: randomUUID(), deviceId: randomUUID() }
  const binding = { mainId: hostRef.mainId, deviceId: hostRef.deviceId, workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: 'connection', connectionGeneration: 1,
    keyRevision: 1, authorizationRevision: 1 }
  const request = vi.fn(async () => ({ payload: metadata(harness, 'worker-model') }))
  const captureRequest = vi.fn(() => ({ binding, request }))
  const discoverModels = vi.fn(async () => metadata('codex', 'main-model'))
  const native = new NativeConfigurationService('/installed/codex', '/workspace', {
    cacheIdentity: async () => 'main', allocate: () => ({ harness: 'codex', manager: { discoverModels } }),
    disposeAuxiliary: async () => {},
  } as never, { discover: async () => metadata('claude', 'main-model') } as never, undefined,
  { mainId: () => hostRef.mainId, endpoint: () => ({ captureRequest }) as never })
  const principal: ManagementPrincipal = { id: 'catalog-reader', name: 'Catalog reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['harnesses:read'], scope: {} }] }
  const access = { authenticate: async (token: string) => token === 'denied-reader'
    ? { ...principal, grants: [] } : principal } as unknown as PostgresAccessService
  const services = { extensions: { native }, harnesses: { invalidateChecks: vi.fn() },
    providerAccounts: { get: async (caller: ManagementPrincipal) => {
      requireAuthorization(caller, 'provider_accounts:read')
      throw new Error('This fixture has no readable account slots')
    } },
    commands: { recordDenied: vi.fn(async () => {}) } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const rpc = async (token: string, name: string, args: object) => {
      const response = await fetch(new URL('/mcp', address), { method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
          'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const body = await response.text()
      const json = body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body
      return JSON.parse(json).result
    }
    const input = { harness, hostRef }
    expect((await rpc('denied-reader', 'harness_options_get', input)).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
    const accountBinding = { kind: 'slot', provider: harness, accountId: randomUUID(), profileRef: 'selected',
      target: { hostRef, applicationInstallationId: binding.workerInstallationId, keyRevision: 1,
        authorizationRevision: 1 }, bindingRevision: 1, subject: null }
    const deniedAccount = await rpc('catalog-reader', 'harness_options_get', { ...input, accountBinding })
    expect(deniedAccount.isError).toBe(true)
    const deniedHttp = await app.inject({ method: 'GET',
      url: `/api/management/harnesses/${harness}/options?${new URLSearchParams({
        hostRef: JSON.stringify(hostRef), accountBinding: JSON.stringify(accountBinding) })}`,
      headers: { authorization: 'Bearer catalog-reader' } })
    expect(deniedHttp.statusCode).toBe(403)
    expect(request).not.toHaveBeenCalled()
    const http = await app.inject({ method: 'GET',
      url: `/api/management/harnesses/${harness}/options?hostRef=${encodeURIComponent(JSON.stringify(hostRef))}`,
      headers: { authorization: 'Bearer catalog-reader' } })
    expect(http.statusCode).toBe(200)
    expect(http.json().models).toEqual(metadata(harness, 'worker-model').models)
    for (const name of ['harness_options_get', 'harness_options_refresh']) {
      const result = decodeMcpToolResult(await rpc('catalog-reader', name, input))
      expect(result).toMatchObject({ harness, models: [{ id: 'worker-model' }] })
    }
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operation: 'options', harness,
      target: { hostRef, applicationInstallationId: binding.workerInstallationId, keyRevision: 1,
        authorizationRevision: 1 } }), expect.objectContaining({ timeoutMs: 60_000 }))
    expect(discoverModels).not.toHaveBeenCalled()
    const changedHost = { ...hostRef, mainId: randomUUID() }
    expect((await rpc('catalog-reader', 'harness_options_get', { harness, hostRef: changedHost })).isError).toBe(true)
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    await app.close()
    await native.shutdownChecks()
  }
})
