import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { describe, it } from 'vitest'

import type { FileCleanupBytes, FileCleanupCandidate, FileCleanupRepository } from '../src/modules/files/cleanup/repository.js'
import { TemporaryFileCleanupSweeper } from '../src/modules/files/cleanup/sweeper.js'
import { deferred } from './helpers/deferred.js'

function value(n: number): FileCleanupCandidate {
  return { fileId: `file-${n}`, revisionId: `revision-${n}`, ownerPrincipalId: 'owner', requestId: `request-${n}`,
    storageKey: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    expiresAt: '2026-09-01 00:00:00+00', retentionRevision: 0 }
}
function fixture() {
  const deleted: string[] = [], errors: unknown[] = []
  let closed = false
  const bytes: FileCleanupBytes = {
    scan: async () => ({ keys: [], exhausted: true }),
    remove: async (key) => { deleted.push(key); return true },
    close: async () => { closed = true },
  }
  const repository: FileCleanupRepository = {
    findDue: async () => [], findByStorageKeys: async () => [],
    remove: async (_value, unlink) => await unlink() ? 'cleaned' : 'remaining',
  }
  return { bytes, repository, deleted, errors, closed: () => closed,
    report: (error: unknown) => { errors.push(error) } }
}
function timer() {
  const waits: { milliseconds: number; wake: () => void }[] = []
  return { waits, wait: (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const wake = () => { signal.removeEventListener('abort', wake); resolve() }
    waits.push({ milliseconds, wake })
    if (signal.aborted) wake(); else signal.addEventListener('abort', wake, { once: true })
  }) }
}

