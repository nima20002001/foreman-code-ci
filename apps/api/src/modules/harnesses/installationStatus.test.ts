import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { ProductionHarnessRegistry } from './productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from './instanceSettings/profileRepository.js'
import type { discoverLauncher } from './hostDiscovery.js'

const mainId = 'd46e2a2b-130f-46de-a93b-78a2352b9c9d'
const host = { kind: 'main', mainId } as const
const principal: ManagementPrincipal = {
  id: 'inventory-reader', name: 'Reader', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['harnesses:read'], scope: {} }],
}

function fixture() {
  let grants = principal.grants
  let payload = 'payload-A'
  let installed = true
  let inspection: Promise<void> | undefined
  let failure: Error | undefined
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('management_principals')) {
        return { rows: [{ id: principal.id, name: principal.name, audience: principal.audience, grants,
          expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
      }
      if (sql.includes('application_installation')) return { rows: [{ id: mainId }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = { connect: async () => client } as unknown as pg.Pool
  const launcher = vi.fn<typeof discoverLauncher>(async (requested, environment) => {
    await inspection
    if (failure) throw failure
    return { requested, resolvedLauncher: installed ? `/recorded/${requested}` : null,
      fingerprint: installed ? payload : null, status: installed ? 'installed' : 'missing',
      interpreter: null, diagnostics: [], environment, checkedAt: new Date().toISOString() }
  })
  const claude = vi.fn<NonNullable<NonNullable<ConstructorParameters<typeof ProductionHarnessRegistry>[6]>['claude']>>(
    async (_host, environment) => installed ? {
      sdkVersion: '0.3.284', sdkIntegrity: 'recorded-integrity',
      launcher: { requested: '/recorded/claude', resolvedLauncher: '/recorded/claude', fingerprint: payload,
        status: 'installed', interpreter: null, diagnostics: [], environment, checkedAt: new Date().toISOString() },
      declaration: { harnessInstallationId: 'claude-installation', requestedLauncher: '/recorded/claude',
        payloadPaths: ['/recorded/sdk.mjs'], driverId: 'claude', driverRevision: '1', protocolRevision: 'claude-sdk' },
    } : null,
  )
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }),
    new HostHarnessProfileEvidenceRepository(pool), () => null, { PATH: '/recorded' },
    { launcher, payloads: async () => ({ complete: true, paths: [] }), claude })
  return { registry, launcher, claude,
    update: (value: string) => { payload = value },
    remove: () => { installed = false },
    delay: (value: Promise<void>) => { inspection = value },
    fail: (error: Error) => { failure = error },
    revoke: () => { grants = [] },
  }
}

it('reads installed inventory independently of absent presets, authentication and qualification without inspecting again', async () => {
  const f = fixture()
  try {
    await f.registry.initialize(mainId)
    const first = await f.registry.get(principal, host)
    expect(first.instances.map(value => value.driverId)).toEqual(['codex'])
    expect(first.installations).toEqual(expect.arrayContaining(['codex', 'claude'].map(driverId =>
      expect.objectContaining({ driverId, installed: true, authenticated: null, compatible: null, qualified: null }))))
    expect(await f.registry.get(principal, host)).toEqual(first)
    expect(f.launcher).toHaveBeenCalledTimes(2)
    expect(f.claude).toHaveBeenCalledOnce()
    f.revoke()
    await expect(f.registry.get(principal, host)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.launcher).toHaveBeenCalledTimes(2)
    expect(f.claude).toHaveBeenCalledOnce()
  } finally { f.registry.stop() }
})

it('keeps cached installation facts readable during a slow version refresh and publishes updates and removal', async () => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  try {
    await f.registry.initialize(mainId)
    const before = await f.registry.get(principal, host)
    f.update('payload-B')
    f.delay(gate)
    const refresh = f.registry.refreshMain()
    await vi.waitFor(() => expect(f.launcher).toHaveBeenCalledTimes(3))
    expect(await f.registry.get(principal, host)).toEqual(before)
    finish()
    await refresh
    const updated = await f.registry.get(principal, host)
    expect(updated.installations.map(value => value.installationFingerprint)).toEqual(['payload-B', 'payload-B'])
    expect(updated.installations.every(value => value.installed)).toBe(true)
    f.remove()
    await f.registry.refreshMain()
    const removed = await f.registry.get(principal, host)
    expect(removed.installations.every(value => !value.installed)).toBe(true)
  } finally { finish(); f.registry.stop() }
})

it('retains installed inventory after an inspection timeout instead of publishing missing installations', async () => {
  const f = fixture()
  try {
    await f.registry.initialize(mainId)
    const before = await f.registry.get(principal, host)
    f.fail(new DOMException('Inspection timed out.', 'TimeoutError'))
    await expect(f.registry.refreshMain()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await f.registry.get(principal, host)).toEqual(before)
    expect(f.launcher).toHaveBeenCalledTimes(3)
    expect(f.claude).toHaveBeenCalledOnce()
  } finally { f.registry.stop() }
})
