import { describe, expect, it, vi } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES, DEVICE_HISTORY_PAGE_BYTES } from '@foreman-code/contracts/device-application'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { pageNativeHistory, nativeHistoryPageSource, readNativeHistoryMetadata } from './nativeHistoryPage.js'
import { readJsonContinuation } from './jsonContinuation.js'
import { decodeResultCopies } from './executionResultCodec.js'
import { deviceRequestTimeoutMs } from '../../devices/deviceRequestRetry.js'

function event(sequence: number, text = 'event'): NativeHarnessEvent {
  return { sequence, type: 'native.notification', occurredAt: '2026-10-01T00:00:00.000Z', payload: { text } }
}

const retainedWindows: Array<{
  name: string
  sequences: number[]
  firstRetainedSequence: number
  nextSequence: number
  gap?: NativeHistory['gap']
}> = [
  { name: 'contiguous events', sequences: [10, 11, 12], firstRetainedSequence: 10, nextSequence: 13 },
  { name: 'protected terminal frame', sequences: [10, 50], firstRetainedSequence: 10, nextSequence: 51,
    gap: { fromSequence: 11, toSequence: 49, reason: 'retention' } },
  { name: 'events on both sides of a gap', sequences: [10, 11, 50, 51],
    firstRetainedSequence: 10, nextSequence: 52,
    gap: { fromSequence: 12, toSequence: 49, reason: 'retention' } },
  { name: 'trailing explicit gap', sequences: [10, 11], firstRetainedSequence: 10, nextSequence: 50,
    gap: { fromSequence: 12, toSequence: 49, reason: 'retention' } },
  { name: 'explicit oversized range', sequences: [10, 50], firstRetainedSequence: 10, nextSequence: 51,
    gap: { fromSequence: 11, toSequence: 49, reason: 'event_too_large' } },
  { name: 'empty retained window', sequences: [], firstRetainedSequence: 50, nextSequence: 50 },
  { name: 'empty explicit gap', sequences: [], firstRetainedSequence: 10, nextSequence: 50,
    gap: { fromSequence: 10, toSequence: 49, reason: 'retention' } },
]

function largeTerminalHistory(label: string): NativeHistory {
  const result = { outcome: 'succeeded' as const, output: { text: label + '漢😀'.repeat(450_000) } }
  return { events: [], pendingInteractions: [], terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
}

function downloadMetadata(history: NativeHistory) {
  const first = pageNativeHistory(history).page.metadata!
  return { first, rest: async () => decodeResultCopies(await readJsonContinuation(first, async metadata => readNativeHistoryMetadata(metadata))) }
}

function sequenceRange(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index)
}

