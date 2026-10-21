import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { registerService, trackService } from '../diagnostics/serviceHealth.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import { readWorkerReleasePublication } from './workerArtifacts.js'

it('reads stalled background loops and an overdue Worker publication through authenticated MCP', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'service-health-'))
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const denied: ManagementPrincipal = { ...principal, id: randomUUID(), grants: [{ actions: ['capabilities:read'], scope: {} }] }
  // The publication unit died three hours ago without recording a result.
  const startedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
  const deadlineAt = new Date(Date.now() - 60 * 60_000).toISOString()
  await writeFile(join(directory, 'index.json'), JSON.stringify({ format: 1, version: '1.1.0', artifacts: [],
    publication: { state: 'pending', lastError: null, startedAt, deadlineAt } }))
  registerService('test-missed-loop', { cadenceMs: 1000, deadlineMs: 5000 }, Date.now() - 10 * 60_000)
  await trackService('test-healthy-loop', { cadenceMs: 60_000, deadlineMs: 5000 }, async () => undefined)
  const pool = new pg.Pool()
  const query = vi.fn(async (_query: unknown, values: unknown[]) => ({ rows: values[0] === principal.id ? [{
    id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
  }] : [] }))
  vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as unknown as pg.PoolClient)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'reader' ? principal : denied)
  const recordDenied = vi.fn()
  const commands = { recordDenied } as unknown as PostgresCommandCoordinator
  const computerMaintenance = new FleetMaintenanceService(pool, randomUUID(), () => undefined, commands,
    new ComputerMaintenance(fakeComputer().ports),
    { workerPublication: () => readWorkerReleasePublication({ directory, version: '1.1.0' }) } as FleetSources)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance } as unknown as OperatorServices },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'service-health-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  try {
    const reader = await connect('reader')
    const result = await reader.callTool({ name: 'computers_maintenance_status', arguments: { refresh: true } })
    expect(result.isError).not.toBe(true)
    const [main] = (decodeMcpToolResult(result) as { computers: { status: { services: unknown[] };
      workerPublication: { state: string; lastError: string } }[] }).computers
    expect(main!.status.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'test-missed-loop', status: 'stalled', lastStartedAt: null }),
      expect.objectContaining({ name: 'test-healthy-loop', status: 'ok', lastError: null }),
    ]))
    expect(main!.workerPublication).toMatchObject({ state: 'failed', startedAt, deadlineAt })
    expect(main!.workerPublication.lastError).toMatch(/^WORKER_PUBLICATION_DEADLINE_EXCEEDED: phase publishing, age 180 min, over the 120 min limit/u)

    const unauthorized = await connect('denied')
    const rejection = await unauthorized.callTool({ name: 'computers_maintenance_status', arguments: {} })
    expect(rejection.isError).toBe(true)
    expect(recordDenied).toHaveBeenCalledWith(denied.id, 'mcp', 'computers_maintenance_status',
      'mcp:computers_maintenance_status')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
