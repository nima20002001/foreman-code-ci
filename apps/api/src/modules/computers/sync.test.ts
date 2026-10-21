import { workerToolServices } from '../../../test/helpers/workerMcpServices.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ComputerSyncStatusSchema, SyncChannelRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { PostgresAppInteractionService } from '../interactions/app.js'
import { RuntimeShutdown } from '../../infrastructure/runtimeShutdown.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { ComputerSyncService } from './sync.js'
import { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import type { DeviceApplicationRequestOptions } from '../devices/deviceApplicationChannel.js'
import { fakeSyncthing, mainSyncId, workerSyncId } from '../../../test/helpers/syncthing.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.restoreAllMocks(); vi.useRealTimers() })
async function fixture() {
  const mainId = randomUUID()
  const devices = [randomUUID(), randomUUID()].map(deviceId => ({ mainId, deviceId,
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
    publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }))
  const targets: DeviceProvisioningTarget[] = [{ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, ...devices.map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId }, applicationInstallationId: device.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1 }))]
  const rest = await Promise.all([mainSyncId, workerSyncId, Array(8).fill('CCCCCCC').join('-')].map((deviceId, index) =>
    fakeSyncthing({ deviceId, address: `100.64.0.${index + 1}`, rootPath: `/computer-${index}/shared` })))
  cleanups.push(...rest.map(server => server.close))
  const computers = rest.map(server => new SyncthingComputer(server.ports))
  const writer: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z',
    revokedAt: null, grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] }
  const reader: ManagementPrincipal = { ...writer, id: 'reader', grants: [{ actions: ['settings:read'], scope: {} }] }
  const updateOnly: ManagementPrincipal = { ...writer, id: 'update-only',
    grants: [{ actions: ['settings:update'], scope: {} }] }
  const principals = new Map([['writer', writer], ['reader', reader], ['update-only', updateOnly]])
  const identities = new Map<string, { target: unknown; identity: unknown }>()
  const preferences = new Map<string, { target: DeviceProvisioningTarget; revision: string; enabled: boolean }>()
  const workspaces = [{ id: 'workspace-a', name: 'Client/Web', active: true }, { id: 'workspace-b', name: 'Client-Web', active: true }]
  const hosts = [{ workspace_id: 'workspace-a', host: targets[1]!.hostRef,
    installation_id: targets[1]!.applicationInstallationId, key_revision: null, authorization_revision: null }]
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (text.includes('from management_principals')) {
      const principal = principals.get(values[0] as string)
      return { rows: principal ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null }] : [] }
    }
    if (text.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (text.includes('from device_registrations')) {
      return { rows: devices.filter(device => !text.includes('where id=') || device.deviceId === values[0]).map(record => ({ record })) }
    }
    if (text.includes('from agents')) return { rows: hosts }
    if (text.includes('from workspaces')) return { rows: values.length ? workspaces.filter(row => row.id === values[0]) : workspaces }
    if (text.includes('from computer_sync_identities')) return { rows: [...identities.values()] }
    if (text.includes('insert into computer_sync_identities')) {
      identities.set(`${values[0]}:${values[1]}`, { target: JSON.parse(values[1] as string),
        identity: JSON.parse(values[2] as string) })
    }
    const key = `${values[0]}:${values[1]}`
    if (text.includes('select target,revision')) return { rows: preferences.has(key) ? [preferences.get(key)!] : [] }
    if (text.includes('insert into computer_sync_preferences')) {
      preferences.set(key, { target: JSON.parse(values[2] as string) as DeviceProvisioningTarget,
        revision: String(values[3]), enabled: values[4] as boolean })
    }
    return { rows: [] }
  }
  const sql = { query, release() {} }
  const pool = { query, connect: async () => sql } as unknown as pg.Pool
  const receipts = new Map<string, { payload: string; value: unknown }>()
  const denied = vi.fn().mockResolvedValue(undefined)
  const commands = { recordDenied: denied, execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.authorize?.(sql as unknown as pg.PoolClient)
    const old = receipts.get(input.commandId ?? crypto.randomUUID())
    if (old) {
      if (old.payload !== JSON.stringify(input.payload)) throw new DomainError('COMMAND_ID_CONFLICT', 'Changed input.', 409)
      return { value: old.value, replayed: true }
    }
    const value = await input.perform(sql as unknown as pg.PoolClient)
    receipts.set(input.commandId ?? crypto.randomUUID(), { payload: JSON.stringify(input.payload), value })
    return { value, replayed: false }
  } } as unknown as PostgresCommandCoordinator
  const endpoint = { capabilities: () => [{ namespace: 'computer-sync-v1', mainCanRequest: true }],
    request: async (deviceId: string, _namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) => {
      void options
      const index = targets.findIndex(target => target.hostRef.kind === 'device' && target.hostRef.deviceId === deviceId)
      const input = SyncChannelRequestSchema.parse(payload)
      return { payload: await computers[index]!.handle(input.request) }
    } }
  const createService = () => new ComputerSyncService(pool, mainId, () => endpoint, commands, computers[0])
  return { service: createService(), createService, targets, rest, computers, workspaces, hosts, devices,
    writer, reader, principals, preferences, identities, denied, commands, pool, endpoint }
}

