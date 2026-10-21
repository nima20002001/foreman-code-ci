import { randomUUID } from 'node:crypto'
import { BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserLoginEvidenceSchema } from '@foreman-code/contracts/browser-profiles'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { browserInputHash, browserOrigin, browserPageCursor, browserPageLimit, readBrowserCursor } from './identity.js'
import type { BrowserProfile, BrowserProfileReplica, BrowserProfileSyncJob, BrowserProfileRepository, BrowserProfileTransaction,
  BrowserProfileAuthority, BrowserProfileHost, BrowserCommandOptions, BrowserCommandReceipt,
  BrowserPage, ProfileHostIntent } from './types.js'

export function newBrowserReplica(profileId: string, computerId: string): BrowserProfileReplica {
  return { profileId, computerId, desiredSnapshot: null, receivedSnapshot: null, appliedSnapshot: null,
    transfer: 'missing', loginEvidence: [], localOverride: false, lastSeenAt: null, reason: null }
}

export async function requireBrowserProfile(tx: BrowserProfileTransaction, id: string): Promise<BrowserProfile> {
  const value = await tx.profile(id)
  if (!value || value.deleted) throw new DomainError('NOT_FOUND', 'Browser profile not found.', 404)
  return value.profile
}

export function checkBrowserRevision(profile: BrowserProfile, expected: number | undefined): void {
  if (expected !== undefined && expected !== profile.revision) {
    throw new DomainError('REVISION_CONFLICT', 'The browser profile changed. Refresh it before saving.', 409)
  }
}

export interface BrowserProfileServiceOptions {
  repository: BrowserProfileRepository
  authority: BrowserProfileAuthority
  host: BrowserProfileHost
  now?: () => string
  id?: () => string
}

export class BrowserProfileService {
  readonly repository: BrowserProfileRepository
  readonly authority: BrowserProfileAuthority
  readonly host: BrowserProfileHost
  readonly now: () => string
  readonly id: () => string
  private readonly workListeners = new Set<() => void>()
  onWork(listener: () => void): () => void { this.workListeners.add(listener); return () => this.workListeners.delete(listener) }

  constructor(options: BrowserProfileServiceOptions) {
    this.repository = options.repository; this.authority = options.authority; this.host = options.host
    this.now = options.now ?? (() => new Date().toISOString()); this.id = options.id ?? randomUUID
  }

  async command<T, Input extends BrowserCommandOptions>(principal: ManagementPrincipal, operation: string, input: Input,
    computers: readonly string[], locks: readonly string[], perform: (tx: BrowserProfileTransaction) => Promise<T>): Promise<BrowserCommandReceipt<T>> {
    const commandId = input.commandId ?? this.id()
    const key = `${principal.id}:${operation}:${commandId}`
    const hash = browserInputHash({ ...input, commandId })
    await this.authority.authorize(principal, 'settings:update', computers)
    const receipt = await this.repository.transaction([`command:${key}`, ...locks], async tx => {
      await this.authority.authorize(principal, 'settings:update', computers, tx.sql)
      const previous = await tx.command(key)
      if (previous) {
        if (previous.hash !== hash) throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID belongs to different input.', 409)
        return { commandId, value: previous.result as T, replayed: true }
      }
      const value = await perform(tx)
      await tx.putCommand(key, { hash, result: value })
      return { commandId, value, replayed: false }
    })
    for (const listener of this.workListeners) listener()
    return receipt
  }

  async list(principal: ManagementPrincipal, input: { cursor?: string; limit?: number } = {}): Promise<BrowserPage<BrowserProfile>> {
    await this.authority.authorize(principal, 'settings:read', [])
    const limit = browserPageLimit(input.limit), after = readBrowserCursor(input.cursor, 'browser-profiles')
    const { rows, revision } = await this.repository.read(async tx => ({
      rows: await tx.profiles(after, limit + 1), revision: await tx.catalogRevision(),
    }))
    const items = rows.slice(0, limit).map(row => row.profile)
    return { items, hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? browserPageCursor('browser-profiles', items.at(-1)!.id) : null,
      revision }
  }

