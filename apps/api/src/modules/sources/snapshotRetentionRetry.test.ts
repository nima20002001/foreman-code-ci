import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { releaseUnusedSourceSnapshots } from './snapshotRetention.js'
import type { PrivateSourceSnapshotStore } from './store.js'

const store: Pick<PrivateSourceSnapshotStore, 'remove' | 'withCaptureLock'> = {
  remove: async () => { throw new Error('Unexpected snapshot deletion') },
  withCaptureLock: async (_id, work) => work(),
}
afterEach(() => vi.useRealTimers())

it('reports failed maintenance scans without aborting reconciliation and backs off repeated scans', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const error = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  const query = vi.fn().mockRejectedValue(error)
  const pool = { query } as unknown as pg.Pool
  const report = vi.fn()
  await expect(releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledExactlyOnceWith(error)
  for (let attempt = 1; attempt <= 5; attempt++) {
    vi.setSystemTime(Date.now() + Math.min(60 * 60_000, 10 * 60_000 * 2 ** (attempt - 1)) - 1)
    await releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)
    expect(query).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 1)
    await releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)
    expect(query).toHaveBeenCalledTimes(attempt + 1)
    expect(report).toHaveBeenCalledTimes(attempt + 1)
  }
  // Capacity-driven scans must still attempt reclamation and report their own failures.
  await expect(releaseUnusedSourceSnapshots(pool, store, 'storage-scope', undefined, true)).rejects.toBe(error)
  expect(query).toHaveBeenCalledTimes(7)
})

it('checks every retained snapshot in bounded batches without deleting protected sources', async () => {
  const candidates = Array.from({ length: 123 }, (_, index) => ({ snapshot_id: `snapshot-${index}`,
    requested_by: 'operator', command_id: `capture-${index}` }))
  const checked: string[][] = []
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes('from source_approvals')) return { rows: candidates }
    if (Array.isArray(values?.[0])) {
      checked.push(values[0] as string[])
      // The database reports these snapshots as protected by active consumers.
      return { rows: [] }
    }
    return { rows: [] }
  }
  const report = vi.fn()
  await releaseUnusedSourceSnapshots({ query } as unknown as pg.Pool, store, 'storage-scope', report)
  expect(report).not.toHaveBeenCalled()
  expect(checked.flat()).toEqual(candidates.map(candidate => candidate.snapshot_id))
  expect(Math.max(...checked.map(batch => batch.length))).toBeLessThanOrEqual(50)
})
