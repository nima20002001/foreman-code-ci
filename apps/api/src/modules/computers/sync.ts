import { RetryBackoff } from '../../infrastructure/retryBackoff.js'
import { isDeepStrictEqual } from 'node:util'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type pg from 'pg'
import { COMPUTER_SYNC_NAMESPACE, ComputerSyncReadInputSchema, ComputerSyncStatusSchema, ComputerSyncUpdateInputSchema,
  SyncComputerStateSchema, SyncIdentitySchema, type ComputerSyncStatus, type SyncComputerRequest,
  type SyncComputerState, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { assertBuildComputerTarget, buildComputerKey } from '../settings/buildComputers.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { SyncthingComputer } from './syncthingComputer.js'
import { SyncRepository, type SyncWorkspace, type SyncComputerIdentity } from './syncRepository.js'

export class ComputerSyncService {
  private readonly repository: SyncRepository
  private identities: SyncComputerIdentity[] = []
  private readonly identityRequests = new Map<string, { target: DeviceProvisioningTarget; request: Promise<SyncIdentity> }>()
  private knownPeerIds = new Set<string>()
  private readonly lifetime = new AbortController()
  private readonly reconciliations = new Map<string, Promise<unknown[]>>()
  private readonly workspaceRequests = new Map<string, Promise<unknown[]>>()
  private queued = 0
  private readonly pollRetry = new RetryBackoff({ initialMs: 30_000, maxMs: 300_000 })
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: Pick<SyncthingComputer, 'handle'> = new SyncthingComputer(),
    private readonly assertCurrent: () => void = () => {}) {
    this.repository = new SyncRepository(pool, mainId)
  }

  async read(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerSyncStatus> {
    return this.readAuthorized(principal, source, 'settings:read', raw)
  }

  private async readAuthorized(principal: ManagementPrincipal, source: 'http' | 'mcp',
    action: 'settings:read' | 'settings:update', raw: unknown): Promise<ComputerSyncStatus> {
    const { target } = ComputerSyncReadInputSchema.parse(raw)
    await this.authorize(principal, source, action, target)
    let state: SyncComputerState
    let unavailable = false
    try { state = SyncComputerStateSchema.parse(await this.computer(target, { operation: 'status' })) } catch (error) {
      unavailable = true
      state = { installed: false, running: false, deviceId: null, folders: [],
        message: error instanceof Error ? error.message.slice(0, 500) : 'Sync status is unavailable.' }
    }
    const folders = await Promise.all((await this.repository.workspaces()).filter(workspace => workspace.active).map(async workspace => ({
      workspaceId: workspace.id, name: workspace.name,
      participating: workspace.targets.some(member => sameDeviceProvisioningTarget(member, target)),
      ...await this.repository.preference(this.pool, workspace.id, target),
      status: state.folders.find(folder => folder.workspaceId === workspace.id) ?? null,
    })))
    await this.authorize(principal, source, action, target)
    return ComputerSyncStatusSchema.parse({ target, installed: unavailable ? null : state.installed,
      running: unavailable ? null : state.running,
      message: state.message, folders })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerSyncStatus> {
    const input = ComputerSyncUpdateInputSchema.parse(raw)
    await this.authorize(principal, source, 'settings:update', input.target)
    await this.commands.execute({ principal, source, commandId: input.commandId,
      operation: 'computer_sync_update', targetKey: `${input.workspaceId}:${buildComputerKey(input.target)}`, payload: input,
      authorize: async sql => {
        requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update')
        await this.assertTarget(sql, input.target)
        const workspace = (await sql.query('select id from workspaces where id=$1 for share', [input.workspaceId])).rows[0]
        if (!workspace) throw new DomainError('NOT_FOUND', 'Workspace not found.', 404)
      },
      perform: async sql => {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`computer-sync:${input.workspaceId}`])
        const previous = await this.repository.preference(sql, input.workspaceId, input.target)
        if (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Sync settings changed. Refresh before saving again.', 409)
        }
        const preference = { revision: previous.revision + 1, enabled: input.enabled }
        await this.repository.save(sql, input.workspaceId, input.target, preference, principal.id)
        return preference
      },
    })
    // The preference is committed before external configuration; reconnect retries the saved desired state.
    let message: string | null = null
    try {
      await this.workspaceRequests.get(input.workspaceId)
      await this.reconciliations.get(`workspace:${input.workspaceId}`)
      const failures = await this.synchronize(undefined, input.workspaceId)
      if (failures.length) throw new AggregateError(failures, 'Shared file setup is pending on an unavailable computer.')
    } catch (error) {
      message = error instanceof Error ? error.message.slice(0, 500) : 'Sync setup will retry when this computer reconnects.'
    }
    const status = await this.readAuthorized(principal, source, 'settings:update', { target: input.target })
    return { ...status, message: message ?? status.message }
  }

  stopAdmission(): void {
    this.lifetime.abort(new DomainError('SYNC_CLOSING', 'Shared file sync is shutting down.', 503))
  }

  async join(): Promise<void> { await Promise.allSettled(this.reconciliations.values()) }

  private assertOpen(): void {
    this.lifetime.signal.throwIfAborted()
    this.assertCurrent()
  }

  async reconcile(target?: DeviceProvisioningTarget): Promise<void> {
    const failures = await this.synchronize(target)
    if (failures.length) throw new AggregateError(failures, 'Shared file setup is pending on an unavailable computer.')
  }

  poll(): Promise<void> {
    if (this.lifetime.signal.aborted || this.queued || !this.pollRetry.ready()) return Promise.resolve()
    return this.reconcile().then(() => {
      this.pollRetry.reset()
    }).catch(error => {
      const nextRetryMs = this.pollRetry.fail()
      logIgnoredError('lifecycle', 'synchronize shared files', error, { nextRetryMs })
      throw error
    })
  }

  private synchronize(target?: DeviceProvisioningTarget, workspaceId?: string): Promise<unknown[]> {
    this.assertOpen()
    let key = 'all'
    if (target) key = buildComputerKey(target)
    if (workspaceId) key = `workspace:${workspaceId}`
    const existing = this.reconciliations.get(key)
    if (existing) return existing
    this.queued++
    const task = (async () => {
      if (target) await this.assertTarget(this.pool, target)
      this.assertOpen()
      for (const peer of await this.repository.identities()) {
        if (!this.identities.some(value => sameDeviceProvisioningTarget(value.target, peer.target))) {
          this.identities.push(peer)
        }
        this.knownPeerIds.add(peer.identity.deviceId)
      }
      const workspaces = (await this.repository.workspaces()).filter(workspace =>
        workspaceId === undefined || workspace.id === workspaceId)
      const failures: unknown[] = []
      const computers = await this.repository.computers()
      let nextWorkspace = 0
      const configureNext = async () => {
        while (nextWorkspace < workspaces.length) {
          const workspace = workspaces[nextWorkspace++]!
          try {
            const pending = this.workspaceRequests.get(workspace.id)
            if (pending) {
              failures.push(...await pending)
              continue
            }
            const request = this.configureWorkspace(workspace, computers)
              .finally(() => this.workspaceRequests.delete(workspace.id))
            this.workspaceRequests.set(workspace.id, request)
            failures.push(...await request)
          } catch (error) {
            failures.push(error)
          }
        }
      }
      // A stalled peer occupies one task while healthy workspaces continue through the other.
      await Promise.all(Array.from({ length: Math.min(2, workspaces.length) }, configureNext))
      return failures
    })().finally(() => {
      this.queued--
      this.reconciliations.delete(key)
    })
    this.reconciliations.set(key, task)
    return task
  }

  async paired(target: DeviceProvisioningTarget): Promise<void> {
    await this.reconcile(target)
  }

  async sharedFolder(workspaceId: string, host: { kind: 'main' } | { kind: 'device'; deviceId: string }): Promise<string | null> {
    const workspace = (await this.repository.workspaces()).find(value => value.id === workspaceId)
    const target = workspace?.targets.find(value => host.kind === 'main' ? value.hostRef.kind === 'main'
      : value.hostRef.kind === 'device' && value.hostRef.deviceId === host.deviceId)
    if (!workspace || !target || !(await this.repository.preference(this.pool, workspaceId, target)).enabled) return null
    if (!(await this.repository.preference(this.pool, workspaceId, this.repository.mainTarget)).enabled) return null
    // Native context reads must remain usable while optional shared-file setup is pending or the computer is slow.
    const bound = AbortSignal.timeout(10_000)
    try {
      const state = SyncComputerStateSchema.parse(await this.computer(target, { operation: 'status', workspaceId }, bound))
      return state.folders.find(folder => folder.workspaceId === workspaceId)?.path ?? null
    } catch (error) {
      if (bound.aborted || this.lifetime.signal.aborted) return null
      if (error instanceof DomainError && ['COMPUTER_OFFLINE', 'SYNC_UNAVAILABLE'].includes(error.code)) return null
      if (error instanceof DeviceApplicationError && error.retryable) return null
      throw error
    }
  }

  private async configureWorkspace(workspace: SyncWorkspace, computers: DeviceProvisioningTarget[]) {
    this.assertOpen()
    const main = this.repository.mainTarget
    const mainEnabled = workspace.active && (await this.repository.preference(this.pool, workspace.id, main)).enabled
    const members = await Promise.all(computers.map(async target => ({ target,
      enabled: mainEnabled && workspace.targets.some(member => sameDeviceProvisioningTarget(member, target))
        && (await this.repository.preference(this.pool, workspace.id, target)).enabled })))
    const failures: unknown[] = []
    const identities = new Map(members.filter(member => member.enabled).map(member =>
      [buildComputerKey(member.target), this.identity(member.target).then(identity => ({ identity }), error => ({ error }))]))
    const hubRequest = identities.get(buildComputerKey(main))
    const configure = async (member: typeof members[number]) => {
      const known = members.flatMap(candidate => {
        const peer = this.identities.find(value => sameDeviceProvisioningTarget(value.target, candidate.target))
        return candidate.enabled && peer ? [peer] : []
      })
      const hub = known.find(peer => peer.target.hostRef.kind === 'main')
      const missingIdentity = members.some(candidate => candidate.enabled
        && !known.some(peer => sameDeviceProvisioningTarget(peer.target, candidate.target)))
      let peers: SyncIdentity[] = []
      if (member.target.hostRef.kind === 'main') {
        peers = known.filter(peer => peer.target.hostRef.kind === 'device').map(peer => peer.identity)
      } else if (hub) {
        peers = [hub.identity]
      }
      await this.computer(member.target, { operation: 'configure', workspaceId: workspace.id,
        enabled: member.enabled, peers: peers.map(({ deviceId, address }) => ({ deviceId, address })),
        preserveUnknownPeers: member.target.hostRef.kind === 'main' && missingIdentity,
        knownPeerIds: [...this.knownPeerIds] })
    }
    await Promise.all(members.map(async member => {
      try {
        this.assertOpen()
        if (member.enabled) {
          const selected = await identities.get(buildComputerKey(member.target))!
          if ('error' in selected) throw selected.error
          const hub = await hubRequest
          if (!hub || 'error' in hub) return
        }
        await configure(member)
        // Each newly available Worker also updates Main, without waiting for unavailable peers.
        if (member.enabled && member.target.hostRef.kind === 'device') {
          await configure({ target: main, enabled: true })
        }
      } catch (error) { failures.push(error) }
    }))
    return failures
  }

  private identity(target: DeviceProvisioningTarget): Promise<SyncIdentity> {
    const key = buildComputerKey(target)
    const pending = this.identityRequests.get(key)
    if (pending && sameDeviceProvisioningTarget(pending.target, target)) return pending.request
    const request = this.refreshIdentity(target).finally(() => {
      if (this.identityRequests.get(key)?.request === request) this.identityRequests.delete(key)
    })
    this.identityRequests.set(key, { target, request })
    return request
  }

  private async refreshIdentity(target: DeviceProvisioningTarget): Promise<SyncIdentity> {
    const identity = SyncIdentitySchema.parse(await this.computer(target, { operation: 'identity' }))
    const cached = this.identities.find(peer => sameDeviceProvisioningTarget(peer.target, target))
    if (cached && isDeepStrictEqual(cached.identity, identity)) return identity
    await this.repository.saveIdentity(target, identity)
    if (cached) cached.identity = identity
    else this.identities.push({ target, identity })
    this.knownPeerIds.add(identity.deviceId)
    return identity
  }
  private async computer(target: DeviceProvisioningTarget, request: SyncComputerRequest,
    signal = AbortSignal.timeout(150_000)): Promise<unknown> {
    this.assertOpen()
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    await this.assertTarget(this.pool, target)
    this.assertOpen()
    signal.throwIfAborted()
    if (target.hostRef.kind === 'main') return this.local.handle(request, { signal, assertCurrent: () => this.assertOpen() })
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(target.hostRef.deviceId).some(value => value.namespace === COMPUTER_SYNC_NAMESPACE
      && value.mainCanRequest)) throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or needs an app update.', 409)
    return (await endpoint.request(target.hostRef.deviceId, COMPUTER_SYNC_NAMESPACE, { target, request },
      { signal, timeoutMs: 150_000, priority: request.operation === 'status' ? 'foreground' : 'background' })).payload
  }
  private async assertTarget(sql: Pick<pg.Pool, 'query'>, target: DeviceProvisioningTarget) {
    if (target.hostRef.mainId !== this.mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'Computer belongs to another Main.', 404)
    await assertBuildComputerTarget(sql, target)
  }
  private async authorize(principal: ManagementPrincipal, source: 'http' | 'mcp',
    action: 'settings:read' | 'settings:update', target: DeviceProvisioningTarget) {
    try {
      requireAuthorization(principal, action)
      const sql = await this.pool.connect()
      try {
        requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
        await this.assertTarget(sql, target)
      } finally { sql.release() }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ACCESS_DENIED') {
        await this.commands.recordDenied(principal.id, source,
          action === 'settings:read' ? 'computer_sync_status' : 'computer_sync_update', buildComputerKey(target))
      }
      throw error
    }
  }
}
