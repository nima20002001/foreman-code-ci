import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserFileStore, type BrowserFileOwner } from './files.js'
import { held, runtimeRecoveryFixture } from './recovery.test-support.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

it('counts admitted maintenance during drain, denies new storage work, then permits it only after resume', async () => {
  const f = await runtimeRecoveryFixture(); cleanup.push(f.cleanup)
  const entered = held<void>(), finish = held<void>()
  const exporting = f.broker.withProfileMaintenance('profile', async () => { entered.resolve(); await finish.promise })
  await entered.promise
  f.broker.stopAdmission()
  expect(f.broker.accepting()).toBe(false)
  expect(f.broker.activeSessionCount()).toBe(1)
  const mutate = vi.fn(async () => undefined)
  await expect(f.broker.withProfileMaintenance('other-profile', mutate)).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_DRAINING' })
  expect(mutate).not.toHaveBeenCalled()
  finish.resolve(); await exporting
  expect(f.broker.activeSessionCount()).toBe(0)
  await expect(f.broker.withProfileMaintenance('profile', mutate)).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_DRAINING' })
  f.broker.resumeAdmission(); await f.broker.withProfileMaintenance('profile', mutate)
  expect(mutate).toHaveBeenCalledTimes(1)
})

it('retains deferred capture cleanup through session close and retries a failed native stop without opening another capture', async () => {
  const f = await runtimeRecoveryFixture(); cleanup.push(f.cleanup)
  const session = await f.prepare(), entered = held<void>(), capture = held<() => Promise<void>>()
  const stop = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('native stop unconfirmed'))
  vi.mocked(f.driver.capture).mockImplementationOnce(async () => { entered.resolve(); return capture.promise })
  const input = { ownerId: 'viewer', viewerId: 'viewer', sessionId: session.id, tabId: session.selectedTabId!,
    browserGeneration: session.browserGeneration, commandId: 'open-once' }
  const opening = f.media.open(input).then(() => null, error => error)
  await entered.promise
  let finished = false
  const closing = f.media.closeSession(session.id).then(() => { finished = true; return null }, error => error)
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(stop).not.toHaveBeenCalled()
  capture.resolve(stop)
  expect(await closing).toMatchObject({ message: 'native stop unconfirmed' })
  expect(await opening).toBeInstanceOf(Error)
  await f.media.closeSession(session.id)
  expect(stop).toHaveBeenCalledTimes(2)
  await expect(f.media.open(input)).rejects.toMatchObject({ code: 'BROWSER_VIEW_CLOSED' })
  expect(f.driver.capture).toHaveBeenCalledTimes(1)
})

it('canonical lifecycle release fences staged files even when capture cleanup is pending and retains completed execution downloads', async () => {
  const f = await runtimeRecoveryFixture(); cleanup.push(f.cleanup)
  const session = await f.prepare(), owner = { sessionId: session.id, tabId: session.selectedTabId!, browserGeneration: session.browserGeneration }
  const upload = await f.files.begin({ ...owner, commandId: 'upload', name: 'upload.txt', mimeType: 'text/plain', byteLength: 3 })
  const native = join(f.directory, 'execution-output'); await writeFile(native, 'result', { mode: 0o600 })
  const download = await f.files.adoptDownload(owner, 'output', native, 'result.txt', 6)
  const stop = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('capture still stopping'))
  vi.mocked(f.driver.capture).mockResolvedValueOnce(stop)
  await f.media.open({ ...owner, ownerId: 'viewer', viewerId: 'viewer', commandId: 'view' })
  const input = { sessionId: session.id, subject: f.subject, commandId: 'terminal', reason: 'terminal' as const }
  expect(await f.broker.release(input)).toMatchObject({ state: 'pending' })
  expect(await f.files.metadata(upload.id, session.id)).toMatchObject({ state: 'canceled' })
  expect(f.driver.closeTab).not.toHaveBeenCalled()
  await expect(f.files.begin({ ...owner, commandId: 'late', name: 'late.txt', mimeType: 'text/plain', byteLength: 0 }))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_SESSION_CLOSED' })
  expect(await f.broker.release(input)).toMatchObject({ state: 'closed' })
  expect(await f.broker.release(input)).toMatchObject({ state: 'already_closed' })
  expect(stop).toHaveBeenCalledTimes(2)
  expect(await f.files.read(download.id, session.id, 0, 20)).toEqual(Buffer.from('result'))
})

