import { afterEach, expect, it, vi } from 'vitest'
import { BrowserProfileSyncCoordinator, admitBrowserProfileSync, readBrowserProfileSync } from './sync.js'
import { reconcileBrowserProfileIntent } from './reconcile.js'
import { profileWorkFixture } from './work.test-support.js'
import { held } from '../browser-runtime/recovery.test-support.js'
import { DomainError } from '../errors.js'
import { BrowserProfileSyncJobSchema, BrowserProfileSyncPageSchema } from '@foreman-code/contracts/browser-profiles'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

it('starts from retained pending creates, waits for in-flight work on stop, and recovers removal with a replacement dispatcher', async () => {
  const f = profileWorkFixture(), entered = held<void>(), finish = held<void>()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source', commandId: 'create' })).value
  vi.mocked(f.host.create).mockImplementationOnce(async () => { entered.resolve(); await finish.promise })
  expect(f.host.create).not.toHaveBeenCalled()
  const first = f.dispatcher(); cleanup.push(() => first.stop()); first.start()
  await entered.promise
  let stopped = false
  const stopping = first.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  finish.resolve(); await stopping
  expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([{ profileId: profile.id, computerId: 'source' }])
  await f.service.remove(f.owner, { profileId: profile.id, computerId: 'source', commandId: 'remove' })
  first.wake()
  expect(f.host.remove).not.toHaveBeenCalled()
  const recovered = f.dispatcher(); cleanup.push(() => recovered.stop()); recovered.start()
  await vi.waitFor(async () => expect((await f.service.catalog(f.owner)).pendingReplicas).toEqual([]))
  expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([])
  expect(f.host.create).toHaveBeenCalledTimes(1)
  expect(f.host.remove).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

it('advances a retained immutable sync after a wake/restart while repeated offline and busy passes preserve visible revisions', async () => {
  const f = profileWorkFixture(), profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source', commandId: 'create' })).value
  const create = (await f.service.get(f.owner, profile.id)).operations[0]!
  await reconcileBrowserProfileIntent(f.service, create.id)
  f.statuses.set('worker', 'offline')
  const jobId = (await admitBrowserProfileSync(f.service, f.owner, { profileIds: [profile.id], commandId: 'sync' })).value.id
  const coordinator = new BrowserProfileSyncCoordinator(f.service)
  const readJob = async () => (await readBrowserProfileSync(f.service, f.owner, { jobId })).job
  await coordinator.reconcile(jobId)
  const offline = await readJob(), offlineRevision = (await f.service.catalog(f.owner)).revision
  await coordinator.reconcile(jobId); await coordinator.reconcile(jobId)
  expect(await readJob()).toEqual(offline)
  expect((await f.service.catalog(f.owner)).revision).toBe(offlineRevision)
  f.statuses.set('worker', 'busy')
  await coordinator.reconcile(jobId)
  const busy = await readJob(), busyRevision = (await f.service.catalog(f.owner)).revision
  await coordinator.reconcile(jobId); await coordinator.reconcile(jobId)
  expect(await readJob()).toEqual(busy)
  expect((await f.service.catalog(f.owner)).revision).toBe(busyRevision)
  expect(f.host.receive).not.toHaveBeenCalled(); expect(f.host.apply).not.toHaveBeenCalled()
  const dispatcher = f.dispatcher(); cleanup.push(() => dispatcher.stop()); dispatcher.start()
  await vi.waitFor(() => expect(f.host.status).toHaveBeenCalled())
  f.statuses.set('worker', 'ready'); dispatcher.wake()
  await vi.waitFor(async () => expect((await readJob()).state).toBe('completed'))
  await dispatcher.stop()
  const completed = await readJob()
  expect(completed.targets.find(value => value.computerId === 'worker')?.snapshot).toEqual(offline.targets.find(value => value.computerId === 'worker')?.snapshot)
  expect(f.host.export).toHaveBeenCalledTimes(1)
  expect(f.host.receive).toHaveBeenCalledTimes(1); expect(f.host.apply).toHaveBeenCalledTimes(1)
  await new BrowserProfileSyncCoordinator(f.service).reconcile(jobId)
  expect(await readJob()).toEqual(completed)
  expect(f.host.apply).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

it('leaves an offline create pending without catalog revision churn and processes it after explicit readiness wake', async () => {
  const f = profileWorkFixture(); f.statuses.set('source', 'offline')
  const profile = (await f.service.create(f.owner, { name: 'Offline profile', computerId: 'source', commandId: 'create-offline' })).value
  const intent = (await f.service.get(f.owner, profile.id)).operations[0]!
  await reconcileBrowserProfileIntent(f.service, intent.id)
  const before = await f.service.catalog(f.owner)
  await reconcileBrowserProfileIntent(f.service, intent.id); await reconcileBrowserProfileIntent(f.service, intent.id)
  expect(await f.service.catalog(f.owner)).toEqual(before)
  const dispatcher = f.dispatcher(); cleanup.push(() => dispatcher.stop()); dispatcher.start()
  f.statuses.set('source', 'ready'); dispatcher.wake()
  await vi.waitFor(async () => expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([{ profileId: profile.id, computerId: 'source' }]))
  expect(f.host.create).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

it('keeps an explicitly removed replica excluded from global sync until an explicit add', async () => {
  const f = profileWorkFixture()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  await reconcileBrowserProfileIntent(f.service, (await f.service.get(f.owner, profile.id)).operations[0]!.id)
  const initial = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  await new BrowserProfileSyncCoordinator(f.service).reconcile(initial.id)
  const removed = await f.service.remove(f.owner, { profileId: profile.id, computerId: 'worker' })
  await reconcileBrowserProfileIntent(f.service, removed.value[0]!.id)
  const job = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  expect(job.targets.find(value => value.computerId === 'worker')).toMatchObject({ state: 'excluded', exclusion: 'removed' })
  await new BrowserProfileSyncCoordinator(f.service).reconcile(job.id)
  expect(f.host.receive).toHaveBeenCalledTimes(1)
  await f.service.addExisting(f.owner, { profileId: profile.id, computerId: 'worker' })
  const next = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  expect(next.targets.find(value => value.computerId === 'worker')).toMatchObject({ state: 'queued', exclusion: null })
  expect((await new BrowserProfileSyncCoordinator(f.service).reconcile(next.id)).state).toBe('completed')
  expect(f.host.apply).toHaveBeenCalledTimes(2)
})

it.each(['export', 'apply'] as const)('retries the same admitted %s when maintenance races a busy profile', async operation => {
  const f = profileWorkFixture()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  await reconcileBrowserProfileIntent(f.service, (await f.service.get(f.owner, profile.id)).operations[0]!.id)
  vi.mocked(f.host[operation]).mockRejectedValueOnce(new DomainError('PROFILE_BUSY', 'Profile became busy.', 409))
  const job = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  const coordinator = new BrowserProfileSyncCoordinator(f.service)
  const waiting = await coordinator.reconcile(job.id)
  expect(waiting.state).toBe('running')
  expect(waiting.profiles.every(value => value.state !== 'failed')).toBe(true)
  expect(waiting.targets.every(value => value.state !== 'failed')).toBe(true)
  expect((await coordinator.reconcile(job.id)).state).toBe('completed')
  const calls = vi.mocked(f.host[operation]).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
})

it('keeps profile metadata associated with every independently paginated sync target', async () => {
  const f = profileWorkFixture()
  await f.service.create(f.owner, { name: 'First', computerId: 'source' })
  await f.service.create(f.owner, { name: 'Second', computerId: 'source' })
  const job = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  const first = await readBrowserProfileSync(f.service, f.owner, { jobId: job.id, limit: 1 })
  expect(first.nextProfileCursor).not.toBeNull()
  expect(first.nextTargetCursor).not.toBeNull()
  const second = await readBrowserProfileSync(f.service, f.owner, { jobId: job.id, limit: 1,
    profileCursor: first.nextProfileCursor!, targetCursor: first.nextTargetCursor! })
  expect(second.job.targets).toHaveLength(1)
  expect(second.job.profiles.map(value => value.profileId)).toContain(second.job.targets[0]!.profileId)
  expect(BrowserProfileSyncPageSchema.safeParse(second).success).toBe(true)
})

it('reads a partial job page without presenting that page as a complete job', async () => {
  const f = profileWorkFixture()
  f.statuses.set('another-worker', 'ready')
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  await reconcileBrowserProfileIntent(f.service, (await f.service.get(f.owner, profile.id)).operations[0]!.id)
  vi.mocked(f.host.apply).mockRejectedValueOnce(new DomainError('SNAPSHOT_INVALID', 'Invalid transfer.', 422))
  const job = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  expect((await new BrowserProfileSyncCoordinator(f.service).reconcile(job.id)).state).toBe('partial')
  const page = await readBrowserProfileSync(f.service, f.owner, { jobId: job.id, limit: 1 })
  expect(page.job.state).toBe('partial')
  expect(page.job.targets).toHaveLength(1)
  expect(BrowserProfileSyncPageSchema.safeParse(page).success).toBe(true)
  expect(BrowserProfileSyncJobSchema.safeParse(page.job).success).toBe(false)
  expect(BrowserProfileSyncPageSchema.safeParse({ ...page, job: { ...page.job, profiles: [] } }).success).toBe(false)
})
