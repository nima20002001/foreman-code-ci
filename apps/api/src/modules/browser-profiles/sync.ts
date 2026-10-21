import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { BrowserProfileSnapshotManifestSchema, BrowserProfileSyncJobSchema,
  BrowserProfileSyncPageSchema, type BrowserProfileSyncPage } from '@foreman-code/contracts/browser-profiles'
import { DomainError } from '../errors.js'
import { browserInputHash, browserPageCursor, browserPageLimit, readBrowserCursor, sameBrowserSnapshot } from './identity.js'
import { newBrowserReplica, requireBrowserProfile, type BrowserProfileService } from './service.js'
import type { BrowserCommandOptions, BrowserCommandReceipt, BrowserProfileSyncJob,
  BrowserProfile, BrowserProfileTransaction } from './types.js'

function maintenancePending(error: unknown): boolean {
  return error instanceof DomainError && ['PROFILE_BUSY', 'BROWSER_RUNTIME_DRAINING'].includes(error.code)
}

async function allProfiles(tx: BrowserProfileTransaction): Promise<BrowserProfile[]> {
  const profiles: BrowserProfile[] = []
  let after: string | undefined
  for (;;) {
    const page = await tx.profiles(after, 100)
    profiles.push(...page.map(row => row.profile))
    if (page.length < 100) return profiles
    after = page.at(-1)!.profile.id
  }
}

export async function admitBrowserProfileSync(service: BrowserProfileService, principal: ManagementPrincipal,
  input: BrowserCommandOptions & { profileIds?: readonly string[] }): Promise<BrowserCommandReceipt<BrowserProfileSyncJob>> {
  const commandId = input.commandId ?? service.id()
  const computers = await service.authority.computers(principal)
  const profiles = await service.repository.read(tx => allProfiles(tx))
  const selected = input.profileIds ? [...new Set(input.profileIds)].sort() : profiles.map(profile => profile.id)
  if (selected.some(id => !profiles.some(profile => profile.id === id))) throw new DomainError('NOT_FOUND', 'A selected browser profile no longer exists.', 404)
  await service.authority.authorize(principal, 'settings:update', computers.map(computer => computer.id))
  const installations = new Map(await Promise.all([...new Set([...computers.map(value => value.id),
    ...profiles.filter(value => selected.includes(value.id)).map(value => value.sourceComputerId)])]
    .map(async computerId => [computerId, await service.host.installation(computerId)] as const)))
  return service.command(principal, 'browser_profiles_sync', { ...input, commandId }, computers.map(computer => computer.id),
    ['catalog', ...selected.map(id => `profile:${id}`)], async tx => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== await tx.catalogRevision()) {
        throw new DomainError('REVISION_CONFLICT', 'The browser profile catalog changed. Refresh before syncing.', 409)
      }
      const timestamp = service.now()
      const job: BrowserProfileSyncJob = { id: service.id(), commandId, state: 'queued', profiles: [], targets: [],
        revision: 1, createdAt: timestamp, updatedAt: timestamp }
      for (const id of selected) {
        const profile = await requireBrowserProfile(tx, id)
        if (!installations.has(profile.sourceComputerId)) throw new DomainError('BROWSER_SOURCE_CHANGED', 'The profile source changed during sync admission.', 409)
        const revision = profile.revision + 1
        job.profiles.push({ profileId: id, sourceComputerId: profile.sourceComputerId,
          state: profile.distribution === 'local_only' ? 'excluded' : 'queued', manifest: null,
          reason: profile.distribution === 'local_only' ? 'This profile is local only.' : null })
        for (const computer of computers) {
          const replica = await tx.replica(id, computer.id) ?? newBrowserReplica(id, computer.id)
          const removal = (await tx.replicaFacts(id, computer.id)).currentIntent?.operation === 'remove'
          const exclusion = profile.distribution === 'local_only' ? 'local_only'
            : computer.id === profile.sourceComputerId ? 'source' : removal ? 'removed' : replica.localOverride ? 'local_override' : null
          job.targets.push({ profileId: id, computerId: computer.id, snapshot: null,
            state: exclusion ? 'excluded' : computer.online ? 'queued' : 'offline', exclusion,
            reason: exclusion === 'source' ? 'Source computer.' : exclusion === 'local_only' ? 'Local-only profile.'
              : exclusion === 'removed' ? 'This copy was removed. Use Add here to restore it.'
              : exclusion === 'local_override' ? 'This computer keeps its own sign-in.' : computer.online ? null : 'Computer offline.',
            updatedAt: timestamp })
          if (!exclusion) await tx.putIntent({ id: `${job.id}:target:${id}:${computer.id}`, profileId: id,
            computerId: computer.id, operation: 'sync', revision, installationId: installations.get(computer.id)!, state: 'queued', reason: null })
        }
        const source = job.profiles.at(-1)!
        const hasDestination = job.targets.some(target => target.profileId === id && target.exclusion === null)
        if (source.state === 'queued' && !hasDestination) {
          source.state = 'excluded'
          source.reason = 'No eligible destination computers.'
        }
        if (profile.distribution === 'shared' && hasDestination) {
          await tx.putProfile({ profile: { ...profile, revision }, deleted: false })
        }
      }
      if (job.targets.every(target => target.state === 'excluded')) job.state = 'completed'
      await tx.putJob(job)
      for (const [computerId, installationId] of installations) await tx.putJobInstallation(job.id, computerId, installationId)
      return job
    })
}

