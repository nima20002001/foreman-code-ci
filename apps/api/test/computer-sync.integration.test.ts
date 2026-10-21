import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComputerSyncStatusSchema, SyncChannelRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerSyncService } from '../src/modules/computers/sync.js'
import { SyncthingComputer, sharedFolderId } from '../src/modules/computers/syncthingComputer.js'
import { fakeSyncthing, mainSyncId, workerSyncId } from './helpers/syncthing.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Syncthing through authenticated Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let mainId: string
  beforeEach(async () => {
    database = await agent3Database()
    mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  }, 60_000)
  afterEach(async () => { await database?.close() })
  async function fixture(options: { withoutSync?: boolean } = {}) {
    const access = new PostgresAccessService(database.pool)
    const commands = new PostgresCommandCoordinator(database.pool)
    const writer = await access.issue({ name: 'Sync writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await access.issue({ name: 'Sync reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] })
    const updateOnly = await access.issue({ name: 'Sync updater', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:update'], scope: {} }] })
    const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
    await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
    [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    const target: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId, deviceId: registration.deviceId },
      applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const workspaceId = `workspace-${randomUUID()}`
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Client/Web' })])
    const agentId = `agent-${randomUUID()}`
    const configurationId = `config-${randomUUID()}`
    await database.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [agentId, workspaceId, JSON.stringify({ id: agentId, name: 'Worker' })])
    await database.pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,1,$4::jsonb)`, [configurationId, workspaceId, agentId,
      JSON.stringify({ harnessProfileSelection: { target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId } } })])
    await database.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agentId, configurationId])
    const main = await fakeSyncthing({ deviceId: mainSyncId, address: '100.64.0.1', rootPath: '/main/shared' })
    const worker = await fakeSyncthing({ deviceId: workerSyncId, address: '100.64.0.20', rootPath: '/worker/shared' })
    const local = new SyncthingComputer(main.ports)
    const remote = new SyncthingComputer(worker.ports)
    let online = true
    const endpoint = { capabilities: () => online ? [{ namespace: 'computer-sync-v1', mainCanRequest: true }] : [],
      request: async (_device: string, _namespace: string, payload: unknown) => ({ payload: await remote.handle(SyncChannelRequestSchema.parse(payload).request) }) }
    const createService = () => new ComputerSyncService(database.pool, mainId, () => endpoint, commands, local)
    const sync = createService()
    const services = { ...(options.withoutSync ? {} : { computerSync: sync }), commands } as unknown as OperatorServices
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (bearer: string) => {
      const client = new Client({ name: 'sync-integration', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }))
      return client
    }
    return { sync, createService, app, connect, target, writer, reader, updateOnly, workspaceId, main, worker, registration,
      setOnline: (value: boolean) => { online = value },
      restart: () => {
        const restarted = createService()
        services.computerSync = restarted
        return restarted
      },
      close: async () => { await Promise.all(clients.map(client => client.close())); await app.close();
        await main.close(); await worker.close() } }
  }

  it('persists the last sync write without a revision while denying read-only callers', async () => {
    const f = await fixture()
    try {
      const writer = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false, commandId: randomUUID() }
      expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      expect((await writer.callTool({ name: 'computer_sync_update', arguments: input })).isError).not.toBe(true)
      const lastInput = { ...input, enabled: true, commandId: randomUUID() }
      expect((await writer.callTool({ name: 'computer_sync_update', arguments: lastInput })).isError).not.toBe(true)
      expect((await writer.callTool({ name: 'computer_sync_update', arguments: lastInput })).isError).not.toBe(true)
      const readback = ComputerSyncStatusSchema.parse(decodeMcpToolResult(await reader.callTool({
        name: 'computer_sync_status', arguments: { target: f.target },
      })))
      expect(readback.folders.find(folder => folder.workspaceId === f.workspaceId))
        .toMatchObject({ enabled: true, revision: 2 })
      expect((await f.createService().read(f.writer.principal, 'mcp', { target: f.target })).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: true, revision: 2 })
    } finally { await f.close() }
  })

  it('hides global sync tools from workspace grants and audits denied HTTP and MCP writes', async () => {
    const f = await fixture()
    try {
      const access = new PostgresAccessService(database.pool)
      const scoped = await access.issue({ name: 'Scoped sync caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000),
        grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      const client = await f.connect(scoped.token)
      const names = (await client.listTools()).tools.map(tool => tool.name)
      expect(names).not.toContain('computer_sync_status')
      expect(names).not.toContain('computer_sync_update')
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false,
        expectedRevision: 0, commandId: randomUUID() }
      for (const name of ['computer_sync_status', 'computer_sync_update']) {
        const result = await client.callTool({ name, arguments: name.endsWith('status') ? { target: f.target } : input })
        expect(result).toMatchObject({ isError: true })
        expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text))
          .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      }
      const response = await f.app.inject({ method: 'POST', url: '/api/management/computers/sync/update',
        headers: { authorization: `Bearer ${scoped.token}` }, payload: input })
      expect(response.statusCode).toBe(403)
      expect((await database.pool.query('select workspace_id from computer_sync_preferences where workspace_id=$1',
        [f.workspaceId])).rows).toEqual([])
    } finally { await f.close() }
  })

  it('returns a typed unavailable error when sync is absent even if devices are also absent', async () => {
    const f = await fixture({ withoutSync: true })
    try {
      const client = await f.connect(f.writer.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('computer_sync_status')
      for (const name of ['computer_sync_status', 'computer_sync_update']) {
        const result = await client.callTool({ name, arguments: {} })
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text))
          .toMatchObject({ error: { code: 'COMPUTER_SYNC_UNAVAILABLE' } })
      }
    } finally { await f.close() }
  })

  it('exchanges device IDs, persists on/off, discovers tools, denies writes and audits the MCP command', async () => {
    const f = await fixture()
    try {
      await f.sync.paired(f.target)
      const client = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_sync_update')
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_sync_update')
      const read = async () => ComputerSyncStatusSchema.parse(decodeMcpToolResult((await client.callTool({
        name: 'computer_sync_status', arguments: { target: f.target },
      })))).folders.find(folder => folder.workspaceId === f.workspaceId)!
      expect((await read()).status?.path).toBe(`/worker/shared/${sharedFolderId(f.workspaceId)}`)
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID() }
      expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      const denied = await f.app.inject({ method: 'POST', url: '/api/management/computers/sync/update',
        headers: { authorization: `Bearer ${f.reader.token}` }, payload: input })
      expect(denied.statusCode).toBe(403)
      expect((await client.callTool({ name: 'computer_sync_update', arguments: input })).isError).not.toBe(true)
      expect(await read()).toMatchObject({ enabled: false, revision: 1, status: null })
      expect((await f.createService().read(f.writer.principal, 'mcp', { target: f.target })).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: false, revision: 1 })
      await client.callTool({ name: 'computer_sync_update', arguments: input })
      expect((await read()).revision).toBe(1)
      expect((await client.callTool({ name: 'computer_sync_update', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
      await client.callTool({ name: 'computer_sync_update', arguments: { ...input, enabled: true,
        expectedRevision: 1, commandId: randomUUID() } })
      expect(await read()).toMatchObject({ enabled: true, revision: 2, status: { state: 'idle' } })
      const audits = await database.pool.query<{ action: string; outcome: string }>(
        'select action,outcome from management_audit where principal_id=$1', [f.writer.principal.id])
      expect(audits.rows).toEqual(expect.arrayContaining([
        { action: 'computer_sync_update', outcome: 'succeeded' }, { action: 'computer_sync_update', outcome: 'failed' },
      ]))
    } finally { await f.close() }
  })

  it('keeps offline sharing after restart through MCP, persists pending settings and denies ungranted writes', async () => {
    const f = await fixture()
    try {
      await f.sync.paired(f.target)
      const mainTarget: DeviceProvisioningTarget = { hostRef: { kind: 'main', mainId },
        applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }
      const before = await f.main.rest('GET', '/rest/config/folders')
      f.setOnline(false)
      await expect(f.restart().reconcile()).rejects.toThrow('Shared file setup is pending')
      const writer = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      const input = { target: mainTarget, workspaceId: f.workspaceId, enabled: true,
        expectedRevision: 0, commandId: randomUUID() }
      expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      const saved = await writer.callTool({ name: 'computer_sync_update', arguments: input })
      expect(saved.isError).not.toBe(true)
      expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(saved)).message).toContain('pending')
      const persisted = await reader.callTool({ name: 'computer_sync_status', arguments: { target: mainTarget } })
      expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(persisted)).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: true, revision: 1 })
      expect(await f.main.rest('GET', '/rest/config/folders')).toEqual(before)
      const disabled = await writer.callTool({ name: 'computer_sync_update', arguments: {
        target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID(),
      } })
      expect(disabled.isError).not.toBe(true)
      const remoteReadback = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.target } })
      expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(remoteReadback)).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: false, revision: 1 })
      expect(await f.main.rest('GET', '/rest/config/folders')).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sharedFolderId(f.workspaceId), devices: [{ deviceID: mainSyncId }] }),
      ]))
    } finally { await f.close() }
  })

  it('refuses an old computer registration and revoked writer before forwarding a sync change', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID() }
      await database.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [f.writer.principal.id])
      expect((await client.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      expect(await f.worker.rest('GET', '/rest/config/folders')).toEqual([])
      f.registration.authorizationRevision++
      await database.pool.query('update device_registrations set record=$2::jsonb where id=$1',
        [f.registration.deviceId, JSON.stringify(f.registration)])
      await expect(f.sync.read(f.reader.principal, 'mcp', { target: f.target })).rejects.toThrow()
      expect((await database.pool.query('select * from computer_sync_preferences where workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    } finally { await f.close() }
  })

  it('returns a successful save to update-only callers while keeping status reads separately granted', async () => {
    const f = await fixture()
    try {
      const updater = await f.connect(f.updateOnly.token)
      const reader = await f.connect(f.reader.token)
      const saved = await updater.callTool({ name: 'computer_sync_update', arguments: {
        target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID(),
      } })
      expect(saved.isError).not.toBe(true)
      expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(saved)).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: false, revision: 1 })
      expect((await updater.callTool({ name: 'computer_sync_status', arguments: { target: f.target } })).isError).toBe(true)
      const persisted = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.target } })
      expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(persisted)).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: false, revision: 1 })
    } finally { await f.close() }
  })
})
