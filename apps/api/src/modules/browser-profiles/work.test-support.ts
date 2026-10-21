import { randomUUID } from 'node:crypto'
import { vi, type Mock } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { BrowserProfileService } from './service.js'
import { BrowserProfileSyncCoordinator } from './sync.js'
import { BrowserProfileDispatcher } from './dispatcher.js'
import type { BrowserProfileRepository, BrowserProfileTransaction, BrowserProfileHost, BrowserHostAvailability,
  BrowserProfileReplica, BrowserProfileSyncJob, BrowserProfileSnapshotManifest, ProfileCommand, ProfileHostIntent,
  StoredProfile, BrowserProfilePendingWork } from './types.js'

/** A transaction-serialized peer repository survives replacement dispatcher/coordinator instances. */
function retainedRepository(): BrowserProfileRepository {
  const profiles = new Map<string, StoredProfile>(), replicas = new Map<string, BrowserProfileReplica>()
  const jobs = new Map<string, BrowserProfileSyncJob>(), commands = new Map<string, ProfileCommand>()
  const intents = new Map<string, ProfileHostIntent>(), owners = new Map<string, string>()
  const manifests = new Map<string, BrowserProfileSnapshotManifest>(), installations = new Map<string, string>()
  let revision = 0, tail = Promise.resolve()
  const key = (profileId: string, computerId: string) => `${profileId}/${computerId}`
  const clone = <T>(value: T): T => structuredClone(value)
  const put = <T>(map: Map<string, T>, id: string, value: T, visible: (value: T) => unknown = item => item) => {
    const previous = map.get(id)
    if (!previous || JSON.stringify(visible(previous)) !== JSON.stringify(visible(value))) revision++
    map.set(id, clone(value))
  }
  const facts: BrowserProfileTransaction['replicaFacts'] = async (profileId, computerId) => {
    const rows = [...intents.values()].filter(value => value.profileId === profileId && value.computerId === computerId)
      .sort((a, b) => b.revision - a.revision)
    const completed = rows.find(value => value.state === 'completed')
    return clone({ present: Boolean(completed && completed.operation !== 'remove'), presenceRevision: completed?.revision ?? 0,
      currentIntent: rows[0] ?? null })
  }
  const tx: BrowserProfileTransaction = {
    pendingWork: async (after, limit) => {
      const rows: BrowserProfilePendingWork[] = [...intents.values()].filter(value => value.operation !== 'sync' && ['queued', 'running'].includes(value.state))
        .map(value => ({ key: `intent:${value.id}`, kind: 'intent', id: value.id }))
      rows.push(...[...jobs.values()].filter(value => ['queued', 'running'].includes(value.state))
        .map(value => ({ key: `job:${value.id}`, kind: 'job' as const, id: value.id })))
      return rows.filter(value => !after || value.key > after).sort((a, b) => a.key.localeCompare(b.key)).slice(0, limit)
    },
    retention: async () => ({ snapshots: [], operations: [], computers: [], revision: 0 }), clearRetention: async () => undefined,
    profile: async id => clone(profiles.get(id)), putProfile: async value => { put(profiles, value.profile.id, value) },
    profiles: async (after, limit) => clone([...profiles.values()].filter(value => !value.deleted && (!after || value.profile.id > after))
      .sort((a, b) => a.profile.id.localeCompare(b.profile.id)).slice(0, limit)),
    catalogRows: async (after, computers, limit) => {
      const rows = []
      for (const value of [...profiles.values()].filter(value => !value.deleted).sort((a, b) => a.profile.id.localeCompare(b.profile.id))) {
        for (const computerId of [...computers].sort()) {
          if (after && (value.profile.id < after[0] || value.profile.id === after[0] && computerId <= after[1])) continue
          rows.push({ profile: value.profile, computerId, replica: replicas.get(key(value.profile.id, computerId)) ?? null,
            facts: await facts(value.profile.id, computerId) })
        }
      }
      return clone(rows.slice(0, limit))
    }, replicaFacts: facts,
    replica: async (profileId, computerId) => clone(replicas.get(key(profileId, computerId))),
    replicas: async profileId => clone([...replicas.values()].filter(value => value.profileId === profileId)),
    putReplica: async value => { put(replicas, key(value.profileId, value.computerId), value) },
    job: async id => clone(jobs.get(id)), putJob: async value => { jobs.set(value.id, clone(value)) },
    command: async id => clone(commands.get(id)), putCommand: async (id, value) => { commands.set(id, clone(value)) },
    intent: async id => clone(intents.get(id)), putIntent: async value => {
      put(intents, value.id, value, item => { const result = { ...item }; delete result.claimId; delete result.claimUntil; return result })
    },
    intents: async profileId => clone([...intents.values()].filter(value => value.profileId === profileId)),
    exportOwner: async id => owners.get(id), setExportOwner: async (id, owner) => { if (owner) owners.set(id, owner); else owners.delete(id) },
    catalogRevision: async () => revision,
    publishedManifest: async id => clone(manifests.get(id)), putPublishedManifest: async value => { manifests.set(value.snapshot.profileId, clone(value)) },
    jobInstallation: async (jobId, computerId) => installations.get(key(jobId, computerId)),
    putJobInstallation: async (jobId, computerId, installationId) => { installations.set(key(jobId, computerId), installationId) },
  }
  return { read: work => work(tx), transaction: (_locks, work) => {
    const task = tail.then(() => work(tx)); tail = task.then(() => undefined, () => undefined); return task
  } }
}

export function profileWorkFixture() {
  const repository = retainedRepository(), statuses = new Map<string, BrowserHostAvailability>([['source', 'ready'], ['worker', 'ready']])
  const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
  const host: BrowserProfileHost = {
    installation: async computerId => `${computerId}-installation`, status: vi.fn(async (_profileId, computerId) => statuses.get(computerId) ?? 'offline'),
    create: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), receive: vi.fn(async () => undefined),
    apply: vi.fn(async () => undefined), prune: vi.fn(async () => undefined),
    export: vi.fn(async input => {
      const snapshot = { profileId: input.profileId, publishedRevision: input.publishedRevision, sha256: 'a'.repeat(64), format: 'cookies-localstorage-v1' as const }
      return { snapshot, manifest: { snapshot, sourceComputerId: input.computerId, createdAt: '2026-01-01T00:00:00.000Z',
        byteLength: 10, origins: ['https://fixture.test'], unsupportedState: [] } }
    }),
    checkOrigin: vi.fn<BrowserProfileHost['checkOrigin']>(async input => ({ origin: input.origin, state: 'unknown', checkedAt: null, evidence: 'none', reason: null })),
  }
  const service = new BrowserProfileService({ repository, host, id: randomUUID, authority: {
    authorize: async () => undefined,
    computers: async () => [...statuses].map(([id, status]) => ({ id, online: status !== 'offline' })),
  } })
  const failures: Mock<(error: unknown) => void> = vi.fn()
  const retention = { reconcile: vi.fn(async () => undefined) }
  const dispatcher = () => new BrowserProfileDispatcher({ service, sync: new BrowserProfileSyncCoordinator(service), retention,
    reportFailure: failures, retryMs: 60_000 })
  return { owner, service, host, statuses, failures, retention, dispatcher }
}