export async function readBrowserProfileSync(service: BrowserProfileService, principal: ManagementPrincipal, input: {
  jobId: string; profileCursor?: string; targetCursor?: string; limit?: number
}): Promise<BrowserProfileSyncPage> {
  const job = await service.repository.read(tx => tx.job(input.jobId))
  if (!job) throw new DomainError('NOT_FOUND', 'Browser sync job not found.', 404)
  await service.authority.authorize(principal, 'settings:read', [...new Set(job.targets.map(target => target.computerId))])
  const limit = browserPageLimit(input.limit)
  const profileStart = readBrowserCursor(input.profileCursor, `${job.id}:profiles`)
  const targetStart = readBrowserCursor(input.targetCursor, `${job.id}:targets`)
  const profiles = job.profiles.filter(profile => !profileStart || profile.profileId > profileStart)
    .sort((a, b) => a.profileId.localeCompare(b.profileId))
  const key = (target: BrowserProfileSyncJob['targets'][number]) => `${target.profileId}/${target.computerId}`
  const targets = job.targets.filter(target => !targetStart || key(target) > targetStart).sort((a, b) => key(a).localeCompare(key(b)))
  const pageTargets = targets.slice(0, limit)
  const selectedProfiles = new Set([...profiles.slice(0, limit), ...pageTargets].map(value => value.profileId))
  return BrowserProfileSyncPageSchema.parse({ job: { ...job,
    profiles: job.profiles.filter(value => selectedProfiles.has(value.profileId)), targets: pageTargets },
    nextProfileCursor: profiles.length > limit ? browserPageCursor(`${job.id}:profiles`, profiles[limit - 1]!.profileId) : null,
    nextTargetCursor: targets.length > limit ? browserPageCursor(`${job.id}:targets`, key(targets[limit - 1]!)) : null })
}

export class BrowserProfileSyncCoordinator {
  private readonly running = new Map<string, Promise<BrowserProfileSyncJob>>()
  constructor(private readonly service: BrowserProfileService) {}

  reconcile(jobId: string): Promise<BrowserProfileSyncJob> {
    const existing = this.running.get(jobId)
    if (existing) return existing
    const task = this.advance(jobId).finally(() => this.running.delete(jobId))
    this.running.set(jobId, task)
    return task
  }

  private async change(jobId: string, update: (job: BrowserProfileSyncJob, tx: BrowserProfileTransaction) => Promise<boolean>,
    profileId?: string): Promise<BrowserProfileSyncJob> {
    return this.service.repository.transaction([`job:${jobId}`, ...(profileId ? [`profile:${profileId}`] : [])], async tx => {
      const job = await tx.job(jobId)
      if (!job) throw new DomainError('NOT_FOUND', 'Browser sync job not found.', 404)
      const semantic = (value: BrowserProfileSyncJob) => ({ ...value, revision: 0, updatedAt: '',
        targets: value.targets.map(target => ({ ...target, updatedAt: '' })) })
      const original = structuredClone(job)
      const before = browserInputHash(semantic(job))
      if (await update(job, tx) && before !== browserInputHash(semantic(job))) {
        job.revision++; job.updatedAt = this.service.now()
        await tx.putJob(BrowserProfileSyncJobSchema.parse(job))
        return job
      }
      return original
    })
  }

