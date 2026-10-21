import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import { BrowserFileStore, type BrowserFileOwner } from './files.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'foreman-browser-files-'))
  directories.push(directory)
  const owner: BrowserFileOwner = { sessionId: 'owned-session', tabId: 'owned-tab', browserGeneration: 1 }
  let closed = false
  const authorize = vi.fn(async (candidate: BrowserFileOwner, mutate: boolean): Promise<void> => {
    if (candidate.sessionId !== owner.sessionId) throw new DomainError('BROWSER_FILE_SCOPE', 'Wrong session.', 403)
    if (closed && mutate) throw new DomainError('BROWSER_SESSION_CLOSED', 'Session is closed.', 409)
  })
  const root = join(directory, 'owned-files')
  return { directory, root, owner, authorize, store: new BrowserFileStore(root, authorize), close: () => { closed = true } }
}

async function completeSmallUpload(store: BrowserFileStore, owner: BrowserFileOwner, commandId = 'upload') {
  const bytes = new Uint8Array([4, 5, 6])
  const file = await store.begin({ ...owner, commandId, name: 'fixture.txt', mimeType: 'text/plain', byteLength: bytes.length })
  await store.write({ fileId: file.id, sessionId: owner.sessionId, offset: 0, bytes })
  return store.finish(file.id, owner.sessionId)
}

it('retains upload identity and ordered chunk receipts through identical retries, conflicting bytes and storage reopen', async () => {
  const { store, owner, root, authorize } = await fixture()
  const prefix = Uint8Array.from({ length: 262_144 }, (_, index) => index % 251), suffix = new Uint8Array([17, 18, 19])
  const input = { ...owner, commandId: 'same-upload', name: 'fixture.bin', mimeType: 'application/octet-stream', byteLength: prefix.length + suffix.length }
  const file = await store.begin(input)
  expect((await store.begin(input)).id).toBe(file.id)
  await expect(store.begin({ ...input, name: 'different.bin' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  await expect(store.write({ fileId: file.id, sessionId: owner.sessionId, offset: prefix.length, bytes: suffix }))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_OFFSET' })
  await store.write({ fileId: file.id, sessionId: owner.sessionId, offset: 0, bytes: prefix })
  expect((await store.write({ fileId: file.id, sessionId: owner.sessionId, offset: 0, bytes: prefix })).receivedBytes).toBe(prefix.length)
  const different = prefix.slice(); different[0] = 255
  await expect(store.write({ fileId: file.id, sessionId: owner.sessionId, offset: 0, bytes: different }))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_CHUNK_CONFLICT' })
  await expect(store.finish(file.id, owner.sessionId)).rejects.toMatchObject({ code: 'BROWSER_FILE_INCOMPLETE' })
  await expect(store.write({ fileId: file.id, sessionId: 'foreign-session', offset: prefix.length, bytes: suffix }))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_SCOPE' })
  const reopened = new BrowserFileStore(root, authorize)
  await reopened.write({ fileId: file.id, sessionId: owner.sessionId, offset: prefix.length, bytes: suffix })
  const completed = await reopened.finish(file.id, owner.sessionId)
  expect(completed).toMatchObject({ state: 'ready', receivedBytes: input.byteLength,
    sha256: createHash('sha256').update(prefix).update(suffix).digest('hex') })
  expect(new Uint8Array(await reopened.read(file.id, owner.sessionId, 0, prefix.length))).toEqual(prefix)
  expect(new Uint8Array(await reopened.read(file.id, owner.sessionId, prefix.length, 100))).toEqual(suffix)
  await expect(reopened.read(file.id, 'foreign-session', 0, 1)).rejects.toMatchObject({ code: 'BROWSER_FILE_SCOPE' })
  await expect(reopened.read(file.id, owner.sessionId, 0, 262_145)).rejects.toMatchObject({ code: 'BROWSER_FILE_RANGE' })
})

it('binds native attachment to the exact owned tab/generation and never repeats an uncertain native effect', async () => {
  const { store, owner, root, authorize } = await fixture(), file = await completeSmallUpload(store, owner)
  const native = vi.fn(async (privatePath: string) => {
    expect(await readFile(privatePath)).toEqual(Buffer.from([4, 5, 6]))
    throw new Error('Native response was lost after attachment')
  })
  await expect(store.attach(file.id, { ...owner, tabId: 'another-owned-tab' }, 'wrong-tab', native))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_SCOPE' })
  await expect(store.attach(file.id, { ...owner, browserGeneration: 2 }, 'wrong-generation', native))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_SCOPE' })
  expect(native).not.toHaveBeenCalled()
  await expect(store.attach(file.id, owner, 'attach-once', native)).rejects.toThrow('Native response was lost')
  const reopened = new BrowserFileStore(root, authorize)
  await expect(reopened.attach(file.id, owner, 'attach-once', native)).rejects.toMatchObject({ code: 'BROWSER_RESULT_UNKNOWN' })
  expect(native).toHaveBeenCalledTimes(1)
  expect(await reopened.metadata(file.id, owner.sessionId)).toMatchObject({ state: 'failed' })
})

it('replays a completed same-command attachment without another native call', async () => {
  const { store, owner } = await fixture(), file = await completeSmallUpload(store, owner)
  const native = vi.fn(async (privatePath: string) => { expect(await readFile(privatePath)).toEqual(Buffer.from([4, 5, 6])) })
  expect(await store.attach(file.id, owner, 'attached', native)).toMatchObject({ state: 'attached' })
  expect(await store.attach(file.id, owner, 'attached', native)).toMatchObject({ state: 'attached' })
  expect(native).toHaveBeenCalledTimes(1)
})

it('retains completed downloads after session close, cleans unfinished uploads, and deletes only the explicitly selected file', async () => {
  const { directory, store, owner, close } = await fixture()
  const upload = await store.begin({ ...owner, commandId: 'unfinished', name: 'unfinished.txt', mimeType: 'text/plain', byteLength: 3 })
  const download = join(directory, 'native-download'), bytes = Buffer.from('completed website download')
  await writeFile(download, bytes, { mode: 0o600 })
  const retained = await store.adoptDownload(owner, 'native-download-id', download, 'report.txt', bytes.length)
  close(); await store.closeSession(owner.sessionId)
  expect(await store.metadata(upload.id, owner.sessionId)).toMatchObject({ state: 'canceled' })
  expect(await store.list(owner.sessionId)).toEqual([expect.objectContaining({ id: retained.id, purpose: 'download', state: 'ready' })])
  expect(await store.read(retained.id, owner.sessionId, 0, bytes.length)).toEqual(bytes)
  await expect(store.begin({ ...owner, commandId: 'late', name: 'late.txt', mimeType: 'text/plain', byteLength: 0 }))
    .rejects.toMatchObject({ code: 'BROWSER_FILE_SESSION_CLOSED' })
  await store.cancel(retained.id, owner.sessionId)
  expect(await store.list(owner.sessionId)).toEqual([])
  await expect(store.read(retained.id, owner.sessionId, 0, 1)).rejects.toMatchObject({ code: 'BROWSER_FILE_RANGE' })
})
