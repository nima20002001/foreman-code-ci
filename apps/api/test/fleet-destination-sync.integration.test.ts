import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ComputerMaintenanceListSchema, ComputerMaintenanceStartResultSchema } from '@foreman-code/contracts/computer-maintenance'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { fakeFleet, settle } from './helpers/fleetSync.js'
import { fleetPluginId, versionedComputer } from './helpers/fleetPluginVersions.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('destination sync through authenticated Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => { await database?.close() })

  it.each(['sync-mcp', 'sync-plugins'] as const)('persists %s destination failures and repairs while denying a reader', async kind => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Sync writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Sync reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const main = versionedComputer()
    main.codexPlugins.add(fleetPluginId)
    main.claudePlugins.set(fleetPluginId, true)
    main.versions.codex.set(fleetPluginId, '1.0.0')
    main.versions.claude.set(fleetPluginId, '1.0.0')
    const worker = versionedComputer()
    const fixture = fakeFleet(worker)
    const device = { ...fixture.registrations[0]!, mainId }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    Object.assign(fixture.sources, main.sources)
    fixture.sources.codexUserMcpServers = async () => ({
      local: { command: 'node', args: ['/opt/fixture-tools/server.mjs'] },
      docs: { url: 'https://docs.example/mcp' },
    })
    const commands = new PostgresCommandCoordinator(database.pool)
    const fleet = new FleetMaintenanceService(database.pool, mainId, () => fixture.endpoint, commands,
      main.maintenance, fixture.sources)
    const app = buildApp({ operator: { access, services: { computerMaintenance: fleet, commands } as unknown as OperatorServices },
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'destination-sync-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }))
        return client
      }
      const operator = await connect(writer.token)
      const readOnly = await connect(reader.token)
      const targets = [{ hostRef: { kind: 'device', mainId, deviceId: device.deviceId },
        applicationInstallationId: device.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }]
      const request = () => ({ commandId: randomUUID(), task: { kind }, targets })
      expect((await readOnly.callTool({ name: 'computers_maintenance_start', arguments: request() })).isError).toBe(true)
      expect(fixture.requested).toEqual([])
      const start = async () => {
        const result = await operator.callTool({ name: 'computers_maintenance_start', arguments: request() })
        expect(result.isError).not.toBe(true)
        return ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult(result)).computers[0]!.task!
      }
      const read = async (id: string) => {
        await settle(worker)
        worker.maintenance = new ComputerMaintenance(worker.ports)
        const result = await readOnly.callTool({ name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true } })
        return ComputerMaintenanceListSchema.parse(decodeMcpToolResult(result)).computers
          .find(computer => computer.target.applicationInstallationId === device.workerInstallationId)?.status?.tasks.find(task => task.id === id)
      }
      const first = await start()
      expect(await read(first.id)).toMatchObject({ state: kind === 'sync-mcp' ? 'failed' : 'succeeded' })
      if (kind === 'sync-mcp') {
        expect([...worker.codexMcp]).toEqual(['docs'])
        worker.ports.exists = async path => path === '/opt/fixture-tools/server.mjs'
        const find = worker.ports.find
        worker.ports.find = async name => name === 'node' ? '/fake/node' : find(name)
      } else {
        main.versions.codex.set(fleetPluginId, '2.0.0')
        main.versions.claude.set(fleetPluginId, '2.0.0')
        worker.publish('2.0.0')
      }
      const repaired = await start()
      expect(await read(repaired.id)).toMatchObject({ state: 'succeeded' })
      if (kind === 'sync-mcp') expect([...worker.codexMcp].sort()).toEqual(['docs', 'local'])
      else {
        expect(repaired.sourceFingerprint).not.toBe(first.sourceFingerprint)
        expect(worker.versions.codex.get(fleetPluginId)).toBe('2.0.0')
        expect(worker.versions.claude.get(fleetPluginId)).toBe('2.0.0')
        main.versions.codex.set(fleetPluginId, '3.0.0')
        main.versions.claude.set(fleetPluginId, '3.0.0')
        worker.publish('4.0.0')
        const unavailable = await start()
        expect(await read(unavailable.id)).toMatchObject({ state: 'failed' })
        expect(worker.versions.codex.get(fleetPluginId)).toBe('2.0.0')
        expect(worker.versions.claude.get(fleetPluginId)).toBe('2.0.0')
        worker.publish('3.0.0')
        worker.failAcquisition()
        const downloadFailed = await start()
        expect(await read(downloadFailed.id)).toMatchObject({ state: 'failed' })
        expect(worker.versions.codex.get(fleetPluginId)).toBe('2.0.0')
        expect(worker.versions.claude.get(fleetPluginId)).toBe('2.0.0')
      }
    } finally {
      await Promise.all(clients.map(client => client.close()))
      fleet.stopAdmission()
      await fleet.drain()
      await app.close()
      await database.pool.query('delete from device_registrations where id=$1', [device.deviceId])
    }
  })
})
