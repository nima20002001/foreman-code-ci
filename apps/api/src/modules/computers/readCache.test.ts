import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { MaintenanceStatus } from '@foreman-code/contracts/computer-maintenance'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ComputerAccountsService } from './accounts.js'
import { FleetMaintenanceService } from './fleet.js'
import type { ComputerMaintenance } from './maintenance.js'

function fixture(kind: 'accounts' | 'maintenance', running = false) {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = {
    id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z',
    revokedAt: null, grants: [{ actions: ['settings:read'], scope: {} }],
  }
  let revoked = false
  let now = 0
  const query = vi.fn(async (text: string) => {
    if (text.includes('from management_principals')) {
      return { rows: [{ ...principal, expires_at: new Date(principal.expiresAt),
        revoked_at: revoked ? new Date() : null, delegated_from: null }] }
    }
    return { rows: [] }
  })
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn() } as unknown as PostgresCommandCoordinator
  const accounts: ComputerAccounts = { observedAt: '2026-10-09T00:00:00Z', accounts: [] }
  const status: MaintenanceStatus = {
    observedAt: '2026-10-09T00:00:00Z', harnesses: [],
    system: { packageUpdates: 0, rebootRequired: false, sudo: false, disk: null },
    tasks: running ? [{ id: randomUUID(), kind: 'update-system', state: 'running',
      startedAt: '2026-10-09T00:00:00Z', finishedAt: null, summary: 'Running…', outputTail: '' }] : [],
  }
  const probeAccounts = vi.fn(async () => structuredClone(accounts))
  const probeStatus = vi.fn(async () => structuredClone(status))
  const service = kind === 'accounts'
    ? new ComputerAccountsService(pool, mainId, () => undefined, commands, probeAccounts, () => now)
    : new FleetMaintenanceService(pool, mainId, () => undefined, commands,
      { status: probeStatus } as unknown as ComputerMaintenance, {
        codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
        codexPlugins: async () => [], codexMarketplaces: async () => [],
        claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      }, () => now)
  return {
    read: (refresh = false) => service.list(principal, 'http', refresh),
    probes: () => probeAccounts.mock.calls.length + probeStatus.mock.calls.length,
    blockProbes() {
      probeAccounts.mockImplementation(() => new Promise(() => {}))
      probeStatus.mockImplementation(() => new Promise(() => {}))
    },
    delayProbes() {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      probeAccounts.mockImplementation(async () => { await gate; return accounts })
      probeStatus.mockImplementation(async () => { await gate; return status })
      return release
    },
    advance(ms: number) { now += ms },
    revoke() { revoked = true },
    accounts,
    status,
  }
}

describe.each(['accounts', 'maintenance'] as const)('%s warm reads', kind => {
  const ttl = kind === 'accounts' ? 30_000 : 20_000

  it('returns a warm result without waiting for another probe', async () => {
    const f = fixture(kind)
    const first = await f.read()
    f.blockProbes()
    f.advance(ttl - 1)
    expect(await f.read()).toEqual(first)
    expect(f.probes()).toBe(1)
  })

  it('probes again at expiry and on explicit refresh, returning current observations', async () => {
    const f = fixture(kind)
    const original = await f.read()
    f.advance(ttl)
    f.accounts.observedAt = '2026-10-09T00:01:00Z'
    f.status.observedAt = '2026-10-09T00:01:00Z'
    f.accounts.accounts = [{ tool: 'codex', installed: true, signedIn: true, account: 'fixture-account', details: [] }]
    f.status.system.packageUpdates = 7
    const expired = await f.read()
    expect(f.probes()).toBe(2)
    expect(expired.computers[0]).toMatchObject(kind === 'accounts'
      ? { accounts: structuredClone(f.accounts) }
      : { status: structuredClone(f.status) })
    expect(await f.read()).toEqual(expired)
    expect(f.probes()).toBe(2)
    expect(expired).not.toEqual(original)
    f.accounts.observedAt = '2026-10-09T00:02:00Z'
    f.status.observedAt = '2026-10-09T00:02:00Z'
    f.accounts.accounts[0]!.signedIn = false
    f.status.system.packageUpdates = 0
    const refreshed = await f.read(true)
    expect(f.probes()).toBe(3)
    expect(refreshed.computers[0]).toMatchObject(kind === 'accounts'
      ? { accounts: structuredClone(f.accounts) }
      : { status: structuredClone(f.status) })
    expect(await f.read()).toEqual(refreshed)
    expect(f.probes()).toBe(3)
    expect(refreshed).not.toEqual(expired)
  })

  it('revalidates revoked authority before returning a warm result', async () => {
    const f = fixture(kind)
    await f.read()
    f.revoke()
    await expect(f.read()).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(f.probes()).toBe(1)
  })

  it('shares a pending probe past the cache TTL and starts freshness when it settles', async () => {
    const f = fixture(kind)
    const release = f.delayProbes()
    const first = f.read()
    await expect.poll(f.probes).toBe(1)
    f.advance(ttl + 1)
    const second = f.read()
    const refreshed = f.read(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.probes()).toBe(1)
    release()
    expect(await second).toEqual(await first)
    expect(await refreshed).toEqual(await first)
    f.advance(ttl - 1)
    await f.read()
    expect(f.probes()).toBe(1)
    f.advance(1)
    await f.read()
    expect(f.probes()).toBe(2)
  })
})

it('refreshes running maintenance progress after three seconds', async () => {
  const f = fixture('maintenance', true)
  await f.read()
  f.advance(2_999)
  await f.read()
  expect(f.probes()).toBe(1)
  f.advance(1)
  await f.read()
  expect(f.probes()).toBe(2)
})

it('shares a pending automatic Worker observation and refreshes update progress after settlement', async () => {
  const f = fixture('maintenance')
  f.status.worker = {
    currentVersion: '0.0.56', targetVersion: '0.0.57', state: 'downloading', lastError: null,
  }
  const release = f.delayProbes()
  const first = f.read()
  await expect.poll(f.probes).toBe(1)
  f.advance(20_001)
  const refreshed = f.read(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.probes()).toBe(1)
  release()
  expect(await refreshed).toEqual(await first)
  f.advance(2_999)
  await f.read()
  expect(f.probes()).toBe(1)
  f.advance(1)
  await f.read()
  expect(f.probes()).toBe(2)
})
