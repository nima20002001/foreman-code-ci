import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { captureGitSource, qualifiedGit } from '../src/modules/sources/capture.js'
import { SOURCE_LIMITS } from '../src/modules/sources/manifest.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

it('captures a complete committed repository at the entry limit into real private storage', async () => {
  const directory = await privateFixtureDirectory('entrypoints-source-capture-')
  const root = join(directory, 'repo')
  const storage = join(directory, 'storage')
  try {
    await mkdir(root, { mode: 0o700 })
    await mkdir(storage, { mode: 0o700 })
    await qualifiedGit(root, ['init', '-q', '--initial-branch=main'])
    const approvedPaths = ['AGENTS.md', ...Array.from({ length: SOURCE_LIMITS.entries - 1 },
      (_, index) => `sources/entry-${index}.ts`)]
    const bytes = Buffer.from('Committed fixture source.\n'.repeat(64))
    const imported = [
      'blob', 'mark :1', `data ${bytes.length}`, bytes.toString(),
      'commit refs/heads/main', 'committer Fixture <fixture@example.invalid> 0 +0000',
      'data 7', 'Fixture', ...approvedPaths.map(path => `M 100644 :1 ${path}`), '',
      'commit refs/heads/overflow', 'committer Fixture <fixture@example.invalid> 1 +0000',
      'data 8', 'Overflow', 'from refs/heads/main', 'M 100644 :1 overflow.ts', '', 'done', '',
    ].join('\n')
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'fast-import', '--quiet', '--done'], {
      input: imported, env: gitFixtureEnvironment(), timeout: 10_000,
    })
    const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
    await writeFile(join(root, 'AGENTS.md'), 'Uncommitted working tree changes.\n')
    const store = new PrivateSourceSnapshotStore(storage)
    const manifest = await captureGitSource({ root, commit, approvedSourceId: randomUUID(), executablePolicy: 'strip', sink: store })
    expect(manifest.git?.commit).toBe(commit)
    expect(manifest.entries.map(entry => entry.path)).toEqual([...approvedPaths].sort())
    expect(manifest.entries.length).toBeGreaterThan(2000)
    expect(manifest.totalEntries).toBe(SOURCE_LIMITS.entries)
    expect(manifest.totalBytes).toBe(bytes.length * SOURCE_LIMITS.entries)
    const entry = manifest.entries.find(value => value.path === 'AGENTS.md')!
    expect(Buffer.from(await store.read(manifest, entry, AbortSignal.timeout(1000))))
      .toEqual(await qualifiedGit(root, ['show', `${commit}:AGENTS.md`]))
    expect(Buffer.from(await store.read(manifest, entry, AbortSignal.timeout(1000)))).toEqual(bytes)

    const overflowCommit = (await qualifiedGit(root, ['rev-parse', 'refs/heads/overflow'])).toString().trim()
    const abort = vi.spyOn(store, 'abort')
    const publish = vi.spyOn(store, 'commit')
    try {
      await expect(captureGitSource({ root, commit: overflowCommit, approvedSourceId: randomUUID(),
        executablePolicy: 'strip', sink: store }))
        .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', status: 413 })
      expect(abort).toHaveBeenCalledOnce()
      expect(publish).not.toHaveBeenCalled()
    } finally {
      abort.mockRestore()
      publish.mockRestore()
    }
  } finally { await removeFixtureDirectory(directory) }
}, 60_000)