it('serves authenticated Agent context while optional shared-file installation is pending', async () => {
  const f = await fixture()
  const worker: ManagementPrincipal = { ...f.writer, id: 'worker', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: {
      workspaceIds: ['workspace-a'], workflowIds: ['workflow'], runIds: ['run'],
    } }] }
  f.principals.set(worker.id, worker)
  const access = new PostgresAccessService(f.pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = f.principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  const query = async (text: string) => {
    if (text.includes('workspaces w')) return { rows: [{ device_id: null, workspace_id: 'workspace-a' }] }
    if (text.includes('execution_native_placements') || text.includes('agent_conversation_credentials')) return { rows: [] }
    return { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }
  }
  const interactions = Object.assign(new PostgresAppInteractionService({ query } as unknown as pg.Pool,
    {} as never, {} as never), { syncedFolder: f.service.sharedFolder.bind(f.service) })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands: f.commands } as OperatorServices }, appMcp: workerToolServices(f.pool, f.commands).appMcp(access, interactions) })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'pending-sync-context', version: '1' })
  cleanups.push(async () => { await client.close(); await app.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin),
    { requestInit: { headers: { authorization: 'Bearer worker' } } }))
  expect((await app.inject({ method: 'POST', url: '/mcp', headers: {
    authorization: 'Bearer invalid', accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  }, payload: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} },
  } })).statusCode).toBe(401)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const prepare = f.rest[0]!.ports.prepare
  const preparing = vi.spyOn(f.rest[0]!.ports, 'prepare').mockImplementation(async () => {
    await hold
    return prepare()
  })
  const setup = f.service.reconcile()
  let read: Promise<void> | undefined
  try {
    await vi.waitFor(() => { expect(preparing).toHaveBeenCalled() })
    const readback = vi.fn()
    read = client.callTool({ name: 'context_get', arguments: {} }).then(readback)
    await vi.waitFor(() => { expect(readback).toHaveBeenCalledWith(expect.objectContaining({
      structuredContent: expect.objectContaining({ principal: expect.objectContaining({ id: worker.id }) }),
    })) })
    await read
    expect(decodeMcpToolResult(readback.mock.calls[0]![0])).not.toHaveProperty('sharedFiles')
  } finally {
    release()
    await setup
    await read
  }
  const available = await client.callTool({ name: 'context_get', arguments: {} })
  expect(decodeMcpToolResult(available)).toMatchObject({ sharedFiles: { provider: 'syncthing',
    path: `/computer-0/shared/${sharedFolderId('workspace-a')}` } })
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let statusSignal: AbortSignal | undefined
  vi.spyOn(f.rest[0]!.ports, 'available').mockImplementation(async signal => {
    statusSignal = signal
    entered()
    return new Promise<never>((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  const slowContext = client.callTool({ name: 'context_get', arguments: {} })
  await started
  budget.abort(new DOMException('Context budget expired', 'TimeoutError'))
  const timedOut = decodeMcpToolResult(await slowContext)
  expect(timedOut).toMatchObject({ principal: { id: worker.id } })
  expect(timedOut).not.toHaveProperty('sharedFiles')
  expect(statusSignal?.aborted).toBe(true)
})

it('omits an unavailable optional shared folder and preserves unexpected failures', async () => {
  const f = await fixture()
  const handle = vi.spyOn(f.computers[0]!, 'handle')
    .mockRejectedValue(new DomainError('SYNC_UNAVAILABLE', 'Shared files are unavailable.', 502))
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBeNull()
  handle.mockRejectedValue(new DeviceApplicationError('timeout'))
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBeNull()
  handle.mockRejectedValue(new DeviceApplicationError('extension-rejected'))
  await expect(f.service.sharedFolder('workspace-a', { kind: 'main' })).rejects.toThrow('extension-rejected')
  handle.mockRejectedValue(new Error('Unexpected configuration error'))
  await expect(f.service.sharedFolder('workspace-a', { kind: 'main' }))
    .rejects.toThrow('Unexpected configuration error')
})

it('omits unavailable remote shared files across the device error boundary and preserves denied access', async () => {
  const f = await fixture()
  const request = vi.spyOn(f.endpoint, 'request').mockImplementation(async () => {
    const failure = deviceApplicationFailure(new DomainError('SYNC_UNAVAILABLE', 'Setup is unavailable.', 502))
    throw new DeviceApplicationError(failure.code)
  })
  await expect(f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId }))
    .resolves.toBeNull()
  request.mockRejectedValue(new DeviceApplicationError('permission'))
  await expect(f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId }))
    .rejects.toThrow('permission')
})

