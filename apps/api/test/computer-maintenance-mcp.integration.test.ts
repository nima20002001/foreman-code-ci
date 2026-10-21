import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartResultSchema, MaintenanceRequestSchema,
  type MaintenanceStatus, type MaintenanceTaskStart,
} from '@foreman-code/contracts/computer-maintenance'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { ComputerMaintenance, systemMaintenancePorts, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { MainCodexSelection } from '../src/modules/computers/installedCodexSelection.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { fakeComputer, settle } from './helpers/fleetSync.js'

// Queued maintenance tasks settle in the background; the 1 s expect.poll default is too short on a loaded machine.
const POLL = { timeout: 10_000 }

const status = (codex: string): MaintenanceStatus => ({ observedAt: new Date().toISOString(), tasks: [],
  harnesses: [{ harness: 'codex', installed: true, version: codex, latest: '0.161.0' }, { harness: 'claude', installed: false, version: null, latest: '2.1.294' }],
  system: { packageUpdates: 3, rebootRequired: false, sudo: true, disk: { path: '/home/owner', freeBytes: 10, totalBytes: 20 } } })
const task = (start: MaintenanceTaskStart) => ({ id: randomUUID(), kind: start.kind, state: 'running' as const,
  startedAt: new Date().toISOString(), finishedAt: null, summary: 'Running…', outputTail: '' })

describe.skipIf(!postgresEnabled)('computer maintenance through Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  const homes: string[] = []
  beforeAll(async () => { database = await agent3Database() }, 60000)
  beforeEach(async () => {
    await database.pool.query('delete from device_registrations')
  })
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
    await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
  })

  it('closes maintenance admission, drains the accepted command, and reads it back through authenticated MCP', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Shutdown maintainer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Shutdown reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const computer = fakeComputer()
    const nativeRun = computer.ports.run
    let updating = false
    let releaseUpdate!: () => void
    const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve })
    computer.ports.run = async (binary, args, options) => {
      if (args[0] === 'update') {
        updating = true
        await updateGate
      }
      return nativeRun(binary, args, options)
    }
    const commands = new PostgresCommandCoordinator(database.pool)
    const sources = {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    }
    const fleet = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands, computer.maintenance, sources)
    const services = { computerMaintenance: fleet, commands } as unknown as OperatorServices
    const app = buildApp({ operator: { access, services },
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'maintenance-shutdown-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const operator = await connect(writer.token)
    const readOnly = await connect(reader.token)
    const commandId = randomUUID()
    const request = { commandId, task: { kind: 'update-harnesses', harnesses: ['claude'] } }
    try {
      const accepted = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult(await operator.callTool({
        name: 'computers_maintenance_start', arguments: request,
      })))
      expect(accepted.computers[0]?.task?.id).toBe(commandId)
      await expect.poll(() => updating, POLL).toBe(true)
      fleet.stopAdmission()
      let drained = false
      const draining = fleet.drain().then(() => { drained = true })
      const denied = await readOnly.callTool({ name: 'computers_maintenance_start', arguments: {
        commandId: randomUUID(), task: { kind: 'update-system' },
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const refused = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult(await operator.callTool({
        name: 'computers_maintenance_start', arguments: { ...request, commandId: randomUUID() },
      })))
      expect(refused.computers[0]).toMatchObject({ task: null, error: 'Computer maintenance is shutting down.' })
      expect(drained).toBe(false)
      releaseUpdate()
      await draining
      const restartedFleet = new FleetMaintenanceService(database.pool, mainId, () => undefined,
        commands, new ComputerMaintenance(computer.ports), sources)
      const restartedApp = buildApp({ operator: { access, services: {
        computerMaintenance: restartedFleet, commands,
      } as unknown as OperatorServices },
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
      apps.push(restartedApp)
      const restartedAddress = await restartedApp.listen({ host: '127.0.0.1', port: 0 })
      const recoveredReader = new Client({ name: 'maintenance-readback-test', version: '1' })
      clients.push(recoveredReader)
      await recoveredReader.connect(new StreamableHTTPClientTransport(new URL('/mcp', restartedAddress), {
        requestInit: { headers: { authorization: `Bearer ${reader.token}` } },
      }))
      const persisted = ComputerMaintenanceListSchema.parse(decodeMcpToolResult(await recoveredReader.callTool({
        name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
      })))
      expect(persisted.computers[0]?.status?.tasks).toEqual([
        expect.objectContaining({ id: commandId, state: 'succeeded' }),
      ])
      expect(persisted.computers[0]?.status?.harnesses).toContainEqual(
        expect.objectContaining({ harness: 'claude', version: '1.2.4', latest: '1.2.4' }),
      )
      expect(computer.calls.filter(call => call.args[0] === 'update')).toHaveLength(1)
    } finally {
      releaseUpdate()
      fleet.stopAdmission()
      await fleet.drain()
    }
  })

  it('reads fleet status, starts updates and syncs Main\'s MCP servers and plugins, and denies a read-only caller', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Maintainer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const deviceStarts: MaintenanceTaskStart[] = []
    const mainStarts: MaintenanceTaskStart[] = []
    const local = { status: async () => status('0.161.0'), start: (start: MaintenanceTaskStart) => { mainStarts.push(start); return task(start) } } as unknown as ComputerMaintenance
    const commands = new PostgresCommandCoordinator(database.pool)
    const computerMaintenance = new FleetMaintenanceService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
      request: async (_deviceId, _namespace, payload) => {
        const request = MaintenanceRequestSchema.parse(payload)
        if (request.operation === 'status') return { payload: { operation: 'status', status: status('0.150.0') } }
        deviceStarts.push(request.task)
        return { payload: { operation: 'start', task: task(request.task) } }
      },
    }), commands, local, {
      codexUserMcpServers: async () => ({ linear: { url: 'https://mcp.linear.app/mcp' }, private: { command: 'x', env: { TOKEN: 'secret' } }, 'foreman-code': { command: 'app' } }),
      claudeUserMcpServers: async () => ({ docs: { type: 'http', url: 'https://docs.example/mcp' } }),
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      codexPlugins: async () => [{ pluginId: 'pdf@openai', version: null }],
      codexMarketplaces: async () => [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }],
    })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'maintenance-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const operator = await connect(writer.token)
    const listed = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true } }))))
    expect(listed.computers.map(computer => computer.status?.harnesses[0]?.version)).toEqual(['0.161.0', '0.150.0'])
    const http = await app.inject({ url: '/api/management/computers/maintenance', headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(ComputerMaintenanceListSchema.parse(http.json()).computers).toHaveLength(2)

    const update = { commandId: randomUUID(), task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } }
    const started = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'computers_maintenance_start', arguments: update }))))
    expect(started.computers.map(computer => computer.task?.kind)).toEqual(['update-harnesses', 'update-harnesses'])
    // The same command never starts the work twice.
    await operator.callTool({ name: 'computers_maintenance_start', arguments: update })
    expect(mainStarts).toHaveLength(1)
    expect(deviceStarts).toHaveLength(1)

    const sync = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'computers_maintenance_start',
      arguments: { commandId: randomUUID(), task: { kind: 'sync-mcp' } } }))))
    expect(sync.computers.map(computer => computer.target.hostRef.kind)).toEqual(['device'])
    expect(deviceStarts.at(-1)).toEqual({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: null }],
      claude: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }] },
      skippedServers: { codex: ['private'] },
      warnings: ['codex MCP server private contains credentials; configure it separately on each computer; skipped.'] })
    await operator.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'sync-plugins' } } })
    expect(deviceStarts.at(-1)).toEqual({ kind: 'sync-plugins', plugins: ['pdf@openai'],
      marketplaces: [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }], claudePlugins: [], claudeMarketplaces: [] })

    const restartAll = await operator.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'restart' } } })
    expect(restartAll.isError).toBe(true)
    expect(JSON.stringify(restartAll.content)).toContain('COMPUTER_RESTART_TARGET_REQUIRED')

    const readOnly = await connect(reader.token)
    expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('computers_maintenance_start')
    const deniedStart = await readOnly.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'update-system' } } })
    expect(deniedStart.isError).toBe(true)
    expect(JSON.stringify(deniedStart.content)).toContain('ACCESS_DENIED')
    expect(deviceStarts.some(start => start.kind === 'update-system')).toBe(false)
    const audits = await database.pool.query<{ source: string }>("select source from management_audit where action='computers.maintenance.start' and outcome='succeeded'")
    expect(audits.rows.length).toBeGreaterThanOrEqual(3)
    expect(new Set(audits.rows.map(row => row.source))).toEqual(new Set(['mcp']))
  })
  it('syncs safely through authenticated MCP, preserves local entries, and reads persisted partial ownership', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Sync maintainer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Sync reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'b'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const localDefinition = { type: 'http', url: 'https://receiver.example/mcp' }
    computer.codexMcp.add('local')
    computer.claudeMcp.set('local', localDefinition)
    computer.codexPlugins.add('local@official')
    computer.claudePlugins.set('local@official', false)
    computer.fail((_binary, args) => ['add', 'add-json', 'install'].includes(args[1]!)
      && (args.includes('bad') || args.includes('bad@official')))
    let names = ['local', 'good', 'bad']
    let unreadable = false
    let skippedDefinition: Record<string, unknown> | undefined
    const sourceServers = async () => {
      return { ...Object.fromEntries(names.map(name => [name, { url: `https://${name}.example/mcp` }])),
        ...(skippedDefinition ? { good: skippedDefinition } : {}),
        query: { url: 'https://service.example/mcp?api_key=fixture-secret' },
        argument: { command: '/usr/bin/server', args: ['--api-key', 'fixture-secret'] } }
    }
    const commands = new PostgresCommandCoordinator(database.pool)
    const starts: MaintenanceTaskStart[] = []
    const createService = () => new FleetMaintenanceService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
      request: async (_deviceId, _namespace, payload) => {
        const request = MaintenanceRequestSchema.parse(payload)
        if (request.operation === 'status') {
          return { payload: { operation: 'status', status: await computer.maintenance.status(AbortSignal.timeout(1000)) } }
        }
        starts.push(request.task)
        return { payload: { operation: 'start', task: await computer.maintenance.start(request.task, request.commandId) } }
      },
    }), commands, new ComputerMaintenance(computer.ports), {
      codexUserMcpServers: async () => {
        if (unreadable) throw new Error('Native source unavailable')
        return sourceServers()
      },
      claudeUserMcpServers: sourceServers,
      codexPlugins: async () => names.map(name => ({ pluginId: `${name}@official`, version: null })),
      codexMarketplaces: async () => [{ source: 'owner/official', name: 'official' }],
      claudePlugins: async () => ({ marketplaces: [], plugins: names.map(name => ({
        pluginId: `${name}@official`, name, marketplaceName: 'official', description: null, version: null,
        installed: true, enabled: true, installCount: null,
      })) }),
    }, () => now)
    const service = createService()
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance: service, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'fleet-sync-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const operator = await connect(writer.token)
    const readOnly = await connect(reader.token)
    expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('computers_maintenance_start')
    const targets = [{ hostRef: { kind: 'device', mainId, deviceId: device.deviceId },
      applicationInstallationId: device.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }]
    expect((await readOnly.callTool({ name: 'computers_maintenance_start', arguments: {
      commandId: randomUUID(), task: { kind: 'sync-mcp' }, targets,
    } })).isError).toBe(true)
    expect(starts).toHaveLength(0)
    const sync = async (kind: 'sync-mcp' | 'sync-plugins') => {
      const arguments_ = { commandId: randomUUID(), task: { kind }, targets }
      const result = ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await operator.callTool({
        name: 'computers_maintenance_start', arguments: arguments_,
      }))))
      const count = starts.length
      await operator.callTool({ name: 'computers_maintenance_start', arguments: arguments_ })
      expect(starts).toHaveLength(count)
      expect(result.computers[0]?.task?.sourceFingerprint).toMatch(/^sha256:/u)
      await settle(computer)
      const readback = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await operator.callTool({
        name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
      }))))
      return readback.computers.find(item => item.target.applicationInstallationId === device.workerInstallationId)
        ?.status?.tasks.find(task => task.id === result.computers[0]?.task?.id)
    }
    expect(await sync('sync-mcp')).toMatchObject({ state: 'failed', summary: expect.stringContaining('query') })
    expect(await sync('sync-plugins')).toMatchObject({ state: 'failed' })
    const failedStarts = starts.length
    await service.syncChangedSources()
    await createService().syncChangedSources()
    expect(starts).toHaveLength(failedStarts)
    now += 5 * 60_000
    await createService().syncChangedSources()
    await settle(computer)
    expect(starts).toHaveLength(failedStarts + 2)
    expect(await sync('sync-mcp')).toMatchObject({ state: 'failed' })
    expect(starts).toHaveLength(failedStarts + 3)
    expect(JSON.stringify(starts)).not.toContain('fixture-secret')
    expect(JSON.stringify(computer.calls)).not.toContain('fixture-secret')
    expect(computer.claudePlugins.get('local@official')).toBe(false)
    names = ['local', 'good']
    computer.fail(() => false)
    for (const definition of [
      { url: 'https://good.example/mcp', env: { TOKEN: 'fixture-secret' } },
      { type: 'http', url: 'https://good.example/mcp', headers: { Authorization: 'Bearer fixture-secret' } },
      { url: 'https://good.example/mcp', enabled: false },
      { url: 'https://good.example/mcp', enabled_tools: ['read'] },
      { url: 'https://good.example/mcp', disabled_tools: ['write'] },
      { command: 'server', env_vars: ['REMOTE_TOKEN'] },
    ]) {
      skippedDefinition = definition
      expect(await sync('sync-mcp')).toMatchObject({ state: 'succeeded', summary: expect.stringContaining('good') })
      expect(computer.codexMcp.has('good')).toBe(true)
      expect(computer.claudeMcp.has('good')).toBe(true)
      expect(starts.at(-1)).toMatchObject({ skippedServers: {
        codex: expect.arrayContaining(['good']), claude: expect.arrayContaining(['good']),
      } })
      computer.maintenance = new ComputerMaintenance(computer.ports)
      const persisted = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await operator.callTool({
        name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
      })))).computers.find(item => item.target.applicationInstallationId === device.workerInstallationId)
      expect(persisted?.status?.tasks.find(task => task.kind === 'sync-mcp'))
        .toMatchObject({ state: 'succeeded', summary: expect.stringContaining('good') })
    }
    expect(computer.calls.filter(call => call.args[1] === 'remove' && call.args.includes('good'))).toEqual([])
    expect(JSON.stringify(starts)).not.toContain('fixture-secret')
    expect(JSON.stringify(computer.calls)).not.toContain('fixture-secret')
    skippedDefinition = undefined
    names = []
    computer.fail(() => false)
    unreadable = true
    expect(await sync('sync-mcp')).toMatchObject({ state: 'succeeded',
      summary: expect.stringContaining('could not be read') })
    expect(computer.codexMcp.has('good')).toBe(true)
    expect(computer.claudeMcp.has('good')).toBe(false)
    unreadable = false
    computer.maintenance = new ComputerMaintenance(computer.ports)
    expect(await sync('sync-mcp')).toMatchObject({ state: 'succeeded' })
    expect(await sync('sync-plugins')).toMatchObject({ state: 'succeeded' })
    expect([...computer.codexMcp]).toEqual(['local'])
    expect([...computer.claudeMcp]).toEqual([['local', localDefinition]])
    expect([...computer.codexPlugins]).toEqual(['local@official'])
    expect([...computer.claudePlugins]).toEqual([['local@official', false]])

    const count = starts.length
    await service.syncChangedSources()
    await settle(computer)
    computer.maintenance = new ComputerMaintenance(computer.ports)
    await service.syncChangedSources()
    expect(starts).toHaveLength(count)
    const persisted = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await operator.callTool({
      name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
    })))).computers.find(item => item.target.applicationInstallationId === device.workerInstallationId)
    for (const kind of ['sync-mcp', 'sync-plugins']) {
      expect(persisted?.status?.tasks.find(task => task.kind === kind)).toMatchObject({
        state: 'succeeded', sourceFingerprint: expect.stringMatching(/^sha256:/u),
      })
    }
  })

  it('shows a running task\'s progress within seconds instead of the settled-status cache', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const owner = await new PostgresAccessService(database.pool).issue({ name: 'Progress reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const principal = await new PostgresAccessService(database.pool).authenticate(owner.token)
    const running = { ...task({ kind: 'sync-mcp', servers: { codex: [], claude: [] } }) }
    let clock = 0
    const local = { status: async () => ({ ...status('0.161.0'), tasks: [structuredClone(running)] }) } as unknown as ComputerMaintenance
    const fleet = new FleetMaintenanceService(database.pool, mainId, () => undefined, new PostgresCommandCoordinator(database.pool), local,
      { codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}), claudePlugins: async () => ({ plugins: [], marketplaces: [] }), codexPlugins: async () => [], codexMarketplaces: async () => [] }, () => clock)
    const main = async () => (await fleet.list(principal)).computers.find(computer => computer.target.hostRef.kind === 'main')!.status!.tasks[0]!
    expect(await main()).toMatchObject({ state: 'running' })
    Object.assign(running, { state: 'succeeded', summary: 'Codex: Added linear', finishedAt: new Date().toISOString() })
    clock = 4_000
    expect(await main()).toMatchObject({ state: 'succeeded', summary: 'Codex: Added linear' })
    Object.assign(running, { summary: 'changed after settling' })
    clock = 8_000
    expect(await main()).toMatchObject({ summary: 'Codex: Added linear' })
  })
  it('keeps harness updates and MCP sync working when plugin discovery fails', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'c'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const starts: MaintenanceTaskStart[] = []
    const local = {
      status: async () => status('0.150.0'),
      start: (input: MaintenanceTaskStart) => { starts.push(input); return task(input) },
    } as unknown as ComputerMaintenance
    const service = new FleetMaintenanceService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
      request: async (_deviceId, _namespace, payload) => {
        const request = MaintenanceRequestSchema.parse(payload)
        if (request.operation === 'status') return { payload: { operation: 'status', status: status('0.150.0') } }
        starts.push(request.task)
        return { payload: { operation: 'start', task: task(request.task) } }
      },
    }), new PostgresCommandCoordinator(database.pool), local, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => { throw new Error('Codex plugin catalog unavailable') },
      codexMarketplaces: async () => [],
      claudePlugins: async () => { throw new Error('Claude plugin catalog unavailable') },
    })
    await expect(service.keepCurrent()).rejects.toThrow('Some fleet settings could not be read.')
    expect(starts.map(input => input.kind)).toEqual(expect.arrayContaining(['update-harnesses', 'sync-mcp']))
    expect(starts.some(input => input.kind === 'sync-plugins')).toBe(false)
  })

  it('verifies OS updates through MCP and returns phased packages as pending', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const owner = await access.issue({ name: 'OS update verifier', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    let upgraded = false
    let readbacks = 0
    const ports: MaintenancePorts = {
      environment: { HOME: '/home/owner' }, find: async name => ['apt-get', 'npm'].includes(name) ? `/usr/bin/${name}` : null,
      run: async (binary, args) => {
        if (args[0] === 'view') return { code: 0, stdout: '1.2.3', stderr: '' }
        if (binary.endsWith('apt-get')) {
          if (upgraded) readbacks++
          return { code: 0, stdout: `${upgraded ? 0 : 2} upgraded, 0 newly installed, 0 to remove and 23 not upgraded.`, stderr: '' }
        }
        if (args.includes('upgrade')) upgraded = true
        return { code: 0, stdout: '2 upgraded, 0 newly installed, 0 to remove and 23 not upgraded.', stderr: '' }
      },
      exists: async () => false, readText: async () => null, writePrivateText: async () => undefined, disk: async () => null,
      later: () => {}, now: () => new Date(),
    }
    const commands = new PostgresCommandCoordinator(database.pool)
    const service = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands,
      new ComputerMaintenance(ports), {
        codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
        codexPlugins: async () => [], codexMarketplaces: async () => [],
        claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance: service, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'update-readback-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${owner.token}` } },
    }))
    const before = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computers_maintenance_status',
      arguments: { detail: 'full', refresh: true } }))))
    const main = before.computers.find(computer => computer.target.hostRef.kind === 'main')!
    expect(main.status?.system.packageUpdates).toBe(25)
    const started = await client.callTool({ name: 'computers_maintenance_start', arguments: {
      commandId: randomUUID(), task: { kind: 'update-system' }, targets: [main.target],
    } })
    expect(started.isError).not.toBe(true)
    await expect.poll(async () => {
      const current = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computers_maintenance_status',
        arguments: { detail: 'full', refresh: true } })))).computers.find(computer => computer.target.hostRef.kind === 'main')
      return current?.status?.tasks[0]?.state
    }, POLL).toBe('succeeded')
    const after = ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computers_maintenance_status',
      arguments: { detail: 'full', refresh: true } })))).computers.find(computer => computer.target.hostRef.kind === 'main')!
    expect(after.status?.system.packageUpdates).toBe(23)
    expect(after.status?.tasks[0]?.summary).toContain('23 updates pending')
    expect(readbacks).toBeGreaterThan(0)
  })

  it('queues distinct updates and reads persisted terminal and interrupted tasks on command replay', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const issue = (name: string, write: boolean) => access.issue({ name, audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: write ? ['settings:read', 'settings:update'] : ['settings:read'], scope: {} }] })
    const writer = await issue('Lifecycle maintainer', true)
    const reader = await issue('Lifecycle reader', false)
    const home = await mkdtemp(join(tmpdir(), 'main-maintenance-'))
    homes.push(home)
    const installedBinary = join(home, '.local/lib/node_modules/@openai/codex/node_modules/@openai',
      'codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')
    await mkdir(dirname(installedBinary), { recursive: true })
    await writeFile(installedBinary, '#!/bin/sh\necho codex-cli 0.161.0\n', { mode: 0o755 })
    const filesystem = systemMaintenancePorts({ HOME: home })
    const selectionPath = join(home, 'main-codex.json')
    let selection = new MainCodexSelection('/opt/main/codex', selectionPath, filesystem)
    await selection.initialize()
    const versions = { codex: '0.160.0', claude: '2.1.19' }
    let releaseInstall!: () => void
    let installGate = new Promise<void>(resolve => { releaseInstall = resolve })
    let installs = 0
    let claudeUpdates = 0
    let versionReads = 0
    const ports: MaintenancePorts = {
      environment: { HOME: home },
      find: async name => {
        if (name === 'codex') return selection.binary
        return ['claude', 'npm'].includes(name) ? `/fixture/${name}` : null
      },
      run: async (binary, args) => {
        let stdout = ''
        if (args[0] === '--version') {
          versionReads++
          const codex = binary === '/opt/main/codex' ? '0.160.0' : versions.codex
          stdout = binary.endsWith('claude') ? versions.claude : `codex-cli ${codex}`
        }
        if (args[0] === 'view') stdout = args[1] === '@openai/codex' ? '0.161.0' : '2.1.294'
        if (args[0] === 'install') {
          installs++
          await installGate
          versions.codex = '0.161.0'
        }
        if (args[0] === 'update') {
          claudeUpdates++
          versions.claude = '2.1.294'
        }
        return { code: 0, stdout, stderr: '' }
      },
      exists: async () => false,
      readText: filesystem.readText,
      writePrivateText: filesystem.writePrivateText,
      selectInstalledCodex: signal => selection.selectInstalled(signal),
      disk: async () => null,
      later: () => {},
      now: () => new Date(),
    }
    let local = new ComputerMaintenance(ports)
    const commands = new PostgresCommandCoordinator(database.pool)
    const service = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands, {
      start: (request: MaintenanceTaskStart) => local.start(request),
      status: (signal: AbortSignal) => local.status(signal),
    } as ComputerMaintenance, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance: service, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'maintenance-lifecycle-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const operator = await connect(writer.token)
    const readOnly = await connect(reader.token)
    const current = async () => ComputerMaintenanceListSchema.parse(decodeMcpToolResult((await operator.callTool({
      name: 'computers_maintenance_status', arguments: { detail: 'full', refresh: true },
    })))).computers.find(computer => computer.target.hostRef.kind === 'main')!
    const main = await current()
    const codex = { commandId: randomUUID(), task: { kind: 'update-harnesses', harnesses: ['codex'] }, targets: [main.target] }
    const start = async (input: typeof codex) => ComputerMaintenanceStartResultSchema.parse(decodeMcpToolResult((await operator.callTool({
      name: 'computers_maintenance_start', arguments: input,
    })))).computers[0]!.task!
    expect((await readOnly.callTool({ name: 'computers_maintenance_start', arguments: codex })).isError).toBe(true)
    expect(installs).toBe(0)
    const first = await start(codex)
    await expect.poll(() => installs, POLL).toBe(1)
    const sampledVersions = versionReads
    let releaseDisk!: () => void
    const diskGate = new Promise<null>(resolve => { releaseDisk = () => resolve(null) })
    ports.disk = () => diskGate
    const slowStatus = current()
    await expect.poll(() => versionReads, POLL).toBe(sampledVersions + 2)
    const both = { ...codex, commandId: randomUUID(), task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } }
    const broader = await start(both)
    expect(broader.id).not.toBe(first.id)
    expect((await start({ ...both, commandId: randomUUID(), task: {
      kind: 'update-harnesses', harnesses: ['claude', 'codex'],
    } })).id).toBe(broader.id)
    releaseInstall()
    ports.disk = async () => null
    await expect.poll(async () => (await current()).status?.tasks.every(task => task.state === 'succeeded'), POLL).toBe(true)
    releaseDisk()
    const coherent = await slowStatus
    expect(coherent.status?.tasks.every(task => task.state === 'succeeded')).toBe(true)
    expect(coherent.status?.harnesses.map(entry => entry.version)).toEqual(['0.161.0', '2.1.294'])
    expect((await current()).status?.harnesses.map(entry => entry.version)).toEqual(['0.161.0', '2.1.294'])
    expect(selection.binary).toBe(installedBinary)
    expect(claudeUpdates).toBe(1)
    selection = new MainCodexSelection('/opt/main/codex', selectionPath, filesystem)
    await selection.initialize()
    expect(selection.binary).toBe(installedBinary)
    local = new ComputerMaintenance(ports)
    expect(await start(both)).toMatchObject({ id: broader.id, state: 'succeeded' })
    expect(installs).toBe(2)

    installGate = new Promise<void>(resolve => { releaseInstall = resolve })
    const interruptedInput = { ...codex, commandId: randomUUID() }
    const interrupted = await start(interruptedInput)
    await expect.poll(() => installs, POLL).toBe(3)
    const previousOwner = local
    local = new ComputerMaintenance(ports)
    expect((await current()).status?.tasks.find(task => task.id === interrupted.id)).toMatchObject({
      state: 'failed', summary: expect.stringContaining('interrupted'),
    })
    expect(await start(interruptedInput)).toMatchObject({ id: interrupted.id, state: 'failed' })
    expect(installs).toBe(3)
    releaseInstall()
    await expect.poll(async () => (await previousOwner.status(AbortSignal.timeout(1000))).tasks[0]?.state, POLL).toBe('succeeded')

    ports.selectInstalledCodex = async () => {
      throw Object.assign(new Error('Unknown system error -122, write'), { errno: -122 })
    }
    const quotaInput = { ...codex, commandId: randomUUID() }
    const quotaTask = await start(quotaInput)
    await expect.poll(async () => (await current()).status?.tasks.find(task => task.id === quotaTask.id)?.state,
      POLL).toBe('failed')
    local = new ComputerMaintenance(ports)
    expect((await current()).status?.tasks.find(task => task.id === quotaTask.id)).toMatchObject({
      state: 'failed', summary: expect.stringContaining('Disk quota reached on this computer'),
    })
    expect(await start(quotaInput)).toMatchObject({ id: quotaTask.id, state: 'failed' })
    expect(installs).toBe(4)
  })

})