it('joins the actual Git child after cancellation with unread batch output', async () => {
  const directory = await privateFixtureDirectory('entrypoints-source-abort-'), root = join(directory, 'repo'), storage = join(directory, 'storage')
  await mkdir(root, { mode: 0o700 }); await mkdir(storage, { mode: 0o700 })
  const store = new PrivateSourceSnapshotStore(storage), abort = vi.spyOn(store, 'abort'), commitSink = vi.spyOn(store, 'commit')
  try {
    await qualifiedGit(root, ['init', '-q'])
    for (const name of ['first.bin', 'second.bin']) await writeFile(join(root, name), Buffer.alloc(512 * 1024, 1))
    await qualifiedGit(root, ['add', '.'])
    await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'Fixture'])
    const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim(), controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      await expect(captureGitSource({ root, commit, approvedSourceId: randomUUID(), executablePolicy: 'strip',
        sink: { write: async (...args) => { await store.write(...args); controller.abort(new Error('Capture stopped in sink.')) },
          commit: store.commit.bind(store), abort: store.abort.bind(store) } })).rejects.toThrow('Capture stopped in sink.')
      expect(abort).toHaveBeenCalledOnce(); expect(commitSink).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  } finally { vi.restoreAllMocks(); await removeFixtureDirectory(directory) }
})

it('quiesces every bounded pending private write before quarantining a failed capture', async () => {
  const directory = await privateFixtureDirectory('entrypoints-source-pipeline-'), root = join(directory, 'repo'), storage = join(directory, 'storage')
  await mkdir(root, { mode: 0o700 }); await mkdir(storage, { mode: 0o700 })
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), allEntered = new Promise<void>(resolve => { entered = resolve })
  let active = 0, peak = 0, count = 0
  const store = new PrivateSourceSnapshotStore(storage), abort = vi.spyOn(store, 'abort'), publish = vi.spyOn(store, 'commit')
  let captured: ReturnType<typeof captureGitSource> | undefined
  try {
    await qualifiedGit(root, ['init', '-q'])
    const paths = Array.from({ length: 12 }, (_, index) => `entry-${index}.txt`)
    for (const path of paths) await writeFile(join(root, path), 'Original bounded source bytes.\n')
    await qualifiedGit(root, ['add', '.']); await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'Fixture'])
    const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
    captured = captureGitSource({ root, commit, approvedSourceId: randomUUID(), executablePolicy: 'strip', sink: {
      write: async (...args) => {
        active++; peak = Math.max(peak, active)
        try { if (++count === 4) { entered(); throw new Error('Private source writer failed.') } await held; await store.write(...args) }
        finally { active-- }
      }, commit: store.commit.bind(store), abort: async id => { expect(active).toBe(0); await store.abort(id) },
    } })
    void captured.catch(() => {
      // ignore: attach before releasing pending writes; the capture rejection is asserted below.
    })
    await allEntered
    expect(peak).toBe(4); expect(abort).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
    release(); await expect(captured).rejects.toThrow('Private source writer failed.')
    expect(active).toBe(0); expect(abort).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled()
  } finally {
    release?.()
    await captured?.catch(() => {
      // ignore: cleanup joins the capture without replacing its asserted failure.
    })
    vi.restoreAllMocks()
    await removeFixtureDirectory(directory)
  }
})

it('maps its expired preparation budget to a typed retryable failure after private-write quiescence', async () => {
  const directory = await privateFixtureDirectory('entrypoints-source-timeout-'), root = join(directory, 'repo'), storage = join(directory, 'storage')
  await mkdir(root, { mode: 0o700 }); await mkdir(storage, { mode: 0o700 })
  const store = new PrivateSourceSnapshotStore(storage), controller = new AbortController(), abort = vi.spyOn(store, 'abort'), publish = vi.spyOn(store, 'commit')
  try {
    await qualifiedGit(root, ['init', '-q']); await writeFile(join(root, 'source.txt'), 'Original source bytes.')
    await qualifiedGit(root, ['add', '.']); await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'Fixture'])
    const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      await expect(captureGitSource({ root, commit, approvedSourceId: randomUUID(), executablePolicy: 'strip', sink: {
        write: async (...args) => { await store.write(...args); controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) },
        commit: store.commit.bind(store), abort: store.abort.bind(store),
      } })).rejects.toMatchObject({ code: 'SOURCE_CAPTURE_TIMEOUT', status: 503, details: { retryable: true, newCommandRequired: true } })
      expect(timeout).toHaveBeenCalledWith(300_000); expect(abort).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  } finally { vi.restoreAllMocks(); await removeFixtureDirectory(directory) }
})