  private async advance(jobId: string): Promise<BrowserProfileSyncJob> {
    let job = await this.change(jobId, async value => {
      if (['completed', 'partial', 'failed'].includes(value.state)) return false
      value.state = 'running'; return true
    })
    if (['completed', 'partial', 'failed'].includes(job.state)) return job
    for (const profile of job.profiles) {
      if (!['excluded', 'published', 'failed'].includes(profile.state)) await this.publish(jobId, profile.profileId)
    }
    job = (await this.service.repository.read(tx => tx.job(jobId)))!
    for (const target of job.targets) {
      if (!['excluded', 'up_to_date', 'failed'].includes(target.state)) await this.apply(jobId, target.profileId, target.computerId)
    }
    return this.change(jobId, async value => {
      const eligible = value.targets.filter(target => target.state !== 'excluded')
      const failed = eligible.filter(target => target.state === 'failed').length
      const done = eligible.filter(target => target.state === 'up_to_date').length
      const state = done === eligible.length ? 'completed' : done + failed === eligible.length
        ? done ? 'partial' : 'failed' : 'running'
      if (value.state === state) return false
      value.state = state; return true
    })
  }

  private async publish(jobId: string, profileId: string): Promise<void> {
    let revision = 0, dispatched = false
    const dispatchKey = `snapshot-export:${jobId}:${profileId}`
    const reserved = await this.change(jobId, async (job, tx) => {
      const source = job.profiles.find(value => value.profileId === profileId)!
      const owner = await tx.exportOwner(profileId)
      if (owner && owner !== jobId) return false
      const stored = await tx.profile(profileId), profile = stored?.profile
      if (!profile || stored?.deleted || profile.sourceComputerId !== source.sourceComputerId || profile.distribution !== 'shared') {
        source.state = 'failed'; source.reason = 'The source or distribution changed. Start a new sync from the current source.'
        for (const target of job.targets.filter(value => value.profileId === profileId && !value.exclusion)) {
          target.state = 'failed'; target.reason = source.reason; target.updatedAt = this.service.now()
        }
        if (owner === jobId) await tx.setExportOwner(profileId, null)
        return true
      }
      const previous = await tx.command(dispatchKey)
      dispatched = Boolean(previous)
      const sourceFacts = await tx.replicaFacts(profileId, source.sourceComputerId)
      if (!sourceFacts.present || sourceFacts.currentIntent?.operation === 'remove' && sourceFacts.currentIntent.state !== 'failed') {
        source.state = 'queued'; source.reason = 'Waiting for the designated source profile to be created and ready.'
        return true
      }
      revision = previous ? (previous.result as { revision: number }).revision : profile.publishedRevision + 1
      await tx.setExportOwner(profileId, jobId)
      return false
    }, profileId)
    if (!revision) return
    const source = reserved.profiles.find(value => value.profileId === profileId)!
    try {
      const status = await this.service.host.status(profileId, source.sourceComputerId)
      if (status !== 'ready') {
        await this.change(jobId, async (job, tx) => {
          if (!dispatched && await tx.exportOwner(profileId) === jobId) await tx.setExportOwner(profileId, null)
          const current = job.profiles.find(value => value.profileId === profileId)!
          current.state = status === 'offline' ? 'offline' : 'queued'
          current.reason = status === 'busy' ? 'Waiting for the source browser to become idle.' : 'Waiting for the source computer and browser runtime.'
          return true
        }, profileId)
        return
      }
      await this.change(jobId, async (job, tx) => {
        const profile = await requireBrowserProfile(tx, profileId)
        if (await tx.exportOwner(profileId) !== jobId || profile.sourceComputerId !== source.sourceComputerId
          || profile.distribution !== 'shared' || profile.publishedRevision + 1 !== revision) {
          throw new DomainError('BROWSER_SOURCE_CHANGED', 'The source changed before snapshot dispatch.', 409)
        }
        await tx.putCommand(dispatchKey, { hash: browserInputHash({ jobId, profileId, revision }), result: { revision } })
        const row = job.profiles.find(value => value.profileId === profileId)!
        row.state = 'exporting'; row.reason = null; return true
      }, profileId)
      dispatched = true
      const transfer = await this.service.host.export({ profileId, computerId: source.sourceComputerId,
        publishedRevision: revision, operationId: `${jobId}:export:${profileId}`, jobId })
      const manifest = BrowserProfileSnapshotManifestSchema.parse(transfer.manifest)
      if (!sameBrowserSnapshot(transfer.snapshot, manifest.snapshot) || manifest.snapshot.profileId !== profileId
        || ![revision, revision - 1].includes(manifest.snapshot.publishedRevision) || manifest.sourceComputerId !== source.sourceComputerId) {
        throw new DomainError('SNAPSHOT_MISMATCH', 'The source returned a different browser snapshot identity.', 409)
      }
      await this.change(jobId, async (job, tx) => {
        const profile = await requireBrowserProfile(tx, profileId)
        const current = job.profiles.find(value => value.profileId === profileId)!
        if (await tx.exportOwner(profileId) !== jobId || profile.sourceComputerId !== source.sourceComputerId
          || profile.distribution !== 'shared' || profile.publishedRevision + 1 !== revision) {
          throw new DomainError('BROWSER_SOURCE_CHANGED', 'The source changed while capturing this snapshot.', 409)
        }
        const unchanged = manifest.snapshot.publishedRevision === profile.publishedRevision
        if (unchanged && !sameBrowserSnapshot((await tx.publishedManifest(profileId))?.snapshot ?? null, manifest.snapshot)) {
          throw new DomainError('SNAPSHOT_MISMATCH', 'An unchanged export must reuse the current exact published snapshot.', 409)
        }
        current.state = 'published'; current.manifest = manifest; current.reason = null
        for (const target of job.targets.filter(value => value.profileId === profileId && !value.exclusion)) {
          const intent = await tx.intent(`${jobId}:target:${profileId}:${target.computerId}`)
          const newer = (await tx.replicaFacts(profileId, target.computerId)).currentIntent?.id !== intent?.id
          if (!intent || newer) {
            target.state = 'failed'; target.reason = 'A newer explicit profile request superseded this target.'
            continue
          }
          target.snapshot = manifest.snapshot; target.updatedAt = this.service.now()
          const replica = await tx.replica(profileId, target.computerId) ?? newBrowserReplica(profileId, target.computerId)
          await tx.putReplica({ ...replica, desiredSnapshot: manifest.snapshot, transfer: target.state === 'offline' ? 'offline' : 'queued' })
        }
        if (!unchanged) {
          await tx.putProfile({ profile: { ...profile, publishedRevision: revision, revision: profile.revision + 1 }, deleted: false })
          await tx.putPublishedManifest(manifest)
        }
        await tx.setExportOwner(profileId, null)
        return true
      }, profileId)
    } catch (error) {
      await this.change(jobId, async (job, tx) => {
        const current = job.profiles.find(value => value.profileId === profileId)!
        if (maintenancePending(error)) {
          current.state = 'queued'
          current.reason = 'Waiting for the source browser to become idle.'
          return true
        }
        const terminal = error instanceof DomainError && error.status < 500
        current.state = terminal ? 'failed' : 'offline'
        current.reason = terminal ? 'The source snapshot could not be published safely.' : 'Source result unconfirmed. Reconnect to reconcile the original export.'
        if (terminal) {
          await tx.setExportOwner(profileId, null)
          for (const target of job.targets.filter(value => value.profileId === profileId && !value.exclusion)) {
            target.state = 'failed'; target.reason = current.reason; target.updatedAt = this.service.now()
          }
        } else if (!dispatched && await tx.exportOwner(profileId) === jobId) {
          await tx.setExportOwner(profileId, null)
        }
        return true
      }, profileId)
    }
  }