it('fences delayed file admissions, deletes late native downloads after restart, and retains completed downloads on normal close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-file-close-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'files'), owner: BrowserFileOwner = { sessionId: 'setup-session', tabId: 'tab', browserGeneration: 1 }
  const entered = held<void>(), continueAdmission = held<void>()
  const authorize = vi.fn(async (_owner: BrowserFileOwner, mutate: boolean) => {
    if (mutate) { entered.resolve(); await continueAdmission.promise }
  })
  const files = new BrowserFileStore(root, authorize), savedPath = join(directory, 'completed')
  await writeFile(savedPath, 'completed', { mode: 0o600 })
  const saved = await files.adoptDownload(owner, 'completed', savedPath, 'completed.txt', 9)
  const begin = files.begin({ ...owner, commandId: 'pending-upload', name: 'upload.txt', mimeType: 'text/plain', byteLength: 3 })
  await entered.promise
  const closing = files.closeSession(owner.sessionId)
  continueAdmission.resolve()
  const pending = await begin; await closing
  expect(await files.metadata(pending.id, owner.sessionId)).toMatchObject({ state: 'canceled' })
  expect(await files.read(saved.id, owner.sessionId, 0, 20)).toEqual(Buffer.from('completed'))
  const reopened = new BrowserFileStore(root, async () => undefined), latePath = join(directory, 'late-native')
  await writeFile(latePath, 'late', { mode: 0o600 })
  expect(await reopened.trackDownload(owner, 'late', 'late.txt', 4, 2, false)).toMatchObject({ state: 'canceled' })
  expect(await reopened.adoptDownload(owner, 'late', latePath, 'late.txt', 4)).toMatchObject({ state: 'canceled' })
  await expect(readFile(latePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await reopened.list(owner.sessionId)).toEqual([expect.objectContaining({ id: saved.id, state: 'ready' })])
})

it('waits for a setup download read before profile cleanup while preserving another execution’s completed output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-profile-files-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const setup: BrowserFileOwner = { sessionId: 'setup', tabId: 'setup-tab', browserGeneration: 1 }
  const execution: BrowserFileOwner = { sessionId: 'execution', tabId: 'execution-tab', browserGeneration: 1 }
  const readEntered = held<void>(), releaseRead = held<void>(); let blockRead = false
  const files = new BrowserFileStore(join(directory, 'files'), async (owner, mutate) => {
    if (!mutate && blockRead && owner.sessionId === setup.sessionId) { readEntered.resolve(); await releaseRead.promise }
  })
  const make = async (owner: BrowserFileOwner, name: string) => {
    const path = join(directory, name); await writeFile(path, name, { mode: 0o600 })
    return files.adoptDownload(owner, name, path, `${name}.txt`, name.length)
  }
  const setupFile = await make(setup, 'setup'), executionFile = await make(execution, 'execution')
  blockRead = true
  const reading = files.read(setupFile.id, setup.sessionId, 0, 10)
  await readEntered.promise
  const deleting = files.closeSession(setup.sessionId, true)
  blockRead = false; releaseRead.resolve()
  expect(await reading).toEqual(Buffer.from('setup')); await deleting
  expect(await files.list(setup.sessionId)).toEqual([])
  expect(await files.read(executionFile.id, execution.sessionId, 0, 20)).toEqual(Buffer.from('execution'))
})