it('pairs without preparing shared-file services when every workspace disables sync', async () => {
  const f = await fixture()
  for (const server of f.rest) {
    vi.spyOn(server.ports, 'available').mockResolvedValue({ installed: false, running: false })
  }
  for (const workspace of f.workspaces) {
    await f.service.update(f.writer, 'mcp', { target: f.targets[0], workspaceId: workspace.id,
      enabled: false, expectedRevision: 0, commandId: randomUUID() })
  }
  const preparation = f.rest.map(server => vi.spyOn(server.ports, 'prepare'))
  await f.service.paired(f.targets[1]!)
  for (const prepare of preparation) expect(prepare).not.toHaveBeenCalled()
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId }))
    .toBeNull()
})

it('stops offering a disabled workspace folder while a computer has not applied the change', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const handle = f.computers[1]!.handle.bind(f.computers[1]!)
  vi.spyOn(f.computers[1]!, 'handle').mockImplementation(async request => {
    const input = SyncChannelRequestSchema.shape.request.parse(request)
    if (input.operation === 'configure') throw new DomainError('SYNC_UNAVAILABLE', 'Setup is pending.', 502)
    return handle(request)
  })
  await f.service.update(f.writer, 'mcp', { target: f.targets[0], workspaceId: 'workspace-a', enabled: false,
    expectedRevision: 0, commandId: randomUUID() })
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toHaveLength(1)
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
})

it('pairs automatically through the channel and shares each workspace only with its participating computers', async () => {
  const f = await fixture()
  await f.service.paired(f.targets[1]!)
  const mainFolders = await f.rest[0]!.rest('GET', '/rest/config/folders') as { id: string; devices: unknown[] }[]
  expect(mainFolders.find(folder => folder.id === sharedFolderId('workspace-a'))?.devices)
    .toEqual([{ deviceID: mainSyncId }, { deviceID: workerSyncId }])
  expect(mainFolders.find(folder => folder.id === sharedFolderId('workspace-b'))?.devices).toEqual([{ deviceID: mainSyncId }])
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toHaveLength(1)
  expect(await f.rest[2]!.rest('GET', '/rest/config/folders')).toEqual([])
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId }))
    .toBe(`/computer-1/shared/${sharedFolderId('workspace-a')}`)
  f.workspaces[0]!.name = 'Renamed client'
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBe(`/computer-0/shared/${sharedFolderId('workspace-a')}`)
  f.hosts.length = 0
  await f.service.reconcile()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: workerSyncId }],
  })])
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
})