  private async apply(jobId: string, profileId: string, computerId: string): Promise<void> {
    const admitted = await this.service.repository.read(async tx => {
      const job = await tx.job(jobId), intent = await tx.intent(`${jobId}:target:${profileId}:${computerId}`)
      const source = job?.profiles.find(value => value.profileId === profileId)
      const target = job?.targets.find(value => value.profileId === profileId && value.computerId === computerId)
      return { intent, source, target }
    })
    const { intent, source, target } = admitted
    if (!intent || source?.state !== 'published' || !source.manifest || !target?.snapshot || target.state === 'up_to_date') return
    const transfer = { snapshot: target.snapshot, manifest: source.manifest }
    const isCurrent = async (tx: BrowserProfileTransaction) => {
      const profile = await tx.profile(profileId), replica = await tx.replica(profileId, computerId)
      return Boolean(profile && !profile.deleted && replica && sameBrowserSnapshot(replica.desiredSnapshot, transfer.snapshot)
        && (await tx.replicaFacts(profileId, computerId)).currentIntent?.id === intent.id)
    }
    const record = async (state: BrowserProfileSyncJob['targets'][number]['state'], reason: string | null, applied = false) => this.change(jobId, async (job, tx) => {
      const row = job.targets.find(value => value.profileId === profileId && value.computerId === computerId)!
      row.updatedAt = this.service.now()
      if (!await isCurrent(tx)) {
        row.state = 'failed'; row.reason = 'A newer explicit profile request superseded this target.'; return true
      }
      row.state = state; row.reason = reason
      const replica = (await tx.replica(profileId, computerId))!
      await tx.putIntent({ ...intent, state: applied ? 'completed' : state === 'failed' ? 'failed' : 'running', reason })
      await tx.putReplica({ ...replica, transfer: applied ? 'up_to_date' : state === 'offline' ? 'offline'
        : state === 'failed' ? 'failed' : state === 'applying' ? 'applying' : 'queued', reason,
        ...(applied ? { receivedSnapshot: transfer.snapshot, appliedSnapshot: transfer.snapshot, lastSeenAt: this.service.now(),
          loginEvidence: source.manifest!.origins.map(origin => ({ origin, state: 'not_checked' as const,
            checkedAt: null, evidence: 'none' as const, reason: null })) } : {}) })
      return true
    }, profileId)
    try {
      const status = await this.service.host.status(profileId, computerId)
      if (status !== 'ready') {
        await record(status === 'offline' ? 'offline' : 'waiting_idle', status === 'busy'
          ? 'Waiting for this profile’s browser to close.' : 'Waiting for this computer’s browser runtime.'); return
      }
      const claim = await record('transferring', null)
      if (claim.targets.find(value => value.profileId === profileId && value.computerId === computerId)!.state === 'failed') return
      await this.service.host.receive({ profileId, computerId, sourceComputerId: source.sourceComputerId, transfer,
        operationId: `${jobId}:receive:${profileId}:${computerId}`, revision: intent.revision, jobId })
      await this.change(jobId, async (_job, tx) => {
        if (!await isCurrent(tx)) return false
        const replica = (await tx.replica(profileId, computerId))!
        await tx.putReplica({ ...replica, receivedSnapshot: transfer.snapshot }); return true
      }, profileId)
      const active = await record('applying', null)
      if (active.targets.find(value => value.profileId === profileId && value.computerId === computerId)!.state === 'failed') return
      // The host serializes native maintenance and compares both this durable intent revision and exact
      // desired identity immediately before activation. No network/native call holds a SQL transaction.
      await this.service.host.apply({ profileId, computerId, transfer,
        operationId: `${jobId}:apply:${profileId}:${computerId}`, revision: intent.revision, jobId })
      await record('up_to_date', null, true)
    } catch (error) {
      if (maintenancePending(error)) {
        await record('waiting_idle', 'Waiting for this profile’s browser maintenance to finish.')
        return
      }
      await record(error instanceof DomainError && error.status < 500 ? 'failed' : 'offline',
        'The snapshot was not confirmed applied. Retry reconciles this same immutable snapshot.')
    }
  }
}