describe('byte-bounded native history pages', () => {
  it('identifies the missing range when the requested sequence falls behind retention', () => {
    const reply = pageNativeHistory({ events: [event(50), event(51)], pendingInteractions: [],
      firstRetainedSequence: 50, nextSequence: 52 }, 10)
    expect(reply.history.gap).toEqual({ fromSequence: 11, toSequence: 49, reason: 'retention' })
    expect(reply.history.firstRetainedSequence).toBe(50)
  })

  it('delivers a history larger than the carrier limit once, in chronological UTF-8 bounded pages', () => {
    const events = Array.from({ length: 90 }, (_, sequence) => event(sequence, '漢😀"\\'.repeat(2000)))
    const history: NativeHistory = { events, pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 90 }
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
    const delivered: NativeHarnessEvent[] = []
    let cursor = -1
    for (let count = 0; count < events.length; count++) {
      const reply = pageNativeHistory(history, cursor)
      expect(Buffer.byteLength(JSON.stringify(reply.history))).toBeLessThanOrEqual(DEVICE_HISTORY_PAGE_BYTES)
      expect(reply.history.gap).toBeUndefined()
      delivered.push(...reply.history.events)
      expect(reply.page.nextAfterSequence).toBeGreaterThan(cursor)
      cursor = reply.page.nextAfterSequence
      if (!reply.page.hasMore) break
    }
    expect(delivered).toEqual(events)
    expect(pageNativeHistory(history, cursor).history.events).toEqual([])
  })

  it('bounds the recent observation and exposes its retained sequence floor', () => {
    const events = Array.from({ length: 2000 }, (_, sequence) => event(sequence))
    const reply = pageNativeHistory({ events, pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 2000 })
    expect(reply.history.events).toEqual(events.slice(-1024))
    expect(reply.history.firstRetainedSequence).toBe(976)
    expect(reply.history.nextSequence).toBe(2000)
    expect(reply.page).toEqual({ nextAfterSequence: 1999, hasMore: false })
  })

  it('reports one oversized event explicitly and preserves terminal recovery after it', () => {
    const result = { outcome: 'succeeded' as const, output: { text: 'original terminal result' } }
    const history: NativeHistory = {
      events: [event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1)), event(1)],
      pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 2,
      correlationId: 'execution:execution', nativeTurnId: 'native-turn', terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result },
    }
    const first = pageNativeHistory(history, -1)
    expect(first.history.events).toEqual([])
    expect(first.history.gap).toEqual({ fromSequence: 0, toSequence: 0, reason: 'event_too_large' })
    expect(first.page).toEqual({ nextAfterSequence: 0, hasMore: true })
    const second = pageNativeHistory(history, first.page.nextAfterSequence)
    expect(second.history.events).toEqual([history.events[1]])
    expect(second.history.terminalTurn).toEqual(history.terminalTurn)
    const recovery = pageNativeHistory(history)
    expect(recovery.history.firstRetainedSequence).toBe(1)
    expect(recovery.history.terminalResult).toEqual(result)
    expect(recovery.history.terminalTurn).toEqual(history.terminalTurn)
  })

  it('separates a retained range from an oversized first retained event', () => {
    const history: NativeHistory = {
      events: [event(442, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1)), event(443)],
      pendingInteractions: [], firstRetainedSequence: 442, nextSequence: 444,
    }
    const retained = pageNativeHistory(history, 146)
    expect(retained.history.events).toEqual([])
    expect(retained.history.gap).toEqual({ fromSequence: 147, toSequence: 441, reason: 'retention' })
    expect(retained.page).toEqual({ nextAfterSequence: 441, hasMore: true })

    const oversized = pageNativeHistory(history, retained.page.nextAfterSequence)
    expect(oversized.history.events).toEqual([])
    expect(oversized.history.gap).toEqual({ fromSequence: 442, toSequence: 442, reason: 'event_too_large' })
    expect(oversized.page).toEqual({ nextAfterSequence: 442, hasMore: true })

    const remaining = pageNativeHistory(history, oversized.page.nextAfterSequence)
    expect(remaining.history.events).toEqual([event(443)])
    expect(remaining.history.gap).toBeUndefined()
    expect(remaining.page).toEqual({ nextAfterSequence: 443, hasMore: false })
  })

  it('advances through an explicit gap before skipping an oversized protected-snapshot event', () => {
    const history: NativeHistory = {
      events: [event(10), event(50, 'x'.repeat(DEVICE_HISTORY_PAGE_BYTES))],
      pendingInteractions: [], firstRetainedSequence: 10, nextSequence: 51,
      gap: { fromSequence: 11, toSequence: 49, reason: 'retention' },
    }
    const retained = pageNativeHistory(history, 10)
    expect(retained.history.events).toEqual([])
    expect(retained.history.gap).toEqual(history.gap)
    expect(retained.page).toEqual({ nextAfterSequence: 49, hasMore: true })

    const oversized = pageNativeHistory(history, 49)
    expect(oversized.history.events).toEqual([])
    expect(oversized.history.gap).toEqual({ fromSequence: 50, toSequence: 50, reason: 'event_too_large' })
    expect(oversized.page).toEqual({ nextAfterSequence: 50, hasMore: false })
    expect(nativeHistoryPageSource(oversized)?.gap).toEqual(oversized.history.gap)
  })

  it.each(retainedWindows)('accounts for every sequence across size and cursor combinations: $name', window => {
    const texts = ['event', 'x'.repeat(DEVICE_HISTORY_PAGE_BYTES / 2), 'x'.repeat(DEVICE_HISTORY_PAGE_BYTES)]
    for (let sizes = 0; sizes < texts.length ** window.sequences.length; sizes++) {
      const events = window.sequences.map((sequence, index) =>
        event(sequence, texts[Math.floor(sizes / texts.length ** index) % texts.length]!))
      const history: NativeHistory = {
        events, pendingInteractions: [], firstRetainedSequence: window.firstRetainedSequence,
        nextSequence: window.nextSequence, ...(window.gap ? { gap: window.gap } : {}),
      }
      for (const after of [-1, 9, 10, 11, 25, 49, 50, 51].filter(cursor => cursor < window.nextSequence)) {
        const delivered: NativeHarnessEvent[] = []
        const skipped: number[] = []
        let cursor = after
        for (let page = 0; page <= window.nextSequence; page++) {
          const reply = pageNativeHistory(history, cursor)
          const through = reply.page.nextAfterSequence
          expect(Buffer.byteLength(JSON.stringify(reply.history))).toBeLessThanOrEqual(DEVICE_HISTORY_PAGE_BYTES)
          expect(reply.page.hasMore).toBe(through + 1 < window.nextSequence)
          if (cursor + 1 < window.nextSequence) expect(through).toBeGreaterThan(cursor)
          const gap = reply.history.gap
          const missing = gap ? sequenceRange(gap.fromSequence, gap.toSequence) : []
          const coverage = [...missing, ...reply.history.events.map(frame => frame.sequence)].sort((a, b) => a - b)
          expect(coverage).toEqual(sequenceRange(cursor + 1, through))
          expect(nativeHistoryPageSource(reply)?.gap).toEqual(gap)
          delivered.push(...reply.history.events)
          skipped.push(...missing)
          cursor = through
          if (!reply.page.hasMore) break
        }
        const expected = events.filter((frame, index) => frame.sequence > after
          && Math.floor(sizes / texts.length ** index) % texts.length !== 2)
        expect(delivered).toEqual(expected)
        expect(skipped.sort((a, b) => a - b)).toEqual(sequenceRange(after + 1, window.nextSequence - 1)
          .filter(sequence => !expected.some(frame => frame.sequence === sequence)))
        expect(cursor).toBe(window.nextSequence - 1)
      }
    }
  })

  it('reports an oversized last event even when the terminal window is otherwise empty', () => {
    const result = { outcome: 'succeeded' as const }
    const reply = pageNativeHistory({ events: [event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES))],
      pendingInteractions: [], terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } })
    expect(reply.history.events).toEqual([])
    expect(reply.history.gap?.reason).toBe('event_too_large')
    expect(reply.history.terminalTurn?.result).toEqual(result)
  })

  it('recovers terminal metadata through bounded UTF-8 continuations with its original result', async () => {
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀"\\'.repeat(40_000) } }
    const history: NativeHistory = { events: [event(1)], pendingInteractions: [], terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result },
      gap: { fromSequence: 0, toSequence: 0, reason: 'retention' } }
    const first = pageNativeHistory(history, -1)
    expect(first.page.metadata).toBeDefined()
    expect(first.history.terminalResult).toBeUndefined()
    expect(first.history.gap).toEqual(history.gap)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(DEVICE_HISTORY_PAGE_BYTES)
    const recovered = await readJsonContinuation(first.page.metadata!, async metadata => {
      const next = pageNativeHistory(history, 0, metadata)
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(DEVICE_HISTORY_PAGE_BYTES)
      return next.page.metadata!
    })
    expect(decodeResultCopies(recovered)).toMatchObject({ terminalResult: result, terminalTurn: history.terminalTurn })
    expect(() => pageNativeHistory({ ...history, terminalResult: { outcome: 'failed',
      error: { code: 'failed', message: 'Original result changed', retryable: false } } }, 0,
      { digest: first.page.metadata!.digest, offset: 65_536 })).toThrow('continuation changed')
  })

  it('hydrates both terminal result copies when the original journal payload is near three MiB', async () => {
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(450_000) } }
    const history: NativeHistory = { events: [], pendingInteractions: [], terminalResult: result,
      terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(3 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(4 * 1024 * 1024)
    const first = pageNativeHistory(history)
    const fields = await readJsonContinuation(first.page.metadata!, async metadata =>
      pageNativeHistory(history, first.page.nextAfterSequence, metadata).page.metadata!)
    expect(decodeResultCopies(fields)).toEqual({ pendingInteractions: [], terminalResult: result,
      terminalTurn: history.terminalTurn })
  })

  it('finishes two concurrent large result downloads while later large results are read', async () => {
    const concurrent = [largeTerminalHistory('first'), largeTerminalHistory('second')]
    const started = concurrent.map(downloadMetadata)
    for (const [index, history] of Array.from({ length: 5 }, (_, n) => largeTerminalHistory(`later-${n}`)).entries()) {
      expect(await downloadMetadata(history).rest(), `later result ${index}`)
        .toMatchObject({ terminalResult: history.terminalResult })
    }
    for (const [index, download] of started.entries()) {
      expect(await download.rest()).toEqual({ pendingInteractions: [],
        terminalResult: concurrent[index]!.terminalResult, terminalTurn: concurrent[index]!.terminalTurn })
    }
  })

  it('refuses a new large result while unfinished downloads fill retention, until one is abandoned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const unfinished = Array.from({ length: 5 }, (_, n) => downloadMetadata(largeTerminalHistory(`unfinished-${n}`)))
      const waiting = largeTerminalHistory('waiting')
      expect(() => pageNativeHistory(waiting)).toThrow(expect.objectContaining({ code: 'backpressure' }))
      vi.setSystemTime(Date.now() + deviceRequestTimeoutMs + 1)
      expect(await downloadMetadata(waiting).rest()).toMatchObject({ terminalResult: waiting.terminalResult })
      await expect(unfinished[0]!.rest()).rejects.toMatchObject({ code: 'transfer-expired' })
    } finally {
      vi.useRealTimers()
    }
  })
})