it('persists enabled preferences, checks revisions, retries commands and survives service restart', async () => {
  const f = await fixture()
  const input = { target: f.targets[1], workspaceId: 'workspace-a', enabled: false, expectedRevision: 0, commandId: randomUUID() }
  const saved = await f.service.update(f.writer, 'http', input)
  expect(saved.folders[0]).toMatchObject({ enabled: false, revision: 1, status: null })
  expect((await f.createService().read(f.writer, 'mcp', { target: f.targets[1] })).folders[0])
    .toMatchObject({ enabled: false, revision: 1 })
  await f.service.update(f.writer, 'mcp', input)
  await expect(f.service.update(f.writer, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const enabled = await f.service.update(f.writer, 'mcp', { ...input, enabled: true, expectedRevision: 1, commandId: randomUUID() })
  expect(enabled.folders[0]).toMatchObject({ enabled: true, revision: 2, status: { state: 'idle' } })
  f.devices[0]!.authorizationRevision++
  await expect(f.service.update(f.writer, 'mcp', { ...input, commandId: randomUUID() })).rejects.toThrow()
})

it('supports authenticated MCP discovery, denied callers and persisted readback through the same HTTP service', async () => {
  const f = await fixture()
  const access = new PostgresAccessService(f.pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = f.principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { computerSync: f.service, commands: f.commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  cleanups.push(async () => { await Promise.all(clients.map(client => client.close())); await app.close() })
  const connect = async (token: string) => {
    const client = new Client({ name: 'sync-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return client
  }
  const writer = await connect('writer')
  const reader = await connect('reader')
  const updateOnly = await connect('update-only')
  expect((await writer.listTools()).tools.map(tool => tool.name)).toContain('computer_sync_update')
  expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_sync_update')
  const input = { target: f.targets[1], workspaceId: 'workspace-a', enabled: false, expectedRevision: 0, commandId: randomUUID() }
  expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
  const denied = await app.inject({ method: 'POST', url: '/api/management/computers/sync/update',
    headers: { authorization: 'Bearer reader' }, payload: input })
  expect(denied.statusCode, JSON.stringify(denied.json())).toBe(403)
  const saved = await writer.callTool({ name: 'computer_sync_update', arguments: input })
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(saved)).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const persisted = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(persisted)).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const enabled = await updateOnly.callTool({ name: 'computer_sync_update', arguments: {
    ...input, expectedRevision: 1, enabled: true, commandId: randomUUID(),
  } })
  expect(enabled.isError).not.toBe(true)
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(enabled)).folders[0]).toMatchObject({ enabled: true, revision: 2 })
  expect((await updateOnly.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })).isError).toBe(true)
  const enabledReadback = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(enabledReadback)).folders[0])
    .toMatchObject({ enabled: true, revision: 2 })
  f.principals.set('writer', { ...f.writer, grants: [] })
  await expect(f.service.update(f.writer, 'mcp', { ...input, expectedRevision: 2, enabled: false,
    commandId: randomUUID() })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.preferences.values().next().value?.enabled).toBe(true)
})

