import { createHash } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { planCachedSelection } from './resultCacheStore.js'
import { GitCiCommits } from './commits.js'
import type { CiTestTree } from './resultCache.js'

const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
const selection = { workspaceId: 'workspace', repository: 'example/project', commit: 'a'.repeat(40),
  suite: 'unit', partOf: () => 'api' }
afterEach(() => { vi.useRealTimers() })

function fixture(label: string, count: number) {
  const files = Array.from({ length: count }, (_, index) => `apps/api/src/${label}-${index}.test.ts`)
  const shared = `apps/api/src/${label}-shared.ts`
  const contents = new Map([
    ...files.map((file, index) => [file, `import './${label}-shared.js'; export const value = ${index}`] as const),
    [shared, `export const shared = '${label}'`] as const,
  ])
  const blobs = new Map([...contents].map(([file, content]) =>
    [file, `100644:${createHash('sha1').update(content).digest('hex')}`]))
  return { files, shared, contents, blobs }
}

it('bounds blob reads across every selected file and reads a shared dependency once', async () => {
  const f = fixture('bounded', 64)
  let active = 0
  let peak = 0
  const reads = new Map<string, number>()
  const tree: CiTestTree = { blobs: f.blobs, read: async file => {
    active++
    peak = Math.max(peak, active)
    reads.set(file, (reads.get(file) ?? 0) + 1)
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return f.contents.get(file)!
  } }
  const result = await planCachedSelection(pool, { ...selection, files: f.files, tree: async () => tree })
  expect(Object.keys(result.keys)).toHaveLength(f.files.length)
  expect.soft(peak).toBeLessThanOrEqual(16)
  expect.soft(reads.get(f.shared)).toBe(1)
})

it('cancels active Git reads and leaves queued blobs unread when the key budget expires', async () => {
  const f = fixture('canceled', 64)
  const contents = new Map([...f.blobs].map(([file, blob]) => [blob.split(':')[1]!, f.contents.get(file)!]))
  let active = 0
  let started = 0
  let ready!: () => void
  const reading = new Promise<void>(resolve => { ready = resolve })
  const commits = new GitCiCommits({ cloneDirectory: () => process.cwd(), git: async (args, { signal }) => {
    if (args[0] === 'ls-tree') return { code: 0, stderr: '', stdout: [...f.blobs]
      .map(([file, blob]) => `100644 blob ${blob.split(':')[1]}\t${file}\0`).join('') }
    if (args[0] !== 'cat-file' || args[1] !== 'blob') return { code: 0, stdout: '', stderr: '' }
    started++
    active++
    ready()
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => { active--; reject(signal.reason) }, { once: true })
      if (signal.aborted) { active--; resolve() }
    })
    return { code: 0, stdout: contents.get(args[2]!)!, stderr: '' }
  } })
  vi.useFakeTimers()
  const pending = planCachedSelection(pool, { ...selection, files: f.files,
    tree: (signal?: AbortSignal) => commits.testTree(selection.repository, selection.commit, signal) })
  await reading
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await pending).toEqual({ files: f.files.sort(), keys: {}, cached: [] })
  expect(active).toBe(0)
  const stoppedAt = started
  await vi.advanceTimersByTimeAsync(30_000)
  expect(started).toBe(stoppedAt)
})
