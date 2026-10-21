import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import type { OperatorServices } from '../../mcp/operator/types.js'

it('reads persisted Worker publication errors through authenticated MCP and denies a caller without settings read', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-publication-'))
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const denied: ManagementPrincipal = { ...principal, id: randomUUID(), grants: [{ actions: ['capabilities:read'], scope: {} }] }
  const publication = { version: '1.1.0', state: 'failed', lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: asset missing' }
  const indexPath = join(directory, 'index.json')
  await writeFile(indexPath, JSON.stringify({ publication }))
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
  const local = { status: async () => ({ harnesses: [], tasks: [], observedAt: new Date().toISOString(),
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } }) } as unknown as ComputerMaintenance
  const sources = { workerPublication: async () => JSON.parse(await readFile(indexPath, 'utf8')).publication } as FleetSources
  const computerMaintenance = new FleetMaintenanceService(pool, mainId, () => undefined, commands, local, sources)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance } as unknown as OperatorServices },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'worker-publication-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  try {
    const reader = await connect('reader')
    const unauthorized = await connect('denied')
    const result = await reader.callTool({ name: 'computers_maintenance_status', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toMatchObject({ computers: [{ workerPublication: publication }] })
    const rejection = await unauthorized.callTool({ name: 'computers_maintenance_status', arguments: {} })
    expect(rejection.isError).toBe(true)
    expect(recordDenied).toHaveBeenCalledWith(denied.id, 'mcp', 'computers_maintenance_status',
      'mcp:computers_maintenance_status')
    const published = { ...publication, state: 'published', lastError: null }
    await writeFile(indexPath, JSON.stringify({ publication: published }))
    const readback = await reader.callTool({ name: 'computers_maintenance_status', arguments: {} })
    expect(decodeMcpToolResult(readback)).toMatchObject({ computers: [{ workerPublication: published }] })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