it('removes sharing after archive or Main disable and never gives a replacement installation the old folder', async () => {
  const f = await fixture()
  await f.service.paired(f.targets[1]!)
  f.hosts[0]!.installation_id = randomUUID()
  await f.service.reconcile()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: workerSyncId }],
  })])
  f.hosts[0]!.installation_id = f.targets[1]!.applicationInstallationId
  await f.service.update(f.writer, 'mcp', { target: f.targets[0], workspaceId: 'workspace-a', enabled: false,
    expectedRevision: 0, commandId: randomUUID() })
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: workerSyncId }],
  })])
  f.workspaces[1]!.active = false
  await f.service.reconcile()
  expect((await f.service.read(f.reader, 'mcp', { target: f.targets[0] })).folders.map(folder => folder.workspaceId))
    .toEqual(['workspace-a'])
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: mainSyncId }] }),
    expect.objectContaining({ id: sharedFolderId('workspace-b'), paused: true, devices: [{ deviceID: mainSyncId }] }),
  ])
})

it('defers membership replacement after restart while an enabled peer identity is unavailable', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const folders = await f.rest[0]!.rest('GET', '/rest/config/folders')
  vi.spyOn(f.endpoint, 'request').mockRejectedValue(new DomainError('COMPUTER_OFFLINE', 'Offline.', 409))
  const restarted = f.createService()
  await expect(restarted.reconcile()).rejects.toThrow('Shared file setup is pending')
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(folders)
  await restarted.update(f.writer, 'mcp', { target: f.targets[1], workspaceId: 'workspace-a',
    enabled: false, expectedRevision: 0, commandId: randomUUID() })
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), devices: [{ deviceID: mainSyncId }] }),
  ]))
})

it('removes a revoked peer from Main after restart even while its app is unavailable', async () => {
  const f = await fixture()
  await f.service.reconcile()
  f.devices.splice(0, 1)
  vi.spyOn(f.endpoint, 'request').mockRejectedValue(new DomainError('COMPUTER_OFFLINE', 'Offline.', 409))
  await expect(f.createService().reconcile()).rejects.toThrow('Shared file setup is pending')
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), devices: [{ deviceID: mainSyncId }] }),
  ]))
})

it('omits slow local shared-folder status at the context budget and stops further status work', async () => {
  const f = await fixture()
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let release!: () => void
  let entered!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let localSignal: AbortSignal | undefined
  vi.spyOn(f.rest[0]!.ports, 'available').mockImplementation(async signal => {
    localSignal = signal
    entered()
    await hold
    return { installed: true, running: true }
  })
  const rest = vi.spyOn(f.rest[0]!.ports, 'rest')
  const read = f.service.sharedFolder('workspace-a', { kind: 'main' })
  try {
    await started
    budget.abort(new DOMException('Context budget expired', 'TimeoutError'))
    expect(await read).toBeNull()
    expect(localSignal?.aborted).toBe(true)
  } finally {
    release()
    await read
  }
  await Promise.resolve()
  expect(rest).not.toHaveBeenCalled()
})

it('cancels remote shared-folder status requests when the context budget expires', async () => {
  const f = await fixture()
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let remoteSignal: AbortSignal | undefined
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (_deviceId, _namespace, _payload, options) => {
    remoteSignal = options!.signal
    entered()
    return new Promise<never>((_, reject) => {
      remoteSignal!.addEventListener('abort', () => reject(new DeviceApplicationError('timeout')), { once: true })
    })
  })
  const read = f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })
  await started
  expect(remoteSignal?.aborted).toBe(false)
  const reason = new DOMException('Context budget expired', 'TimeoutError')
  budget.abort(reason)
  expect(await read).toBeNull()
  expect(remoteSignal?.aborted).toBe(true)
  expect(remoteSignal?.reason).toBe(reason)
})

