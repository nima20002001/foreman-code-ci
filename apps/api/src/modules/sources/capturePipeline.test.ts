import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { captureGitSource, qualifiedGit, type SourceSnapshotSink } from './capture.js'
import { sourceSha256 } from './manifest.js'
import { deferred } from '../../../test/helpers/deferred.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function repository(bytes: Buffer) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-pipeline-')); roots.push(root)
  await qualifiedGit(root, ['init', '--template='])
  const paths = Array.from({ length: 8 }, (_, index) => `file-${index}.bin`)
  for (const path of paths) await writeFile(join(root, path), bytes)
  await qualifiedGit(root, ['add', '.'])
  await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
  const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
  return { root, commit, approvedSourceId: randomUUID(), executablePolicy: 'strip' as const }
}

it('captures maximum-size blobs through a slow sink without exceeding the existing byte buffer budget', async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 42), digest = sourceSha256(bytes), source = await repository(bytes)
  let liveBytes = 0, peakBytes = 0, written = 0, committed = false
  let batch = deferred()
  let entered = 0
  const sink: SourceSnapshotSink = {
    async write(_id, entry, content) {
      liveBytes += content.length; peakBytes = Math.max(peakBytes, liveBytes)
      try {
        expect(sourceSha256(content)).toBe(digest)
        expect(entry.byteSize).toBe(bytes.length)
        const ready = batch
        // Four maximum-size writes fill the existing byte budget before draining.
        if (++entered % 4 === 0) {
          batch = deferred()
          ready.resolve()
        }
        await ready.promise
        written++
      }
      finally { liveBytes -= content.length }
    },
    async commit(manifest) { expect(liveBytes).toBe(0); expect(manifest.totalBytes).toBe(128 * 1024 * 1024); committed = true },
    async abort() { throw new Error('The complete valid tree must not abort') },
  }
  await captureGitSource({ ...source, sink })
  expect(written).toBe(8); expect(committed).toBe(true); expect(peakBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
}, 30_000)

it('drains other private writes before aborting a failed capture and never commits it', async () => {
  const source = await repository(Buffer.from('exact immutable source bytes')), failed = new Error('private write failed')
  let active = 0, peak = 0, aborted = false, committed = false
  const overlap = deferred()
  const failedWrite = deferred()
  const drainWrites = deferred()
  const sink: SourceSnapshotSink = {
    async write(_id, entry) {
      active++; peak = Math.max(peak, active)
      try {
        if (entry.path === 'file-0.bin') {
          await overlap.promise
          failedWrite.resolve()
          throw failed
        }
        overlap.resolve()
        await drainWrites.promise
      }
      finally { active-- }
    },
    async commit() { committed = true },
    async abort() { expect(active).toBe(0); aborted = true },
  }
  const capture = expect(captureGitSource({ ...source, sink })).rejects.toBe(failed)
  try {
    await failedWrite.promise
    expect(active).toBeGreaterThan(0)
    expect(aborted).toBe(false)
  } finally {
    drainWrites.resolve()
    await capture
  }
  expect(peak).toBeGreaterThan(1); expect(aborted).toBe(true); expect(committed).toBe(false)
})
