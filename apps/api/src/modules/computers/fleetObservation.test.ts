import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ComputerMaintenance } from './maintenance.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { buildApp } from '../../app.js'
import { FleetMaintenanceService } from './fleet.js'
import { fakeComputer, fakeFleet } from '../../../test/helpers/fleetSync.js'

it.each(['workerManifestSha256s', 'workerContentSha256s'] as const)(
  'rejects empty configured %s inventory instead of skipping convergence', async method => {
    const fixture = fakeFleet(fakeComputer())
    fixture.sources[method] = async () => []
    await expect(fixture.fleet.syncChangedSources()).rejects.toMatchObject({ code: 'WORKER_BUNDLE_UNPUBLISHED' })
    expect(fixture.requested).toEqual([])
    await fixture.fleet.drain()
  })

it.each(['workerManifestSha256s', 'workerContentSha256s'] as const)(
  'rejects failed configured %s inventory instead of claiming there are no updates', async method => {
    const fixture = fakeFleet(fakeComputer())
    fixture.sources[method] = async () => { throw new Error('Artifact inventory unavailable.') }
    await expect(fixture.fleet.syncChangedSources()).rejects.toThrow('Artifact inventory unavailable.')
    expect(fixture.requested).toEqual([])
    await fixture.fleet.drain()
  })

it('allows an unsupported optional inventory without inventing an inventory failure', async () => {
  const fixture = fakeFleet(fakeComputer())
  await expect(fixture.fleet.syncChangedSources()).resolves.toBeUndefined()
  await fixture.fleet.drain()
})

function fixture() {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const query = vi.fn(async (_text: string, values: unknown[]) => ({ rows: values?.[0] === principal.id
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }))
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn() } as unknown as PostgresCommandCoordinator
  const status = { observedAt: '2026-10-14T00:00:00Z', harnesses: [], tasks: [],
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } }
  const probe = vi.fn(async () => status)
  let now = Date.parse(status.observedAt)
  const fleet = new FleetMaintenanceService(pool, mainId, () => undefined, commands,
    { status: probe, drain: async () => {} } as unknown as ComputerMaintenance, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    }, () => now)
  return { fleet, principal, commands, status, probe, target: { hostRef: { kind: 'main', mainId },
    applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }, advance: () => { now += 1000 } }
}

it.each(['fleet', 'target'] as const)('reports failed %s observations beside the last good status, retries ordinary reads and clears the failure after success', async kind => {
  const f = fixture()
  const read = (refresh = false) => kind === 'fleet' ? f.fleet.list(f.principal, 'http', refresh)
    : f.fleet.readTarget(f.principal, 'http', { target: f.target, refresh })
  await read()
  f.advance()
  f.probe.mockRejectedValue(Object.assign(new Error('secret transport details'), { code: 'DEVICE_TRANSPORT_ERROR' }))
  const failed = await read(true)
  expect(failed.computers[0]).toMatchObject({ status: f.status, observation: {
    status: 'unavailable', lastError: expect.stringContaining('DEVICE_TRANSPORT_ERROR'),
    failedAt: '2026-10-14T00:00:01.000Z', lastSuccess: '2026-10-14T00:00:00.000Z', consecutiveFailures: 1,
  } })
  expect(JSON.stringify(failed)).not.toContain('secret transport details')
  const retried = await read()
  expect(retried.computers[0]).toMatchObject({ observation: { consecutiveFailures: 2 } })
  expect(f.probe).toHaveBeenCalledTimes(3)
  f.probe.mockResolvedValue(f.status)
  expect((await read()).computers[0]).toMatchObject({ status: f.status, observation: {
    status: 'available', lastError: null, failedAt: null, consecutiveFailures: 0,
  } })
  await f.fleet.drain()
})

it.each(['fleet', 'target'] as const)('returns %s maintenance failure observations through authenticated MCP and denies an unauthorized caller', async kind => {
  const f = fixture()
  f.probe.mockRejectedValue(Object.assign(new Error('private transport data'), { code: 'DEVICE_TRANSPORT_ERROR' }))
  const access = { authenticate: async (token: string) => token === 'reader'
    ? f.principal : { ...f.principal, id: 'denied', grants: [] } } as unknown as PostgresAccessService
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands: f.commands, computerMaintenance: f.fleet } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const argumentsForRead = kind === 'target' ? { target: f.target } : {}
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'maintenance-reader', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  try {
    const reader = await connect('reader')
    const result = await reader.callTool({ name: 'computers_maintenance_status', arguments: argumentsForRead })
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toMatchObject({ computers: [{ status: null,
      observation: { status: 'unavailable', consecutiveFailures: 1,
        lastError: expect.stringContaining('DEVICE_TRANSPORT_ERROR') } }] })
    const denied = await connect('denied')
    expect((await denied.callTool({ name: 'computers_maintenance_status', arguments: argumentsForRead })).isError).toBe(true)
    expect(f.probe).toHaveBeenCalledOnce()
    f.probe.mockResolvedValue(f.status)
    const recovered = await reader.callTool({ name: 'computers_maintenance_status', arguments: argumentsForRead })
    expect(decodeMcpToolResult(recovered)).toMatchObject({ computers: [{ status: f.status,
      observation: { status: 'available', lastError: null, consecutiveFailures: 0 } }] })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await f.fleet.drain()
  }
})