  async get(principal: ManagementPrincipal, profileId: string): Promise<{ profile: BrowserProfile; replicas: BrowserProfileReplica[]; operations: ProfileHostIntent[] }> {
    await this.authority.authorize(principal, 'settings:read', [])
    const result = await this.repository.read(async tx => ({ profile: await requireBrowserProfile(tx, profileId),
      replicas: await tx.replicas(profileId), operations: await tx.intents(profileId) }))
    await this.authority.authorize(principal, 'settings:read', result.replicas.map(replica => replica.computerId))
    return result
  }

  async catalog(principal: ManagementPrincipal, input: { cursor?: string; limit?: number; computerId?: string } = {}) {
    await this.authority.authorize(principal, 'settings:read', input.computerId ? [input.computerId] : [])
    const visible = (await this.authority.computers(principal)).map(value => value.id)
      .filter(value => !input.computerId || value === input.computerId)
    const limit = browserPageLimit(input.limit), cursor = readBrowserCursor(input.cursor, 'browser-catalog')
    const after: unknown = cursor ? JSON.parse(cursor) : undefined
    if (after !== undefined && (!Array.isArray(after) || after.length !== 2 || after.some(value => typeof value !== 'string'))) {
      throw new DomainError('CURSOR_INVALID', 'Invalid browser catalog cursor.', 400)
    }
    return this.repository.read(async tx => {
      const rows = await tx.catalogRows(after as [string, string] | undefined, visible, limit + 1), page = rows.slice(0, limit)
      const profiles = [...new Map(page.map(row => [row.profile.id, row.profile])).values()]
      const replicas = page.flatMap(row => row.replica ? [row.replica] : [])
      const presentReplicas = page.filter(row => row.replica && row.facts.present)
        .map(row => ({ profileId: row.profile.id, computerId: row.computerId }))
      const pendingReplicas = page.flatMap(row => {
        const intent = row.facts.currentIntent
        return intent && (intent.state === 'queued' || intent.state === 'running')
          ? [{ profileId: row.profile.id, computerId: row.computerId, operation: intent.operation, state: intent.state, reason: intent.reason }] : []
      })
      const last = page.at(-1)
      return { profiles, replicas, presentReplicas, pendingReplicas, revision: await tx.catalogRevision(),
        nextCursor: rows.length > limit && last ? browserPageCursor('browser-catalog', JSON.stringify([last.profile.id, last.computerId])) : null }
    })
  }