for (const target of ['local', 'remote'] as const) {
  it(`joins a pending ${target} sync configuration before releasing resources`, async () => {
    const f = await fixture()
    await f.service.reconcile()
    const entered = deferred(), release = deferred()
    const signals: AbortSignal[] = []
    const hold = async (signal?: AbortSignal) => {
      if (signal) signals.push(signal)
      entered.resolve()
      await release.promise
      signal?.throwIfAborted()
      return { installed: true, running: true, deviceId: mainSyncId, folders: [], message: null }
    }
    if (target === 'local') {
      vi.spyOn(f.computers[0]!, 'handle').mockImplementation((_request, options) => hold(options?.signal))
    } else {
      vi.spyOn(f.endpoint, 'request').mockImplementation(async (_id, _namespace, _payload, options) =>
        ({ payload: await hold(options?.signal) }))
    }
    const polling = f.service.poll().then(() => undefined, error => error)
    await entered.promise
    const dispose = vi.fn(), released = vi.fn()
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'shared file admission', run: () => f.service.stopAdmission() }],
      drain: [{ name: 'shared file work', run: () => f.service.join() }],
      dispose: [{ name: 'database and devices', run: dispose }], releaseOwnership: async () => { released() },
    })
    const closing = shutdown.finish()
    try {
      expect(signals).toHaveLength(target === 'local' ? 1 : 4)
      for (const signal of signals) expect(signal.aborted).toBe(true)
      expect(dispose).not.toHaveBeenCalled()
      expect(released).not.toHaveBeenCalled()
      await expect(f.service.reconcile()).rejects.toMatchObject({ code: 'SYNC_CLOSING' })
    } finally { release.resolve(); await Promise.all([polling, closing]) }
    expect(dispose).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledOnce()
    await f.service.poll()
    expect(signals).toHaveLength(target === 'local' ? 1 : 4)
  })
}


it('allows a cold remote setup to finish beyond the channel default deadline', async () => {
  const f = await fixture()
  const entered = deferred()
  const request = f.endpoint.request.bind(f.endpoint)
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (deviceId, namespace, payload, options) => {
    const input = SyncChannelRequestSchema.parse(payload)
    if (input.request.operation !== 'identity') return request(deviceId, namespace, payload, options)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const setup = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Channel request timed out')), options?.timeoutMs ?? 30_000)
      setTimeout(() => { clearTimeout(timeout); resolve() }, 45_000)
    })
    entered.resolve()
    await setup
    vi.useRealTimers()
    return request(deviceId, namespace, payload, options)
  })
  const result = f.service.reconcile().then(() => null, error => error)
  await entered.promise
  await vi.advanceTimersByTimeAsync(45_000)
  expect(await result).toBeNull()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toHaveLength(1)
})

it.each(['persisted', 'unresolved'] as const)('reconciles membership after restart with a %s offline identity', async mode => {
  const f = await fixture()
  await f.service.reconcile()
  if (mode === 'unresolved') f.identities.clear()
  const offlineDeviceId = f.devices[0]!.deviceId
  const onlineHost = { ...f.hosts[0]!, host: f.targets[2]!.hostRef,
    installation_id: f.targets[2]!.applicationInstallationId }
  f.hosts.push(onlineHost)
  const request = f.endpoint.request.bind(f.endpoint)
  vi.spyOn(f.endpoint, 'request').mockImplementation((id, namespace, payload, options) => {
    if (id === offlineDeviceId) throw new DomainError('COMPUTER_OFFLINE', 'Peer offline.', 409)
    return request(id, namespace, payload, options)
  })
  const restarted = f.createService()
  await expect(restarted.reconcile()).rejects.toThrow()
  const folders = () => f.rest[0]!.rest('GET', '/rest/config/folders') as Promise<{ id: string; devices: { deviceID: string }[] }[]>
  expect((await folders()).find(folder => folder.id === sharedFolderId('workspace-a'))?.devices)
    .toEqual([{ deviceID: mainSyncId }, { deviceID: workerSyncId }, { deviceID: f.rest[2]!.identity.deviceId }])
  f.hosts.splice(f.hosts.indexOf(onlineHost), 1)
  await expect(f.createService().reconcile()).rejects.toThrow()
  expect((await folders()).find(folder => folder.id === sharedFolderId('workspace-a'))?.devices)
    .toEqual([{ deviceID: mainSyncId }, { deviceID: workerSyncId }])
  if (mode === 'unresolved') return
  f.devices.splice(0, 1)
  await f.createService().reconcile()
  expect((await folders()).find(folder => folder.id === sharedFolderId('workspace-a'))?.devices)
    .toEqual([{ deviceID: mainSyncId }])
})

