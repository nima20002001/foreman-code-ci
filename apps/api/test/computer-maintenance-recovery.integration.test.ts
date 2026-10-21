import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartResultSchema,
  MaintenanceRequestSchema,
} from '@foreman-code/contracts/computer-maintenance'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { FleetMaintenanceService, type FleetSources } from '../src/modules/computers/fleet.js'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { fakeComputer, settle } from './helpers/fleetSync.js'

function controlledRestart(computer: ReturnType<typeof fakeComputer>) {
  const callbacks: (() => void)[] = []
  const run = computer.ports.run
  let reboots = 0
  computer.ports.later = callback => { callbacks.push(callback) }
  computer.ports.run = async (binary, args, options) => {
    if (binary === 'sudo') {
      if (args.includes('reboot')) reboots++
      return { code: 0, stdout: '', stderr: '' }
    }
    return run(binary, args, options)
  }
  return { callbacks, reboots: () => reboots }
}

describe.skipIf(!postgresEnabled)('maintenance command recovery through authenticated Operator MCP', () => {
  it('recovers host work after the Main result transaction fails and refuses a mismatched protocol', async () => {
    const database = await agent3Database()
    const clients: Client[] = []
    const apps: ReturnType<typeof buildApp>[] = []
    try {
      const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
      const access = new PostgresAccessService(database.pool)
      const writer = await access.issue({ name: 'Maintainer', audience: 'operator',
        expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
      const reader = await access.issue({ name: 'Reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
      const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
        authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
      await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
        values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
      const computer = fakeComputer()
      const main = fakeComputer()
      let catalog = 'original'
      let legacy = false
      let replyGate: Promise<void> | undefined
      const wireCommands: string[] = []
      const endpoint = {
        capabilities: () => [{ namespace: legacy ? 'computer-maintenance-v1' : COMPUTER_MAINTENANCE_NAMESPACE,
          mainCanRequest: true }],
        request: async (_deviceId: string, _namespace: string, payload: unknown) => {
          const request = MaintenanceRequestSchema.parse(payload)
          if (request.operation === 'status') {
            return { payload: { operation: 'status', status: await computer.maintenance.status(AbortSignal.timeout(1000)) } }
          }
          wireCommands.push(request.commandId)
          const task = await computer.maintenance.start(request.task, request.commandId)
          await replyGate
          return { payload: { operation: 'start', task } }
        },
      }
      const sources: FleetSources = {
        codexUserMcpServers: async () => ({ [catalog]: { url: `https://${catalog}.example/mcp` } }),
        claudeUserMcpServers: async () => ({}), codexPlugins: async () => [], codexMarketplaces: async () => [],
        claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      }
      const connect = async (commands: PostgresCommandCoordinator, token: string) => {
        const service = new FleetMaintenanceService(database.pool, mainId, () => endpoint, commands, main.maintenance, sources)
        const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
          operator: { access, services: { computerMaintenance: service, commands } as unknown as OperatorServices } })
        apps.push(app)
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const client = new Client({ name: 'maintenance-recovery-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }))
        return client
      }
      const commands = new PostgresCommandCoordinator(database.pool)
      const denied = await connect(commands, reader.token)
      const input = { commandId: randomUUID(), task: { kind: 'sync-mcp' }, targets: [{
        hostRef: { kind: 'device', mainId, deviceId: device.deviceId },
        applicationInstallationId: device.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      }] }
      expect((await denied.callTool({ name: 'computers_maintenance_start', arguments: input })).isError).toBe(true)
      expect(wireCommands).toEqual([])
      await database.pool.query(`alter table management_command_receipts add constraint maintenance_result_fault
        check (operation <> 'computers.maintenance.start') not valid`)
      const first = await connect(commands, writer.token)
      expect((await first.callTool({ name: 'computers_maintenance_start', arguments: input })).isError).toBe(true)
      await settle(computer)
      await database.pool.query('alter table management_command_receipts drop constraint maintenance_result_fault')
      const receipt = await database.pool.query(`select result from management_command_receipts
        where operation='computers.maintenance.start' and command_id=$1`, [input.commandId])
      expect(receipt.rows).toEqual([])
      computer.maintenance = new ComputerMaintenance(computer.ports)
      catalog = 'changed-after-crash'
      const recovered = await connect(commands, writer.token)
      const replay = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await recovered.callTool({
        name: 'computers_maintenance_start', arguments: input,
      }))))
      expect(replay.computers[0]?.task).toMatchObject({ id: input.commandId, state: 'succeeded' })
      expect(wireCommands).toEqual([input.commandId, input.commandId])
      expect([...computer.codexMcp]).toEqual(['original'])
      expect(computer.calls.filter(call => call.args[0] === 'mcp' && call.args[1] === 'add')).toHaveLength(1)
      const readback = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await recovered.callTool({
        name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
      }))))
      expect(readback.computers.find(value => value.target.applicationInstallationId === device.workerInstallationId)
        ?.status?.tasks.find(task => task.id === input.commandId)).toMatchObject({ state: 'succeeded' })
      const persisted = await database.pool.query<{ result: unknown }>(`select result from management_command_receipts
        where operation='computers.maintenance.start' and command_id=$1`, [input.commandId])
      expect(ComputerMaintenanceStartResultSchema.parse(persisted.rows[0]?.result)).toEqual(replay)
      legacy = true
      const incompatible = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await recovered.callTool({
        name: 'computers_maintenance_start', arguments: { ...input, commandId: randomUUID() },
      }))))
      expect(incompatible.computers[0]).toMatchObject({ task: null,
        error: expect.stringContaining('without maintenance support') })
      expect(wireCommands).toHaveLength(2)

      legacy = false
      const mainRestart = controlledRestart(main)
      const workerRestart = controlledRestart(computer)
      let releaseReply!: () => void
      replyGate = new Promise<void>(resolve => { releaseReply = resolve })
      const restart = { commandId: randomUUID(), task: { kind: 'restart' }, targets: [{
        hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        keyRevision: null, authorizationRevision: null,
      }, ...input.targets] }
      await database.pool.query(`alter table management_command_receipts add constraint maintenance_result_fault
        check (operation <> 'computers.maintenance.start') not valid`)
      const waiting = first.callTool({ name: 'computers_maintenance_start', arguments: restart })
      await expect.poll(() => mainRestart.callbacks.length).toBe(1)
      await expect.poll(() => workerRestart.callbacks.length).toBe(1)
      mainRestart.callbacks[0]!()
      await main.maintenance.drain()
      expect(mainRestart.reboots()).toBe(1)
      workerRestart.callbacks[0]!()
      await computer.maintenance.drain()
      releaseReply()
      replyGate = undefined
      expect((await waiting).isError).toBe(true)
      await database.pool.query('alter table management_command_receipts drop constraint maintenance_result_fault')
      main.maintenance = new ComputerMaintenance(main.ports)
      computer.maintenance = new ComputerMaintenance(computer.ports)
      const afterRestart = await connect(commands, writer.token)
      const restarted = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await afterRestart.callTool({
        name: 'computers_maintenance_start', arguments: restart,
      }))))
      expect(restarted.computers).toHaveLength(2)
      expect(restarted.computers.every(value => value.task?.state === 'succeeded')).toBe(true)
      expect(mainRestart.reboots()).toBe(1)
      expect(workerRestart.reboots()).toBe(1)
      expect(wireCommands.filter(commandId => commandId === restart.commandId)).toHaveLength(2)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await Promise.allSettled(apps.map(app => app.close()))
      await database.close()
    }
  }, 60_000)
})
