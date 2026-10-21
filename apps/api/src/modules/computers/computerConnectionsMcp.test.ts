import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { ComputerMaintenance } from './maintenance.js'
import { computerConnectionsReader } from './connections.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import { appLauncherConnection, APP_MCP_SERVER_NAME } from '../harnesses/appMcpLauncher.js'
import { nativeConnection } from '../harnesses/nativeMcpCommon.js'

it('reads Main Claude MCP from its user configuration instead of the Codex-only settings service', async () => {
  const principal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }] } as ManagementPrincipal
  const mainId = randomUUID()
  const list = vi.fn(async (_caller: ManagementPrincipal, harness: 'codex' | 'claude') => {
    if (harness === 'claude') throw new Error('The Codex-only settings service cannot read Claude.')
    return { presets: { graphql: 'missing' as const, linear: 'missing' as const } }
  })
  const connections = computerConnectionsReader({ read: async () => accounts }, {
    list,
    readMainClaudeServers: async () => ({ [APP_MCP_SERVER_NAME]: nativeConnection(appLauncherConnection()) }),
  })
  expect(await connections(principal, { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null })).toEqual({ accounts, mcp: { codex: 'missing', claude: 'installed' } })
})

type Connections = { accounts: ComputerAccounts | null; mcp: { codex: string | null; claude: string | null } }
const accounts: ComputerAccounts = { observedAt: new Date().toISOString(), accounts: [
  { tool: 'codex', installed: true, signedIn: true, account: 'coder@example.com', details: [] },
  { tool: 'claude', installed: true, signedIn: false, account: null, details: [] },
  { tool: 'github', installed: false, signedIn: null, account: null, details: [] },
] }

it('reads sign-in and Foreman MCP state per computer through authenticated MCP, and hides MCP state without harnesses:read', async () => {
  const grant = (...actions: ManagementPrincipal['grants'][number]['actions']) =>
    ({ id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null, expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions, scope: {} }] }) as ManagementPrincipal
  const full = grant('settings:read', 'harnesses:read', 'capabilities:read')
  const limited = grant('settings:read', 'capabilities:read')
  const denied = grant('capabilities:read')
  const known = [full, limited, denied]
  const pool = new pg.Pool()
  const query = vi.fn(async (_query: unknown, values: unknown[]) => {
    const principal = known.find(value => value.id === values[0])
    return { rows: principal ? [{ id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }
  })
  vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as unknown as pg.PoolClient)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token =>
    token === 'full' ? full : token === 'limited' ? limited : denied)
  const list = vi.fn(async (_principal: ManagementPrincipal, harness: 'codex' | 'claude') =>
    ({ presets: { graphql: harness === 'codex' ? 'installed' as const : 'missing' as const, linear: 'missing' as const } }))
  const connections = computerConnectionsReader({ read: async () => accounts }, { list })
  const recordDenied = vi.fn()
  const commands = { recordDenied } as unknown as PostgresCommandCoordinator
  const computerMaintenance = new FleetMaintenanceService(pool, randomUUID(), () => undefined, commands,
    new ComputerMaintenance(fakeComputer().ports), { connections } as FleetSources)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance } as unknown as OperatorServices },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'computer-connections-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  const readMain = async (client: Client) => {
    const result = await client.callTool({ name: 'computers_maintenance_status', arguments: { refresh: true } })
    expect(result.isError).not.toBe(true)
    return (decodeMcpToolResult(result) as { computers: { connections?: Connections }[] }).computers[0]!.connections
  }
  try {
    expect(await readMain(await connect('full'))).toEqual({ accounts, mcp: { codex: 'installed', claude: 'missing' } })
    const listCallsForFull = list.mock.calls.length
    expect(listCallsForFull).toBeGreaterThan(0)
    expect(await readMain(await connect('limited'))).toEqual({ accounts, mcp: { codex: null, claude: null } })
    // A caller without harnesses:read never triggers an MCP read.
    expect(list).toHaveBeenCalledTimes(listCallsForFull)

    const rejection = await (await connect('denied')).callTool({ name: 'computers_maintenance_status', arguments: {} })
    expect(rejection.isError).toBe(true)
    expect(recordDenied).toHaveBeenCalledWith(denied.id, 'mcp', 'computers_maintenance_status', 'mcp:computers_maintenance_status')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
  }
})