it('reads a shared folder without inventorying conflicts or unrelated workspace states', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const scans = vi.spyOn(f.rest[0]!.ports, 'conflicts').mockRejectedValue(new Error('Tree unavailable'))
  const rest = vi.spyOn(f.rest[0]!.ports, 'rest')
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' }))
    .toBe(`/computer-0/shared/${sharedFolderId('workspace-a')}`)
  expect(scans).not.toHaveBeenCalled()
  expect(rest.mock.calls.filter(([, path]) => path.startsWith('/rest/db/status')))
    .toEqual([['GET', `/rest/db/status?folder=${sharedFolderId('workspace-a')}`, undefined, expect.any(AbortSignal)]])
})


it.each(['running', 'restarted'] as const)('refreshes regenerated peer identities on a %s service and persists them', async mode => {
  const f = await fixture()
  await f.service.reconcile()
  const mainId = Array(8).fill('DDDDDDD').join('-')
  const workerId = Array(8).fill('EEEEEEE').join('-')
  f.rest[0]!.identity.deviceId = mainId
  f.rest[1]!.identity.deviceId = workerId
  const service = mode === 'running' ? f.service : f.createService()
  await service.reconcile()
  const folderDevices = async (index: number) => {
    const folders = await f.rest[index]!.rest('GET', '/rest/config/folders') as { id: string; devices: { deviceID: string }[] }[]
    return folders.find(folder => folder.id === sharedFolderId('workspace-a'))?.devices
  }
  expect(await folderDevices(0)).toEqual([{ deviceID: mainId }, { deviceID: workerId }])
  expect(await folderDevices(1)).toEqual([{ deviceID: workerId }, { deviceID: mainId }])
  const request = f.endpoint.request.bind(f.endpoint)
  vi.spyOn(f.endpoint, 'request').mockImplementation((id, namespace, payload, options) => {
    if (id === f.devices[0]!.deviceId) throw new DomainError('COMPUTER_OFFLINE', 'Peer offline.', 409)
    return request(id, namespace, payload, options)
  })
  await expect(f.createService().reconcile()).rejects.toThrow()
  expect(await folderDevices(0)).toEqual([{ deviceID: mainId }, { deviceID: workerId }])
})

it('configures healthy computers and unrelated workspaces while another identity is stalled', async () => {
  const f = await fixture()
  f.hosts.push({ ...f.hosts[0]!, host: f.targets[2]!.hostRef, installation_id: f.targets[2]!.applicationInstallationId })
  const entered = deferred(), release = deferred()
  const request = f.endpoint.request.bind(f.endpoint)
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (id, namespace, payload, options) => {
    const input = SyncChannelRequestSchema.parse(payload)
    if (id === f.devices[0]!.deviceId && input.request.operation === 'identity') {
      entered.resolve()
      await release.promise
    }
    return request(id, namespace, payload, options)
  })
  const reconciling = f.service.reconcile()
  try {
    await entered.promise
    await vi.waitFor(async () => {
      const main = await f.rest[0]!.rest('GET', '/rest/config/folders') as { id: string }[]
      const healthy = await f.rest[2]!.rest('GET', '/rest/config/folders') as { id: string }[]
      expect(main.map(folder => folder.id)).toContain(sharedFolderId('workspace-b'))
      expect(healthy.map(folder => folder.id)).toContain(sharedFolderId('workspace-a'))
    })
  } finally { release.resolve(); await reconciling }
})

it('coalesces simultaneous reconciliations instead of configuring every workspace twice', async () => {
  const f = await fixture()
  const entered = deferred(), release = deferred()
  const prepare = f.rest[0]!.ports.prepare.bind(f.rest[0]!.ports)
  f.rest[0]!.ports.prepare = async () => { entered.resolve(); await release.promise; return prepare() }
  const writes = vi.spyOn(f.rest[1]!.ports, 'rest')
  const first = f.service.reconcile()
  await entered.promise
  const duplicate = f.service.reconcile()
  release.resolve()
  await Promise.all([first, duplicate])
  const folders = writes.mock.calls.filter(([method, path]) => method === 'POST' && path === '/rest/config/folders')
  expect(folders).toHaveLength(1)
})

