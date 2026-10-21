import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startWorkerPublicationSync } from './workerPublicationSync.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'worker-publication-sync-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const write = async (state: string) => {
    const index = { format: 1, version: '1.0.0', artifacts: [], publication: { state, lastError: null } }
    const temporary = join(directory, '.publishing')
    await writeFile(temporary, JSON.stringify(index))
    await rename(temporary, join(directory, 'index.json'))
  }
  await write('pending')
  const sync = vi.fn(async () => {})
  const reportError = vi.fn()
  const stop = startWorkerPublicationSync({ directory, version: '1.0.0' }, sync, reportError)
  cleanup.push(stop)
  return { directory, write, sync, reportError, stop }
}

it('checks devices as soon as publication completes after an early unpublished check', async () => {
  const f = await fixture()
  await f.write('failed')
  await f.write('pending')
  expect(f.sync).not.toHaveBeenCalled()
  await f.write('published')
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledOnce())
  expect(f.reportError).not.toHaveBeenCalled()
})

it('checks a publication that completes before the watcher starts', async () => {
  const f = await fixture()
  f.stop()
  await f.write('published')
  cleanup.push(startWorkerPublicationSync({ directory: f.directory, version: '1.0.0' }, f.sync, f.reportError))
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledOnce())
})

it('retains periodic recovery checks and stops them on shutdown', async () => {
  vi.useFakeTimers()
  try {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sync).toHaveBeenCalledOnce()
    f.stop()
    await f.write('published')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sync).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('starts before the first Worker artifact directory exists and synchronizes its later publication', async () => {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const root = await mkdtemp(join(storage, 'worker-first-publication-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'worker-artifacts')
  const publications: string[] = []
  const sync = vi.fn(async () => {
    const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
    publications.push(index.publication.state)
  })
  const reportError = vi.fn()
  vi.useFakeTimers()
  try {
    const stop = startWorkerPublicationSync({ directory, version: '1.0.0' }, sync, reportError)
    cleanup.push(stop)
    expect(sync).not.toHaveBeenCalled()
    await mkdir(directory)
    await writeFile(join(directory, 'index.json'), JSON.stringify({
      format: 1, version: '1.0.0', artifacts: [], publication: { state: 'published', lastError: null },
    }))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(publications).toEqual(['published']))
    expect(sync).toHaveBeenCalledOnce()
    expect(reportError).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