  async create(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    name: string; computerId: string; distribution?: BrowserProfile['distribution']
  }): Promise<BrowserCommandReceipt<BrowserProfile>> {
    await this.authority.authorize(principal, 'settings:update', [input.computerId])
    const installationId = await this.host.installation(input.computerId)
    return this.command(principal, 'browser_profile_create', input, [input.computerId], ['catalog'], async tx => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== await tx.catalogRevision()) {
        throw new DomainError('REVISION_CONFLICT', 'The browser catalog changed. Refresh before creating a profile.', 409)
      }
      if (!(await this.authority.computers(principal, tx.sql)).some(computer => computer.id === input.computerId)) {
        throw new DomainError('NOT_FOUND', 'The selected computer is not registered.', 404)
      }
      const profile = BrowserProfileSchema.parse({ id: this.id(), name: input.name,
        sourceComputerId: input.computerId, distribution: input.distribution ?? 'shared', revision: 1, publishedRevision: 0 })
      await tx.putProfile({ profile, deleted: false })
      await tx.putReplica({ ...newBrowserReplica(profile.id, input.computerId), reason: 'Browser profile creation is queued.' })
      await tx.putIntent({ id: this.id(), profileId: profile.id, computerId: input.computerId,
        operation: 'create', revision: profile.revision, installationId, state: 'queued', reason: null })
      return profile
    })
  }

  async update(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    profileId: string; patch: Partial<Pick<BrowserProfile, 'name' | 'sourceComputerId' | 'distribution'>>
  }): Promise<BrowserCommandReceipt<BrowserProfile>> {
    const current = await this.get(principal, input.profileId)
    const computers = [...new Set([current.profile.sourceComputerId, input.patch.sourceComputerId ?? current.profile.sourceComputerId])]
    const changesPolicy = input.patch.sourceComputerId !== undefined || input.patch.distribution !== undefined
    if (changesPolicy) {
      for (const computerId of computers) if (await this.host.status(input.profileId, computerId) === 'busy') {
        throw new DomainError('PROFILE_BUSY', 'Close this profile’s browser sessions before changing its source or distribution.', 409)
      }
    }
    return this.command(principal, 'browser_profile_update', input, computers, ['catalog', `profile:${input.profileId}`], async tx => {
      const previous = await requireBrowserProfile(tx, input.profileId)
      checkBrowserRevision(previous, input.expectedRevision)
      if (changesPolicy && await tx.exportOwner(input.profileId)) {
        throw new DomainError('PROFILE_BUSY', 'Wait for the admitted source export before changing this profile policy.', 409)
      }
      const next = BrowserProfileSchema.parse({ ...previous, ...input.patch })
      const nextSource = await tx.replicaFacts(next.id, next.sourceComputerId)
      if (next.sourceComputerId !== previous.sourceComputerId && (!nextSource.present
        || nextSource.currentIntent?.operation === 'remove' && nextSource.currentIntent.state !== 'failed')) {
        throw new DomainError('PROFILE_MISSING', 'Add the profile on the selected source computer first.', 409)
      }
      if (browserInputHash(next) === browserInputHash(previous)) return previous
      const profile = { ...next, revision: previous.revision + 1 }
      await tx.putProfile({ profile, deleted: false })
      return profile
    })
  }

  async addExisting(principal: ManagementPrincipal, input: BrowserCommandOptions & { profileId: string; computerId: string }) {
    await this.authority.authorize(principal, 'settings:update', [input.computerId])
    const before = await this.repository.read(tx => requireBrowserProfile(tx, input.profileId))
    const computers = await this.authority.computers(principal)
    const target = computers.find(value => value.id === input.computerId)
    if (!target) throw new DomainError('NOT_FOUND', 'The selected computer is unavailable.', 404)
    const installationId = await this.host.installation(input.computerId)
    const sourceInstallation = await this.host.installation(before.sourceComputerId)
    return this.command(principal, 'browser_profile_create', { ...input, intent: 'add_existing' }, [input.computerId],
      ['catalog', `profile:${input.profileId}`], async tx => {
        const profile = await requireBrowserProfile(tx, input.profileId)
        checkBrowserRevision(profile, input.expectedRevision)
        if (profile.sourceComputerId !== before.sourceComputerId) throw new DomainError('BROWSER_SOURCE_CHANGED', 'The profile source changed during Add admission.', 409)
        if (profile.distribution === 'local_only' && input.computerId !== profile.sourceComputerId) {
          throw new DomainError('PROFILE_LOCAL_ONLY', 'This profile is local only. Change its distribution explicitly before adding another computer.', 409)
        }
        const facts = await tx.replicaFacts(input.profileId, input.computerId)
        const previous = await tx.replica(input.profileId, input.computerId)
        if (facts.present && previous && facts.currentIntent?.operation !== 'remove') return { state: 'ready' as const, replica: previous }
        const revision = profile.revision + 1
        const replica = previous ?? newBrowserReplica(input.profileId, input.computerId)
        if (input.computerId === profile.sourceComputerId) {
          await tx.putReplica({ ...replica, reason: 'Local source creation is queued.' })
          await tx.putIntent({ id: this.id(), profileId: profile.id, computerId: input.computerId,
            operation: 'create', revision, installationId, state: 'queued', reason: null })
          await tx.putProfile({ profile: { ...profile, revision }, deleted: false })
          return { state: 'queued' as const, replica }
        }
        if (replica.localOverride) throw new DomainError('PROFILE_LOCAL_OVERRIDE', 'This computer keeps its own sign-in. Clear that policy explicitly before adding source state.', 409)
        const current = await tx.publishedManifest(profile.id)
        const manifest = current?.sourceComputerId === profile.sourceComputerId ? current : null
        const jobId = this.id(), timestamp = this.now(), state = target.online ? 'queued' as const : 'offline' as const
        const job: BrowserProfileSyncJob = { id: jobId, commandId: input.commandId ?? jobId, state: 'queued', revision: 1,
          createdAt: timestamp, updatedAt: timestamp,
          profiles: [{ profileId: profile.id, sourceComputerId: profile.sourceComputerId,
            state: manifest ? 'published' : 'queued', manifest, reason: manifest ? null : 'Waiting for first source snapshot.' }],
          targets: [{ profileId: profile.id, computerId: input.computerId, snapshot: manifest?.snapshot ?? null,
            state, exclusion: null, reason: target.online ? manifest ? null : 'Waiting for first source snapshot.' : 'Computer offline.', updatedAt: timestamp }] }
        await tx.putJob(job)
        await tx.putJobInstallation(jobId, input.computerId, installationId)
        await tx.putJobInstallation(jobId, profile.sourceComputerId, sourceInstallation)
        await tx.putIntent({ id: `${jobId}:target:${profile.id}:${input.computerId}`, profileId: profile.id,
          computerId: input.computerId, operation: 'sync', revision, installationId, state: 'queued', reason: manifest ? null : 'Waiting for first source snapshot.' })
        const queued = { ...replica, desiredSnapshot: manifest?.snapshot ?? null, transfer: state,
          reason: manifest ? target.online ? null : 'Computer offline.' : 'Waiting for first source snapshot.' }
        await tx.putReplica(queued); await tx.putProfile({ profile: { ...profile, revision }, deleted: false })
        return { state: manifest ? 'queued' as const : 'first_snapshot_pending' as const, replica: queued, jobId }
      })
  }

  async checkOrigin(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    profileId: string; computerId: string; origin: string
  }): Promise<BrowserCommandReceipt<BrowserProfileReplica>> {
    const origin = browserOrigin(input.origin), commandId = input.commandId ?? this.id()
    const key = `${principal.id}:browser_profile_check_origin:${commandId}`, hash = browserInputHash({ ...input, origin, commandId })
    await this.authority.authorize(principal, 'settings:update', [input.computerId])
    const currentInstallation = await this.host.installation(input.computerId)
    type Probe = { state: 'pending' | 'completed' | 'stale'; revision: number; installationId: string; claimUntil: number; replica?: BrowserProfileReplica }
    const admission = await this.repository.transaction([`command:${key}`, `profile:${input.profileId}`], async tx => {
      await this.authority.authorize(principal, 'settings:update', [input.computerId], tx.sql)
      const previous = await tx.command(key)
      if (previous && previous.hash !== hash) throw new DomainError('COMMAND_ID_CONFLICT', 'This probe command belongs to different input.', 409)
      const saved = previous?.result as Probe | undefined
      if (saved?.state === 'completed') return saved
      if (saved?.state === 'stale') throw new DomainError('REVISION_CONFLICT', 'This observation was superseded by a newer profile change.', 409)
      if (saved && saved.claimUntil > Date.parse(this.now())) throw new DomainError('BROWSER_PROBE_PENDING', 'The original sign-in observation is still pending.', 503)
      const profile = await requireBrowserProfile(tx, input.profileId)
      if (!saved) checkBrowserRevision(profile, input.expectedRevision)
      const facts = await tx.replicaFacts(input.profileId, input.computerId)
      if (!facts.present || facts.currentIntent?.operation === 'remove' && facts.currentIntent.state !== 'failed') throw new DomainError('PROFILE_MISSING', 'This profile copy is not available for a sign-in check.', 409)
      const probe: Probe = { state: 'pending', revision: saved?.revision ?? profile.revision,
        installationId: saved?.installationId ?? currentInstallation, claimUntil: Date.parse(this.now()) + 30_000 }
      await tx.putCommand(key, { hash, result: probe }); return probe
    })
    if (admission.state === 'completed') return { commandId, value: admission.replica!, replayed: true }
    let evidence
    try {
      evidence = BrowserLoginEvidenceSchema.parse(await this.host.checkOrigin({ profileId: input.profileId, computerId: input.computerId,
        origin, operationId: key, installationId: admission.installationId }))
      if (evidence.origin !== origin) throw new DomainError('BROWSER_ORIGIN_MISMATCH', 'The observation belongs to another origin.', 409)
    } catch (error) {
      await this.repository.transaction([`command:${key}`], tx => tx.putCommand(key, { hash, result: { ...admission, claimUntil: 0 } }))
      throw error
    }
    const result = await this.repository.transaction([`command:${key}`, `profile:${input.profileId}`], async tx => {
      await this.authority.authorize(principal, 'settings:update', [input.computerId], tx.sql)
      const profile = await requireBrowserProfile(tx, input.profileId), replica = await tx.replica(input.profileId, input.computerId)
      if (profile.revision !== admission.revision || !replica) {
        await tx.putCommand(key, { hash, result: { ...admission, state: 'stale' } }); return null
      }
      const updated = { ...replica, loginEvidence: [...replica.loginEvidence.filter(value => value.origin !== origin), evidence] }
      await tx.putReplica(updated); await tx.putProfile({ profile: { ...profile, revision: profile.revision + 1 }, deleted: false })
      await tx.putCommand(key, { hash, result: { ...admission, state: 'completed', replica: updated } })
      return updated
    })
    if (!result) throw new DomainError('REVISION_CONFLICT', 'This observation was superseded by a newer profile change.', 409)
    return { commandId, value: result, replayed: false }
  }

  async setLocalOverride(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    profileId: string; computerId: string; localOverride: boolean
  }): Promise<BrowserCommandReceipt<BrowserProfileReplica>> {
    return this.command(principal, 'browser_profile_override', input, [input.computerId], [`profile:${input.profileId}`], async tx => {
      const profile = await requireBrowserProfile(tx, input.profileId)
      checkBrowserRevision(profile, input.expectedRevision)
      const replica = await tx.replica(input.profileId, input.computerId)
      if (!replica) throw new DomainError('PROFILE_MISSING', 'This profile is not added on that computer.', 404)
      if (replica.localOverride === input.localOverride) return replica
      const updated = { ...replica, localOverride: input.localOverride }
      await tx.putReplica(updated)
      await tx.putProfile({ profile: { ...profile, revision: profile.revision + 1 }, deleted: false })
      // Policy only: admitted jobs retain their original exclusions and no transfer is created here.
      return updated
    })
  }

  async confirmLogin(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    profileId: string; computerId: string; origin: string; state: 'signed_in' | 'sign_in_required'
  }): Promise<BrowserCommandReceipt<BrowserProfileReplica>> {
    const origin = browserOrigin(input.origin)
    return this.command(principal, 'browser_profile_login', { ...input, origin }, [input.computerId], [`profile:${input.profileId}`], async tx => {
      const profile = await requireBrowserProfile(tx, input.profileId)
      checkBrowserRevision(profile, input.expectedRevision)
      const replica = await tx.replica(input.profileId, input.computerId)
      if (!replica) throw new DomainError('PROFILE_MISSING', 'This profile is not added on that computer.', 404)
      const evidence = BrowserLoginEvidenceSchema.parse({ origin, state: input.state,
        checkedAt: this.now(), evidence: 'user_confirmed', reason: null })
      const updated = BrowserProfileReplicaSchema.parse({ ...replica,
        loginEvidence: [...replica.loginEvidence.filter(item => item.origin !== origin), evidence] })
      await tx.putReplica(updated)
      await tx.putProfile({ profile: { ...profile, revision: profile.revision + 1 }, deleted: false })
      return updated
    })
  }

  async remove(principal: ManagementPrincipal, input: BrowserCommandOptions & {
    profileId: string; computerId?: string
  }): Promise<BrowserCommandReceipt<ProfileHostIntent[]>> {
    const computers = (await this.repository.read(tx => tx.replicas(input.profileId))).map(replica => replica.computerId)
    await this.authority.authorize(principal, 'settings:update', input.computerId ? [input.computerId] : computers)
    const installations = new Map(await Promise.all((input.computerId ? [input.computerId] : computers)
      .map(async computerId => [computerId, await this.host.installation(computerId)] as const)))
    return this.command(principal, 'browser_profile_remove', input, input.computerId ? [input.computerId] : computers,
      ['catalog', `profile:${input.profileId}`], async tx => {
        const profile = await requireBrowserProfile(tx, input.profileId)
        checkBrowserRevision(profile, input.expectedRevision)
        const targets = (await tx.replicas(input.profileId)).filter(replica => !input.computerId || replica.computerId === input.computerId)
        const intents: ProfileHostIntent[] = []
        for (const replica of targets) {
          const intent: ProfileHostIntent = { id: this.id(), profileId: profile.id, computerId: replica.computerId,
            operation: 'remove', revision: profile.revision + 1, installationId: installations.get(replica.computerId)!, state: 'queued', reason: null }
          await tx.putIntent(intent); intents.push(intent)
        }
        await tx.putProfile({ profile: { ...profile, revision: profile.revision + 1 }, deleted: !input.computerId })
        return intents
      })
  }
}

export function createBrowserProfileService(options: BrowserProfileServiceOptions): BrowserProfileService {
  return new BrowserProfileService(options)
}