it('updates one workspace without reconciling unrelated workspace folders', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const writes = vi.spyOn(f.rest[0]!.ports, 'rest')
  await f.service.update(f.writer, 'mcp', { target: f.targets[1], workspaceId: 'workspace-a', enabled: false })
  const folders = writes.mock.calls.filter(([method, path]) => method === 'POST' && path === '/rest/config/folders')
  expect(folders.length).toBeGreaterThan(0)
  for (const [, , body] of folders) expect(body).toMatchObject({ label: 'workspace-a' })
})

it('applies a saved preference after an older workspace configuration already in progress', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const entered = deferred(), release = deferred()
  const handle = f.computers[1]!.handle.bind(f.computers[1]!)
  vi.spyOn(f.computers[1]!, 'handle').mockImplementation(async (raw, options) => {
    const input = SyncChannelRequestSchema.shape.request.parse(raw)
    if (input.operation === 'configure' && input.enabled) {
      entered.resolve()
      await release.promise
    }
    return handle(raw, options)
  })
  const reconciling = f.service.reconcile()
  await entered.promise
  const updating = f.service.update(f.writer, 'mcp', { target: f.targets[1], workspaceId: 'workspace-a', enabled: false })
  try {
    await vi.waitFor(() => expect([...f.preferences.values()]).toContainEqual(expect.objectContaining({ enabled: false })))
  } finally { release.resolve() }
  await Promise.all([reconciling, updating])
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: workerSyncId }],
  })])
})

it('bounds workspace setup so shared-file sync leaves device slots for foreground work', async () => {
  const f = await fixture()
  for (let index = 0; index < 12; index++) f.workspaces.push({ id: `workspace-extra-${index}`, name: 'Extra', active: true })
  const active = new Map<string, number>()
  const maximum = new Map<string, number>()
  const priorities: unknown[] = []
  const request = f.endpoint.request
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (deviceId, namespace, payload, options) => {
    priorities.push(options?.priority)
    const count = (active.get(deviceId) ?? 0) + 1
    active.set(deviceId, count)
    maximum.set(deviceId, Math.max(maximum.get(deviceId) ?? 0, count))
    try { return await request(deviceId, namespace, payload, options) }
    finally { active.set(deviceId, count - 1) }
  })
  await f.service.poll()
  expect([...maximum.values()]).toEqual([2, 2])
  expect(priorities.length).toBeGreaterThan(12)
  expect(new Set(priorities)).toEqual(new Set(['background']))
})

it('backs off shared-file polling failures and resets on success', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  const query = vi.spyOn(f.pool, 'query').mockRejectedValue(new Error('Query read timeout'))
  await expect(f.service.poll()).rejects.toThrow('Query read timeout')
  for (let attempt = 1; attempt <= 6; attempt++) {
    vi.setSystemTime(Date.now() + Math.min(300_000, 30_000 * 2 ** (attempt - 1)) - 1)
    await expect(f.service.poll()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 1)
    await expect(f.service.poll()).rejects.toThrow('Query read timeout')
    expect(query).toHaveBeenCalledTimes(attempt + 1)
  }
  query.mockRestore()
  vi.setSystemTime(Date.now() + 300_000)
  await f.service.poll()
  const failedAgain = vi.spyOn(f.pool, 'query').mockRejectedValue(new Error('Query read timeout'))
  await expect(f.service.poll()).rejects.toThrow('Query read timeout')
  vi.setSystemTime(Date.now() + 29_999)
  await expect(f.service.poll()).resolves.toBeUndefined()
  expect(failedAgain).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 1)
  await expect(f.service.poll()).rejects.toThrow('Query read timeout')
  expect(failedAgain).toHaveBeenCalledTimes(2)
})
