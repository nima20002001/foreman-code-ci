import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ComputerMaintenanceListSchema } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE, type ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { computerConnectionsReader } from '../src/modules/computers/connections.js'
import { FleetMaintenanceService, type FleetSources } from '../src/modules/computers/fleet.js'
import { fakeComputer } from './helpers/fleetSync.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('reads persisted computer targets and their connections through MCP with the caller’s read authority', async () => {
  const database = await agent3Database()
  const clients: Client[] = []
  const apps: ReturnType<typeof buildApp>[] = []
  try {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const access = new PostgresAccessService(database.pool)
    const issue = (name: string, actions: ManagementAction[]) => access.issue({ name, audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions, scope: {} }] })
    const reader = await issue('Connections reader', ['settings:read', 'harnesses:read'])
    const limited = await issue('Settings reader', ['settings:read'])
    const denied = await issue('Unrelated reader', ['capabilities:read'])
    const accounts = (signedIn: boolean): ComputerAccounts => ({ observedAt: '2026-10-17T12:00:00.000Z',
      accounts: [{ tool: 'claude', installed: true, signedIn, account: signedIn ? 'reader@example.com' : null, details: [] }] })
    const mainAccounts = accounts(true)
    const deviceAccounts = accounts(false)
    const commands = new PostgresCommandCoordinator(database.pool)
    const computerAccounts = new ComputerAccountsService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_ACCOUNTS_NAMESPACE, mainCanRequest: true }],
      request: async () => ({ payload: deviceAccounts }),
    }), commands, async () => mainAccounts)
    const mcpReads: string[] = []
    const connections = computerConnectionsReader(computerAccounts, {
      list: async (_principal, harness, hostRef) => {
        mcpReads.push(`${hostRef.kind}:${harness}`)
        return { presets: { graphql: hostRef.kind === 'main' ? 'installed' : 'missing', linear: 'missing' } }
      },
    })
    const createApp = async () => {
      const computerMaintenance = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands,
        fakeComputer().maintenance, { connections } as FleetSources)
      const app = buildApp({ logger: false, operator: {
        access, services: { commands, computerMaintenance } as unknown as OperatorServices,
      }, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
      apps.push(app)
      return app.listen({ host: '127.0.0.1', port: 0 })
    }
    const connect = async (address: string, token: string) => {
      const client = new Client({ name: 'connections-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const address = await createApp()
    const read = async (client: Client) => {
      const response = await client.callTool({ name: 'computers_maintenance_status', arguments: {} })
      expect(response.isError).not.toBe(true)
      return ComputerMaintenanceListSchema.parse(decodeMcpToolResult(response)).computers
    }
    const computers = await read(await connect(address, reader.token))
    expect(computers.map(computer => computer.connections)).toEqual([
      { accounts: mainAccounts, mcp: { codex: 'installed', claude: 'installed' } },
      { accounts: deviceAccounts, mcp: { codex: 'missing', claude: 'missing' } },
    ])
    const savedTarget = computers[1]!.target
    expect(savedTarget.applicationInstallationId).toBe(device.workerInstallationId)
    const limitedRead = await read(await connect(address, limited.token))
    expect(limitedRead.map(computer => computer.connections?.mcp)).toEqual([
      { codex: null, claude: null }, { codex: null, claude: null },
    ])
    expect(mcpReads).toHaveLength(4)
    const rejection = await (await connect(address, denied.token)).callTool({
      name: 'computers_maintenance_status', arguments: {},
    })
    expect(rejection.isError).toBe(true)
    expect(JSON.stringify(rejection.content)).toContain('ACCESS_DENIED')
    const restarted = await connect(await createApp(), reader.token)
    const readback = await restarted.callTool({ name: 'computers_maintenance_status', arguments: { target: savedTarget } })
    expect(readback.isError).not.toBe(true)
    expect(ComputerMaintenanceListSchema.parse(decodeMcpToolResult(readback)).computers).toEqual([
      expect.objectContaining({ target: savedTarget, connections: computers[1]!.connections }),
    ])
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await Promise.all(apps.map(app => app.close()))
    await database.close()
  }
})
