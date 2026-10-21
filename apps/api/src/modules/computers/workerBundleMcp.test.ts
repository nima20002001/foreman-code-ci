import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { workerBundleFixture } from '../../../test/support/workerBundle.js'

it('reads bundle skew and persisted publication errors through authenticated MCP and denies an unauthorized reader', async () => {
  const f = await workerBundleFixture()
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const registration = { mainId: f.identity.mainId, deviceId: f.identity.deviceId,
    workerInstallationId: f.identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  const query = vi.fn(async (_query: unknown, values: unknown[]) => ({ rows: values[0] === principal.id
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
    : [{ record: registration }] }))
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn() } as unknown as PostgresCommandCoordinator
  const fleet = new FleetMaintenanceService(pool, f.identity.mainId, () => f.endpoint, commands,
    { drain: async () => {} } as ComputerMaintenance, {} as FleetSources)
  const access = { authenticate: async (token: string) => token === 'reader' ? principal
    : { ...principal, id: randomUUID(), grants: [] } } as unknown as PostgresAccessService
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance: fleet } as unknown as OperatorServices },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'bundle-reader', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  const target = { hostRef: { kind: 'device', mainId: f.identity.mainId, deviceId: f.identity.deviceId },
    applicationInstallationId: f.identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  try {
    const reader = await connect('reader')
    const denied = await connect('denied')
    const read = () => reader.callTool({ name: 'computers_maintenance_status', arguments: { target, refresh: true } })
    const result = await read()
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toMatchObject({ computers: [{ workerReadiness: {
      ready: false, code: 'WORKER_VERSION_SKEW', expected: f.expected,
      running: { manifestSha256: f.status.worker.manifestSha256 }, updatePhase: 'current',
    } }] })
    expect((await denied.callTool({ name: 'computers_maintenance_status', arguments: { target } })).isError).toBe(true)
    f.index.publication = { state: 'failed', lastError: 'Release asset missing' }
    await f.publish()
    expect(decodeMcpToolResult(await read())).toMatchObject({ computers: [{ workerReadiness: {
      ready: false, code: 'WORKER_BUNDLE_UNPUBLISHED', publicationError: 'Release asset missing',
    } }] })
    f.index.publication = { state: 'published', lastError: null }
    await f.publish()
    f.match()
    expect(decodeMcpToolResult(await read())).toMatchObject({ computers: [{ workerReadiness: {
      ready: true, code: null, expected: f.expected, updatePhase: 'current',
    } }] })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await fleet.drain()
    await f.close()
  }
})
