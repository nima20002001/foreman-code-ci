import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { SyncComputerRequestSchema, SyncComputerStateSchema, SyncIdentitySchema,
  type SyncComputerRequest, type SyncComputerState, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { systemSyncthingPorts, type SyncthingPorts } from './syncthingSystem.js'

export function sharedFolderId(workspaceId: string): string {
  return `workspace-${createHash('sha256').update(workspaceId).digest('hex')}`
}
const FolderSchema = z.object({ id: z.string(), label: z.string(), path: z.string(),
  devices: z.array(z.object({ deviceID: z.string() })), paused: z.boolean().optional() }).passthrough()
const StatusSchema = z.object({ state: z.string(), pullErrors: z.number().optional(), error: z.string().optional() })
interface StatusOptions { signal?: AbortSignal | undefined; workspaceId?: string | undefined }
const CONFLICT_REFRESH_MS = 300_000
const CONFLICT_SCAN_MS = 10_000
const ConnectionsSchema = z.object({ connections: z.record(z.string(), z.object({ connected: z.boolean() })) })

/** One app-managed instance. Its keys and REST endpoint remain on this computer. */
export class SyncthingComputer {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly conflicts = new Map<string, string[]>()
  private scanning = false
  private nextConflictScan = 0
  constructor(private readonly ports: SyncthingPorts = systemSyncthingPorts()) {}

  handle(raw: unknown, options: { assertCurrent?: () => void; signal?: AbortSignal } = {}):
    Promise<SyncIdentity | SyncComputerState> {
    const request = SyncComputerRequestSchema.parse(raw)
    const assertCurrent = () => {
      options.signal?.throwIfAborted()
      options.assertCurrent?.()
    }
    assertCurrent()
    options.signal?.throwIfAborted()
    if (request.operation === 'status') return this.status({ signal: options.signal, workspaceId: request.workspaceId })
    const task = this.pending.then(async () => {
      assertCurrent()
      if (request.operation === 'configure' && !request.enabled
        && !(await this.ports.available(options.signal)).running) return this.status({ signal: options.signal, workspaceId: request.workspaceId })
      const identity = await this.ports.prepare(options.signal, assertCurrent)
      assertCurrent()
      if (request.operation === 'identity') return identity
      await this.configure(identity, request, assertCurrent, options.signal)
      return this.status({ signal: options.signal, workspaceId: request.workspaceId })
    })
    this.pending = task.then(() => undefined, () => undefined)
    return task
  }

  private async configure(identity: SyncIdentity, input: Extract<SyncComputerRequest, { operation: 'configure' }>,
    assertCurrent: () => void, signal?: AbortSignal) {
    const { workspaceId, enabled, peers } = input
    const id = sharedFolderId(workspaceId)
    const folders = z.array(FolderSchema).parse(await this.ports.rest('GET', '/rest/config/folders', undefined, signal))
    if (!enabled) {
      const existing = folders.find(folder => folder.id === id)
      if (existing) {
        assertCurrent()
        await this.ports.rest('POST', '/rest/config/folders', {
          ...existing, paused: true, devices: [{ deviceID: identity.deviceId }],
        }, signal)
      }
      return
    }
    for (const peer of peers) {
      assertCurrent()
      const template = z.record(z.string(), z.unknown()).parse(await this.ports.rest('GET', '/rest/config/defaults/device', undefined, signal))
      assertCurrent()
      await this.ports.rest('POST', '/rest/config/devices', { ...template, deviceID: peer.deviceId,
        addresses: [`tcp://${peer.address}:22001`], introducer: false, autoAcceptFolders: false, paused: false }, signal)
    }
    const path = join(identity.rootPath, id)
    assertCurrent()
    await this.ports.mkdir(path, signal)
    const existing = folders.find(folder => folder.id === id)
    const template = existing ?? z.record(z.string(), z.unknown()).parse(await this.ports.rest('GET', '/rest/config/defaults/folder', undefined, signal))
    assertCurrent()
    // An enabled offline computer may not have a saved identity yet.
    const retained = input.preserveUnknownPeers
      ? (existing?.devices ?? []).filter(device => !input.knownPeerIds?.includes(device.deviceID)) : []
    const deviceIds = new Set([identity.deviceId, ...retained.map(peer => peer.deviceID), ...peers.map(peer => peer.deviceId)])
    await this.ports.rest('POST', '/rest/config/folders', {
      ...template, id, label: workspaceId, path, type: 'sendreceive', paused: false,
      devices: [...deviceIds].map(deviceID => ({ deviceID })),
      versioning: { type: 'simple', params: { keep: '5' }, cleanupIntervalS: 3600 },
    }, signal)
  }

  async status(options: StatusOptions = {}): Promise<SyncComputerState> {
    const { signal } = options
    signal?.throwIfAborted()
    if (!signal) return this.readStatus(options)
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void this.readStatus(options).then(value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }, error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      })
    })
  }

  private scanConflicts(folders: z.infer<typeof FolderSchema>[]): void {
    if (this.scanning || Date.now() < this.nextConflictScan) return
    this.scanning = true
    this.nextConflictScan = Date.now() + CONFLICT_REFRESH_MS
    const signal = AbortSignal.timeout(CONFLICT_SCAN_MS)
    const scan = async () => {
      const paths = new Set(folders.map(folder => folder.path))
      for (const path of this.conflicts.keys()) {
        if (!paths.has(path)) this.conflicts.delete(path)
      }
      for (const folder of folders) {
        signal.throwIfAborted()
        const names = await this.ports.conflicts(folder.path, signal)
        signal.throwIfAborted()
        this.conflicts.set(folder.path, names.slice(0, 100))
      }
    }
    void scan().catch(error => {
      logIgnoredError('lifecycle', 'scan shared file conflicts', error, { nextRetryMs: CONFLICT_REFRESH_MS })
    }).finally(() => { this.scanning = false })
  }

  private async readStatus({ signal, workspaceId }: StatusOptions): Promise<SyncComputerState> {
    const available = await this.ports.available(signal)
    signal?.throwIfAborted()
    if (!available.installed || !available.running) {
      return SyncComputerStateSchema.parse({ ...available, deviceId: null, folders: [], message: null })
    }
    const identity = z.object({ myID: SyncIdentitySchema.shape.deviceId }).parse(
      await this.ports.rest('GET', '/rest/system/status', undefined, signal))
    signal?.throwIfAborted()
    const folders = z.array(FolderSchema).parse(
      await this.ports.rest('GET', '/rest/config/folders', undefined, signal))
    signal?.throwIfAborted()
    const connections = ConnectionsSchema.parse(
      await this.ports.rest('GET', '/rest/system/connections', undefined, signal)).connections
    signal?.throwIfAborted()
    const selected = folders.filter(folder => !folder.paused && /^workspace-[a-f0-9]{64}$/u.test(folder.id)
      && (workspaceId === undefined || folder.id === sharedFolderId(workspaceId)))
    if (workspaceId === undefined) this.scanConflicts(selected)
    const states = await Promise.all(selected
      .map(async folder => {
        signal?.throwIfAborted()
        const status = StatusSchema.parse(
          await this.ports.rest('GET', `/rest/db/status?folder=${folder.id}`, undefined, signal))
        signal?.throwIfAborted()
        const peers = folder.devices.filter(device => device.deviceID !== identity.myID)
        const conflicts = this.conflicts.get(folder.path) ?? []
        signal?.throwIfAborted()
        let state: 'idle' | 'syncing' | 'error' = status.state === 'idle' ? 'idle' : 'syncing'
        if (status.state === 'error' || status.pullErrors || status.error) state = 'error'
        return { workspaceId: folder.label, path: folder.path, state, conflicts,
          connected: peers.length > 0 && peers.every(peer => connections[peer.deviceID]?.connected === true),
          message: status.error?.slice(0, 500) ?? (status.pullErrors ? `${status.pullErrors} files failed to sync.` : null) }
      }))
    return SyncComputerStateSchema.parse({ installed: true, running: true, deviceId: identity.myID,
      folders: states, message: null })
  }
}
