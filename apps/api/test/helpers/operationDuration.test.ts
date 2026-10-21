import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { operationDuration } from './operationDuration.js'

afterEach(() => vi.useRealTimers())

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

it('counts overlapping publications on a serialized writer once within the unchanged budget', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => {})
  const publication = operationDuration()
  const published: number[] = []
  try {
    const pending = Promise.all([1, 2].map(frame => publication.measure(() => connection.transaction(async () => {
      await delay(4_000)
      published.push(frame)
    }))))
    await vi.advanceTimersByTimeAsync(8_000)
    await pending
    expect(published).toEqual([1, 2])
    expect(publication.elapsedMs).toBe(8_000)
    expect(publication.elapsedMs).toBeLessThan(10_000)
  } finally {
    await connection.close()
  }
})

it('accumulates separate operations without charging idle gaps and preserves results', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const publication = operationDuration()
  const first = publication.measure(async () => {
    await delay(2_000)
    return 'first'
  })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await first).toBe('first')
  await vi.advanceTimersByTimeAsync(5_000)
  const second = publication.measure(() => delay(9_000))
  await vi.advanceTimersByTimeAsync(9_000)
  await second
  expect(publication.elapsedMs).toBe(11_000)
})

it('retains the full active interval when an overlapping operation fails', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const publication = operationDuration()
  const failure = new Error('publication failed')
  const failed = expect(publication.measure(async () => {
    await delay(2_000)
    throw failure
  })).rejects.toBe(failure)
  const completed = publication.measure(() => delay(6_000))
  await vi.advanceTimersByTimeAsync(6_000)
  await failed
  await completed
  expect(publication.elapsedMs).toBe(6_000)
})
