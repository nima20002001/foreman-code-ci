import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeEventBatches, NATIVE_EVENT_BATCH_SIZE } from './nativeEventBatches.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { appendNormalizedNativeEvents } from '../runs/nativeEventBatch.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'

afterEach(() => vi.useRealTimers())

function event(sequence: number, type = 'native.notification'): NativeHarnessEvent {
  return { sequence, type, occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: `frame-${sequence}` } }
}

async function* stream(events: NativeHarnessEvent[]) {
  yield* events
}

it('groups a burst without dropping, changing or reordering its frames', async () => {
  const events = Array.from({ length: NATIVE_EVENT_BATCH_SIZE * 2 + 3 }, (_, index) => event(index))
  const batches = []
  for await (const batch of nativeEventBatches(stream(events))) batches.push(batch)
  expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3])
  expect(batches.flat()).toEqual(events)
})

it('keeps ready frames together when the process resumes after the partial-batch deadline', async () => {
  vi.useFakeTimers()
  const events = Array.from({ length: NATIVE_EVENT_BATCH_SIZE * 2 + 3 }, (_, index) => event(index))
  async function* provider() {
    for (const frame of events) {
      // Model process suspension: time passes while ready reads and timers cannot run.
      vi.setSystemTime(Date.now() + 30)
      yield frame
    }
  }
  const batches = []
  for await (const batch of nativeEventBatches(provider())) batches.push(batch)
  expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3])
  expect(batches.flat()).toEqual(events)
})

it('flushes reliability and approval frames immediately with preceding transcript frames', async () => {
  const events = [event(0), event(1, 'turn.started'), event(2), event(3, 'interaction.pending'),
    event(4, 'transport.disconnected'), event(5, 'turn.completed')]
  const batches = []
  for await (const batch of nativeEventBatches(stream(events))) batches.push(batch)
  expect(batches).toEqual([events.slice(0, 2), events.slice(2, 4), [events[4]], [events[5]]])
})

it('flushes a partial batch while its provider is silent and retains the pending read', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const silence = new Promise<void>((resolve) => { finish = resolve })
  async function* provider() {
    yield event(0)
    await silence
    yield event(1, 'turn.completed')
  }
  const iterator = nativeEventBatches(provider())[Symbol.asyncIterator]()
  const first = iterator.next()
  await vi.advanceTimersByTimeAsync(25)
  expect(await first).toEqual({ value: [event(0)], done: false })
  finish()
  expect(await iterator.next()).toEqual({ value: [event(1, 'turn.completed')], done: false })
  expect((await iterator.next()).done).toBe(true)
})

it('drains captured frames before surfacing the provider error', async () => {
  const failure = new Error('provider disconnected')
  async function* provider() {
    yield event(0)
    throw failure
  }
  const iterator = nativeEventBatches(provider())[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ value: [event(0)], done: false })
  await expect(iterator.next()).rejects.toBe(failure)
})

it.each(['graph', 'mixed'] as const)('persists %s item bursts and replays within a statement ceiling', async kind => {
  const events = Array.from({ length: 35 }, (_, sequence) => ({ ...event(sequence,
    kind === 'mixed' && sequence % 3 === 0 ? 'native.notification' : 'item.completed'),
  payload: { threadId: 'session', turnId: 'turn', item: { id: `item-${sequence}`, type: 'commandExecution' } } }))
  type Row = { execution_id: string; sequence: number; connection_id: string; source_sequence: number;
    record: NativeHarnessEvent & { executionId: string; connectionId: string } }
  const saved: Row[] = []
  let statements = 0
  let next = '0'
  const client = { query: async (_text: string, values: unknown[] = []) => {
    statements += 1
    let rows: unknown[] = []
    if (values.length === 1) {
      const sources = JSON.parse(String(values[0])) as Row[]
      rows = [{ allocators: [{ id: 'execution', next_sequence: next }],
        events: saved.filter(row => sources.some(source => source.execution_id === row.execution_id
          && source.connection_id === row.connection_id && source.source_sequence === row.source_sequence)) }]
    } else if (values.length === 2) {
      next = (JSON.parse(String(values[0])) as { next_sequence: string }[])[0]!.next_sequence
      saved.push(...JSON.parse(String(values[1])) as Row[])
    }
    return { rows, rowCount: rows.length }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => {})
  const persist = async () => {
    statements = 0
    for await (const batch of nativeEventBatches(stream(events))) {
      await connection.transaction(sql => appendNormalizedNativeEvents(sql, batch.map(frame =>
        normalizeNativeProducerEvent({ ...frame, executionId: 'execution', connectionId: 'connection' }))))
    }
    return statements
  }
  try {
    expect(await persist()).toBeLessThanOrEqual(15)
    expect(saved.map(row => row.record)).toEqual(events.map(frame => ({ ...frame,
      executionId: 'execution', connectionId: 'connection' })))
    const original = structuredClone(saved)
    expect(await persist()).toBeLessThanOrEqual(12)
    expect(saved).toEqual(original)
  } finally { await connection.close() }
})

it('delivers terminal and interaction frames immediately after ready ordinary items', async () => {
  vi.useFakeTimers()
  for (const type of ['turn.completed', 'interaction.pending', 'permission.asked', 'transport.disconnected']) {
    const frames = [event(0, 'item.started'), event(1, 'item.completed'), event(2, type)]
    let resume!: () => void
    const silent = new Promise<void>(resolve => { resume = resolve })
    async function* provider() {
      yield* frames
      await silent
    }
    const iterator = nativeEventBatches(provider())[Symbol.asyncIterator]()
    try {
      expect(await iterator.next()).toEqual({ done: false, value: frames })
    } finally {
      resume()
      await iterator.return?.()
    }
  }
})