describe('FIL-04 cleanup batches and process lifecycle', () => {
  it('bounds both discovery channels and deduplicates the head also seen on disk', async () => {
    const f = fixture(), first = value(1), second = value(2), oldRevision = value(3)
    f.repository.findDue = async (after, limit) => { assert.equal(after, null); assert.equal(limit, 2); return [first, second] }
    f.bytes.scan = async (limit) => { assert.equal(limit, 2); return { keys: [first.storageKey, oldRevision.storageKey], exhausted: false } }
    f.repository.findByStorageKeys = async (keys) => { assert.equal(keys.length, 2); return [first, oldRevision] }
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report, { batchSize: 2 })
    const batch = await sweeper.sweep()
    assert.equal(batch.visited, 3); assert.equal(batch.cleaned, 3); assert.equal(batch.hasMore, true)
    assert.deepEqual(f.deleted, [first.storageKey, second.storageKey, oldRevision.storageKey])
    await sweeper.stop()
  })

  it('advances past a failed file, completes later files and wraps its metadata cursor', async () => {
    const f = fixture(), afters: (string | null)[] = []
    f.repository.findDue = async (after) => {
      afters.push(after)
      return after === null ? [value(1), value(2)] : [value(3)]
    }
    f.bytes.remove = async (key) => {
      if (key === value(1).storageKey) throw new Error('synthetic filesystem failure')
      f.deleted.push(key); return true
    }
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report, { batchSize: 2 })
    assert.equal((await sweeper.sweep()).errors, 1)
    assert.equal((await sweeper.sweep()).cleaned, 1)
    assert.equal((await sweeper.sweep()).errors, 1)
    assert.deepEqual(afters, [null, 'file-2', null])
    assert.ok(f.deleted.includes(value(3).storageKey))
    assert.equal(f.errors.length, 2)
    await sweeper.stop()
  })

  it('restarts with no cursor and finds tombstones from remaining disk keys', async () => {
    const f = fixture(), cursors: (string | null)[] = []
    f.repository.findDue = async (after) => { cursors.push(after); return [] }
    f.bytes.scan = async () => ({ keys: [value(4).storageKey], exhausted: true })
    f.repository.findByStorageKeys = async () => [value(4)]
    const first = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report)
    await first.sweep(); await first.stop()
    const restarted = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report)
    await restarted.sweep(); await restarted.stop()
    assert.deepEqual(cursors, [null, null])
    assert.deepEqual(f.deleted, [value(4).storageKey, value(4).storageKey])
  })

  it('does not turn a discovery candidate into byte-deletion authority', async () => {
    const f = fixture()
    f.repository.findDue = async () => [value(1), value(2)]
    f.repository.remove = async (candidate) => candidate.fileId === 'file-1' ? 'stale' : 'busy'
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report)
    const batch = await sweeper.sweep()
    assert.equal(batch.stale, 1); assert.equal(batch.busy, 1)
    assert.deepEqual(f.deleted, [])
    await sweeper.stop()
  })

  it('coalesces concurrent calls and drains an in-flight deletion before closing cursors', async () => {
    const f = fixture(), entered = deferred(), release = deferred()
    f.repository.findDue = async () => [value(1), value(2)]
    f.repository.remove = async (_candidate, unlink) => {
      entered.resolve(); await release.promise
      await unlink(); return 'cleaned'
    }
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report)
    const first = sweeper.sweep(), second = sweeper.sweep()
    assert.equal(first, second)
    await entered.promise
    const stopping = sweeper.stop()
    await turn(); assert.equal(f.closed(), false)
    release.resolve(); await stopping
    assert.equal((await first).visited, 1, 'Stop must not begin another deletion')
    assert.equal(f.closed(), true)
  })

  it('starts immediately, paces catch-up, uses capped exponential error backoff and resets after recovery', async () => {
    const f = fixture(), t = timer()
    let fail = true, batches = 0
    f.repository.findDue = async () => { batches++; if (fail) throw new Error('database offline'); return [] }
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report,
      { wait: t.wait, idleMs: 10, catchUpMs: 1, maxBackoffMs: 40 })
    sweeper.start(); sweeper.start()
    await turn()
    assert.equal(batches, 1); assert.equal(t.waits[0]!.milliseconds, 10)
    await turn(); assert.equal(batches, 1, 'An error must wait instead of busy-looping')
    for (const [index, expected] of [[0, 20], [1, 40], [2, 40]] as const) {
      t.waits[index]!.wake(); await turn()
      assert.equal(t.waits[index + 1]!.milliseconds, expected)
    }
    fail = false
    t.waits[3]!.wake(); await turn(); assert.equal(t.waits[4]!.milliseconds, 10)
    f.bytes.scan = async () => ({ keys: [], exhausted: false })
    t.waits[4]!.wake(); await turn(); assert.equal(t.waits[5]!.milliseconds, 1)
    const count = batches
    await sweeper.stop(); await turn()
    assert.equal(batches, count); assert.equal(f.closed(), true)
  })

  it('backs off per-file failures too and treats bounded remaining directories as catch-up work', async () => {
    const f = fixture(), t = timer()
    let fail = true
    f.repository.findDue = async () => [value(1)]
    f.bytes.remove = async () => { if (fail) throw new Error('disk unavailable'); return false }
    const sweeper = new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report,
      { wait: t.wait, idleMs: 10, catchUpMs: 1, maxBackoffMs: 40 })
    sweeper.start(); await turn()
    assert.equal(t.waits[0]!.milliseconds, 10)
    t.waits[0]!.wake(); await turn(); assert.equal(t.waits[1]!.milliseconds, 20)
    fail = false
    t.waits[1]!.wake(); await turn(); assert.equal(t.waits[2]!.milliseconds, 1)
    await sweeper.stop()
  })

  it('rejects zero/negative/oversized batches and unsafe timer ranges', () => {
    const f = fixture()
    for (const batchSize of [0, -1, 101, 1.5]) {
      assert.throws(() => new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report, { batchSize }))
    }
    for (const idleMs of [0, -1, 2 ** 32]) {
      assert.throws(() => new TemporaryFileCleanupSweeper(f.repository, f.bytes, f.report, { idleMs }))
    }
  })
})
