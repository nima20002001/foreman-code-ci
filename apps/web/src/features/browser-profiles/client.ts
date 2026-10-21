import { createBrowserHttp, browserProfilePath, browserSessionPath, type BrowserHttpOptions,
  type BrowserMethodCodec, type BrowserWireCodec } from '../agent-browser/http'
import type { BrowserProfileCatalog, BrowserProfilesPort, BrowserProfileSyncJob } from './types'
import { BrowserProfileSyncPageSchema, type BrowserProfileSyncPage } from '@foreman-code/contracts/browser-profiles'

type CatalogPage = BrowserProfileCatalog & { nextCursor: string | null; revision: number }
type SyncPage = BrowserProfileSyncPage
export type BrowserProfileCodecs = { [Key in Exclude<keyof BrowserProfilesPort, 'readCatalog' | 'readSync'>]: BrowserMethodCodec<BrowserProfilesPort[Key]> } & {
  readCatalog: BrowserWireCodec<[string | null, AbortSignal], CatalogPage>
  readSync: BrowserWireCodec<[string, string | null, string | null, AbortSignal], SyncPage>
}

async function collectCatalog(read: (cursor: string | null) => Promise<CatalogPage>, signal: AbortSignal): Promise<BrowserProfileCatalog> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const profiles = new Map<string, BrowserProfileCatalog['profiles'][number]>()
    const replicas = new Map<string, BrowserProfileCatalog['replicas'][number]>()
    const present = new Map<string, BrowserProfileCatalog['presentReplicas'][number]>()
    const pending = new Map<string, BrowserProfileCatalog['pendingReplicas'][number]>()
    const seen = new Set<string>(); let cursor: string | null = null, revision: number | undefined
    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      signal.throwIfAborted()
      const page = await read(cursor)
      if (revision !== undefined && page.revision !== revision) break
      revision = page.revision
      for (const profile of page.profiles) profiles.set(profile.id, profile)
      for (const replica of page.replicas) replicas.set(`${replica.profileId}/${replica.computerId}`, replica)
      for (const copy of page.presentReplicas) present.set(`${copy.profileId}/${copy.computerId}`, copy)
      for (const copy of page.pendingReplicas) pending.set(`${copy.profileId}/${copy.computerId}`, copy)
      if (!page.nextCursor) return { profiles: [...profiles.values()], replicas: [...replicas.values()],
        presentReplicas: [...present.values()], pendingReplicas: [...pending.values()] }
      if (seen.has(page.nextCursor)) throw new Error('Browser profile pagination did not advance.')
      cursor = page.nextCursor; seen.add(cursor)
    }
  }
  throw new Error('Browser profiles changed while loading. Refresh to read a consistent catalog.')
}

async function collectSync(jobId: string, read: (profile: string | null, target: string | null) => Promise<SyncPage>, signal: AbortSignal): Promise<BrowserProfileSyncJob> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const profiles = new Map<string, BrowserProfileSyncJob['profiles'][number]>()
    const targets = new Map<string, BrowserProfileSyncJob['targets'][number]>()
    const seen = new Set<string>(); let profile: string | null = null, target: string | null = null
    let profileDone = false, targetDone = false, revision: number | undefined
    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      signal.throwIfAborted()
      const page = BrowserProfileSyncPageSchema.parse(await read(profile, target))
      if (page.job.id !== jobId) throw new Error('Browser sync readback belongs to a different job.')
      if (revision !== undefined && revision !== page.job.revision) break
      revision = page.job.revision
      for (const value of page.job.profiles) profiles.set(value.profileId, value)
      for (const value of page.job.targets) targets.set(`${value.profileId}/${value.computerId}`, value)
      profileDone ||= page.nextProfileCursor === null; targetDone ||= page.nextTargetCursor === null
      if (profileDone && targetDone) return { ...page.job, profiles: [...profiles.values()], targets: [...targets.values()] }
      if (!profileDone) profile = page.nextProfileCursor
      if (!targetDone) target = page.nextTargetCursor
      const key = JSON.stringify([profile, target])
      if (seen.has(key)) throw new Error('Browser sync pagination did not advance.')
      seen.add(key)
    }
  }
  throw new Error('Browser sync changed while loading. Refresh to read consistent progress.')
}

export function createBrowserProfilesClient(options: BrowserHttpOptions & { profiles: BrowserProfileCodecs }): BrowserProfilesPort {
  const call = createBrowserHttp(options), codec = options.profiles, path = browserProfilePath
  return {
    readCatalog: signal => collectCatalog(cursor => call('GET', '/api/browser/profiles', codec.readCatalog, [cursor, signal], signal), signal),
    create: (...args) => call('POST', '/api/browser/profiles', codec.create, args),
    addExisting: (...args) => call('POST', '/api/browser/profiles', codec.addExisting, args),
    update: (...args) => call('PATCH', path(args[0]), codec.update, args),
    setLocalOverride: (...args) => call('PATCH', path(args[0]), codec.setLocalOverride, args),
    confirmLogin: (...args) => call('PATCH', path(args[0]), codec.confirmLogin, args),
    remove: (...args) => call('DELETE', `${path(args[0])}/replicas/${encodeURIComponent(args[1])}`, codec.remove, args),
    openSetup: (...args) => call('POST', '/api/browser/sessions/open', codec.openSetup, args),
    closeSetup: (...args) => call('POST', `${browserSessionPath(args[0].id)}/close`, codec.closeSetup, args),
    sync: (...args) => call('POST', '/api/browser/profiles/sync', codec.sync, args),
    readSync: (id, signal) => collectSync(id, (profile, target) => call('GET', `/api/browser/profile-sync/${encodeURIComponent(id)}`,
      codec.readSync, [id, profile, target, signal], signal), signal),
  }
}
