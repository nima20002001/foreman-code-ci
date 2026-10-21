import { expect, it, vi } from 'vitest'
import { processSourceEntries } from './entryProcessing.js'
import { sourceSha256 } from './manifest.js'

const entries = Array.from({ length: 12 }, (_, index) => ({
  path: `file-${index}.txt`,
  kind: 'file' as const,
  byteSize: 0,
  sha256: sourceSha256(Buffer.alloc(0)),
  executable: false,
}))

function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

it('starts ready entries immediately, bounds I/O, and joins every entry', async () => {
  const blocked = gate()
  const started: string[] = []
  const completed: string[] = []
  const processing = processSourceEntries(entries, async entry => {
    started.push(entry.path)
    await blocked.pending
    completed.push(entry.path)
  })
  expect(started).toEqual(entries.slice(0, 4).map(entry => entry.path))
  expect(completed).toEqual([])
  blocked.release()
  await processing
  expect(completed.sort()).toEqual(entries.map(entry => entry.path).sort())
})

it.each(['failure', 'cancellation'])('joins in-flight I/O before reporting %s and stops queued entries', async kind => {
  const blocked = gate()
  const failed = gate()
  const controller = new AbortController()
  const error = new Error(kind)
  const started: string[] = []
  const completed: string[] = []
  const settled = vi.fn()
  const processing = processSourceEntries(entries, async entry => {
    started.push(entry.path)
    if (entry === entries[0]) {
      await failed.pending
      if (kind === 'failure') throw error
      completed.push(entry.path)
      return
    }
    await blocked.pending
    completed.push(entry.path)
  }, controller.signal)
  const observed = processing.then(settled, reason => { settled(); return reason })
  if (kind === 'cancellation') controller.abort(error)
  failed.release()
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  blocked.release()
  expect(await observed).toBe(error)
  expect(started).toHaveLength(4)
  expect(completed).toHaveLength(kind === 'failure' ? 3 : 4)
})
