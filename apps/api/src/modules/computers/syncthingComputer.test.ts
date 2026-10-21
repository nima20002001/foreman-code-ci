import { deferred } from '../../../test/helpers/deferred.js'
import { afterEach, expect, it, vi } from 'vitest'
import { SyncComputerStateSchema, SyncIdentitySchema } from '@foreman-code/contracts/computer-accounts'
import { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'
import { fakeSyncthing, workerSyncId } from '../../../test/helpers/syncthing.js'

const fixtures: Awaited<ReturnType<typeof fakeSyncthing>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); vi.restoreAllMocks(); vi.useRealTimers() })
async function fixture() {
  const rest = await fakeSyncthing()
  fixtures.push(rest)
  return { ...rest, computer: new SyncthingComputer(rest.ports) }
}
const peer = { deviceId: workerSyncId, address: '100.64.0.20' }

it('installs automatically and configures only explicit Tailscale peers with local folders and versioning', async () => {
  const f = await fixture()
  expect(await f.computer.handle({ operation: 'status' })).toMatchObject({ installed: false, running: false })
  expect(SyncIdentitySchema.parse(await f.computer.handle({ operation: 'identity' }))).toEqual(f.identity)
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace-a', enabled: true, peers: [peer] })
  expect(await f.rest('GET', '/rest/config/options')).toMatchObject({ globalAnnounceEnabled: false,
    relaysEnabled: false, localAnnounceEnabled: false, listenAddresses: ['tcp://100.64.0.1:22001'] })
  expect(await f.rest('GET', '/rest/config/devices')).toEqual([expect.objectContaining({ deviceID: workerSyncId,
    addresses: ['tcp://100.64.0.20:22001'], introducer: false, autoAcceptFolders: false })])
  const path = `/main/shared/${sharedFolderId('workspace-a')}`
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({ id: sharedFolderId('workspace-a'),
    path, type: 'sendreceive', devices: [{ deviceID: f.identity.deviceId }, { deviceID: workerSyncId }],
    versioning: { type: 'simple', params: { keep: '5' }, cleanupIntervalS: 3600 } })])
  expect(f.directories.has(path)).toBe(true)
})

it('keeps workspace identities separate, replaces membership and disconnects without deleting local files', async () => {
  const f = await fixture()
  for (const workspaceId of ['workspace-a', 'workspace-b']) {
    await f.computer.handle({ operation: 'configure', workspaceId, enabled: true, peers: [peer] })
  }
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace-a', enabled: true, peers: [] })
  const folders = await f.rest('GET', '/rest/config/folders') as { id: string; devices: unknown[] }[]
  expect(folders.find(folder => folder.id === sharedFolderId('workspace-a'))?.devices).toEqual([{ deviceID: f.identity.deviceId }])
  expect(folders.find(folder => folder.id === sharedFolderId('workspace-b'))?.devices).toHaveLength(2)
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace-a', enabled: false, peers: [] })
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), paused: true, devices: [{ deviceID: f.identity.deviceId }] }),
    expect.objectContaining({ id: sharedFolderId('workspace-b'), paused: false, devices: [{ deviceID: f.identity.deviceId }, { deviceID: workerSyncId }] }),
  ])
  expect(f.directories.has(`/main/shared/${sharedFolderId('workspace-a')}`)).toBe(true)
})

it('shares a workspace with more than 100 participating computers', async () => {
  const f = await fixture()
  const peers = Array.from({ length: 101 }, (_, index) => {
    const suffix = index.toString(2).padStart(7, '0').replaceAll('0', 'D').replaceAll('1', 'E')
    return { deviceId: [...Array<string>(7).fill('DDDDDDD'), suffix].join('-'), address: `100.64.1.${index + 1}` }
  })
  await f.computer.handle({ operation: 'configure', workspaceId: 'large-workspace', enabled: true, peers })
  const folders = await f.rest('GET', '/rest/config/folders') as { devices: { deviceID: string }[] }[]
  expect(folders[0]!.devices).toEqual([
    { deviceID: f.identity.deviceId }, ...peers.map(value => ({ deviceID: value.deviceId })),
  ])
})

it('reports connectivity, syncing, errors and conflicts and retains prior configuration after failed updates', async () => {
  const f = await fixture()
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: true, peers: [peer] })
  f.connections[workerSyncId] = { connected: true }
  f.states.set(sharedFolderId('workspace'), { state: 'syncing' })
  f.conflicts.set(`/main/shared/${sharedFolderId('workspace')}`, ['nested/file.sync-conflict-20261008.txt'])
  await vi.waitFor(async () => {
    expect(SyncComputerStateSchema.parse(await f.computer.handle({ operation: 'status' })).folders[0])
      .toMatchObject({ connected: true, state: 'syncing', conflicts: ['nested/file.sync-conflict-20261008.txt'] })
  })
  f.states.set(sharedFolderId('workspace'), { state: 'error', pullErrors: 2 })
  expect(SyncComputerStateSchema.parse(await f.computer.handle({ operation: 'status' })).folders[0])
    .toMatchObject({ state: 'error', message: '2 files failed to sync.' })
  f.failConfiguration(true)
  await expect(f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: false, peers: [] })).rejects.toThrow()
  f.failConfiguration(false)
  expect(await f.rest('GET', '/rest/config/folders')).toHaveLength(1)
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: false, peers: [] })
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace'), paused: true, devices: [{ deviceID: f.identity.deviceId }],
  })])
})

