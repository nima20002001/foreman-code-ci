import { closeSync, fstatSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { openPrivateRoot } from './privateFilesystem.js'
import { sourceFileWriter } from './sourceFileWriter.js'
import { sourceSha256 } from './manifest.js'

const state = vi.hoisted(() => ({ missingHelper: false, failedDataWait: false, files: [] as number[] }))
vi.mock('./sourceTreeFlush.js', async original => {
  const actual = await original<typeof import('./sourceTreeFlush.js')>()
  return { flushSourceTree: async (...args: Parameters<typeof actual.flushSourceTree>) => {
    if (state.missingHelper) return false
    if (state.failedDataWait && args[2].mode === 'qualify') return true
    if (state.failedDataWait && args[2].mode === 'data') {
      state.files = [...args[2].files]
      throw new Error('Data writeback failed')
    }
    return actual.flushSourceTree(...args)
  } }
})
const roots: string[] = []
afterEach(async () => {
  state.missingHelper = false
  state.failedDataWait = false
  state.files = []
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-file-writer-'))
  roots.push(root)
  const tree = await openPrivateRoot(root)
  const bytes = Buffer.from('approved bytes\n')
  const entry = { path: 'source.txt', kind: 'file' as const, byteSize: bytes.length,
    sha256: sourceSha256(bytes), executable: true }
  return { root, tree, bytes, entry }
}

it('preserves bytes and approved executable permissions when the optional helper is unavailable', async () => {
  const f = await fixture()
  state.missingHelper = true
  const writer = await sourceFileWriter(f.tree, 0o400, AbortSignal.timeout(5000))
  try {
    await writer.write(f.tree, f.entry, f.bytes)
    await writer.finish()
    expect(await readFile(join(f.root, f.entry.path))).toEqual(f.bytes)
    expect((await stat(join(f.root, f.entry.path))).mode & 0o777).toBe(0o500)
  } finally { writer.close(); await f.tree.close() }
})

it('rejects failed data waits before publishing completion and closes owned write descriptors', async () => {
  const f = await fixture()
  state.failedDataWait = true
  const writer = await sourceFileWriter(f.tree, 0o600, AbortSignal.timeout(5000))
  try {
    await writer.write(f.tree, f.entry, f.bytes)
    await expect(writer.finish()).rejects.toThrow('Data writeback failed')
    expect(state.files).toHaveLength(1)
    for (const file of state.files) {
      expect(() => fstatSync(file)).toThrow(expect.objectContaining({ code: 'EBADF' }))
    }
    expect(await readFile(join(f.root, f.entry.path))).toEqual(f.bytes)
  } finally {
    writer.close()
    const files = state.files
    onTestFinished(() => {
      for (const file of files) {
        try {
          fstatSync(file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EBADF') continue
          throw error
        }
        closeSync(file)
      }
    })
    await f.tree.close()
  }
})