it('serializes enable and disable so a delayed enable cannot undo the later disable', async () => {
  const f = await fixture()
  const enabled = f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: true, peers: [peer] })
  const disabled = f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: false, peers: [] })
  await Promise.all([enabled, disabled])
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace'), paused: true, devices: [{ deviceID: f.identity.deviceId }],
  })])
  expect(SyncComputerStateSchema.parse(await f.computer.handle({ operation: 'status' })).folders).toEqual([])
  f.stop()
  expect(await f.computer.handle({ operation: 'status' })).toMatchObject({ installed: true, running: false, folders: [] })
})

it('refuses arbitrary network addresses and path traversal workspace ids at the public boundary', async () => {
  const f = await fixture()
  await expect(async () => f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: true,
    peers: [{ ...peer, address: '8.8.8.8' }] })).rejects.toThrow()
  // IDs are hashed before they form paths, even when punctuation is allowed by the domain ID contract.
  await f.computer.handle({ operation: 'configure', workspaceId: '../same/name', enabled: true, peers: [] })
  expect([...f.directories]).toEqual([`/main/shared/${sharedFolderId('../same/name')}`])
})

it('cancels queued local configuration before preparation or any folder write', async () => {
  const f = await fixture()
  const entered = deferred(), release = deferred()
  const prepare = f.ports.prepare.bind(f.ports)
  let preparations = 0
  f.ports.prepare = async () => { preparations++; entered.resolve(); await release.promise; return prepare() }
  const first = f.computer.handle({ operation: 'identity' })
  await entered.promise
  const abort = new AbortController()
  const queued = f.computer.handle({ operation: 'configure', workspaceId: 'canceled', enabled: true, peers: [] },
    { signal: abort.signal }).then(() => undefined, error => error)
  abort.abort(new Error('Sync closing'))
  release.resolve()
  await first
  expect(await queued).toBe(abort.signal.reason)
  expect(preparations).toBe(1)
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([])
})

it('cancels configuration during preparation before publishing folders', async () => {
  const f = await fixture()
  const abort = new AbortController()
  const reason = new Error('Sync closing')
  const prepare = f.ports.prepare.bind(f.ports)
  f.ports.prepare = async () => {
    const identity = await prepare()
    abort.abort(reason)
    return identity
  }
  await expect(f.computer.handle({ operation: 'configure', workspaceId: 'canceled', enabled: true, peers: [] },
    { signal: abort.signal })).rejects.toBe(reason)
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([])
})


it('keeps configuration and scoped folder reads independent of conflict scans', async () => {
  const f = await fixture()
  const scans = vi.spyOn(f.ports, 'conflicts')
  for (const workspaceId of ['workspace-a', 'workspace-b']) {
    await f.computer.handle({ operation: 'configure', workspaceId, enabled: true, peers: [] })
  }
  const state = SyncComputerStateSchema.parse(await f.computer.handle({ operation: 'status', workspaceId: 'workspace-a' }))
  expect(state.folders.map(folder => folder.workspaceId)).toEqual(['workspace-a'])
  expect(scans).not.toHaveBeenCalled()
})

it('returns status during a pending background scan and caches conflicts for five minutes', async () => {
  const f = await fixture()
  await f.computer.handle({ operation: 'configure', workspaceId: 'workspace', enabled: true, peers: [] })
  const entered = deferred(), release = deferred()
  const names = ['copy.sync-conflict-20261008.txt']
  const scans = vi.spyOn(f.ports, 'conflicts').mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return names
  })
  const status = f.computer.handle({ operation: 'status' })
  try {
    await entered.promise
    const completed = vi.fn()
    void status.then(completed)
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
  } finally { release.resolve(); await status }
  await vi.waitFor(async () => {
    expect(SyncComputerStateSchema.parse(await f.computer.handle({ operation: 'status' })).folders[0]?.conflicts)
      .toEqual(names)
  })
  for (let index = 0; index < 3; index++) await f.computer.handle({ operation: 'status' })
  expect(scans).toHaveBeenCalledOnce()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.advanceTimersByTime(300_000)
  await f.computer.handle({ operation: 'status' })
  await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(2))
})
