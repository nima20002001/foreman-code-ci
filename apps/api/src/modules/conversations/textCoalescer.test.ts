import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { createTextCoalescer } from './textCoalescer.js'
import { completedNativeAssistantMessage } from './operatorText.js'

const operation = (sequence: number, text: string, overrides: Partial<ActivityTextOperation> = {}): ActivityTextOperation => ({
  identity: { scope: { kind: 'operator_chat', conversationId: 'chat:one' }, requestId: 'request-a', sessionId: 'native-session', turnId: 'turn-a', itemId: 'item-a', channel: 'assistant' },
  mode: 'append', text, final: false, source: { connectionId: 'connection-a', sequence }, ...overrides,
})
afterEach(() => vi.useRealTimers())
describe('ordered request-owned text coalescing', () => {
  it('coalesces adjacent verified appends, rejects duplicates and flushes before a file/tool barrier', () => {
    const publish = vi.fn(), stream = createTextCoalescer(publish, vi.fn())
    stream.push(operation(1, 'a')); stream.push(operation(1, 'a')); stream.push(operation(2, 'b'))
    expect(publish).not.toHaveBeenCalled()
    stream.flush(); expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['ab'])
    stream.dispose()
  })
  it.each(['short', ''])('replaces provisional content with authoritative final %j and fences late deltas', (text) => {
    const publish = vi.fn(), stream = createTextCoalescer(publish, vi.fn())
    stream.push(operation(1, 'long provisional content'))
    stream.push(operation(2, text, { mode: 'replace', final: true }))
    stream.push(operation(3, 'late')); stream.push(operation(2, text, { mode: 'replace', final: true }))
    expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['long provisional content', text])
    stream.dispose()
  })
  it('keeps owners, parts, parents and text channels separate and flushes in arrival order', () => {
    const publish = vi.fn(), stream = createTextCoalescer(publish, vi.fn())
    const first = operation(1, 'a')
    stream.push(first)
    stream.push(operation(2, 'b', { identity: { ...first.identity, parentId: 'child', partId: 'block-2' } }))
    stream.push(operation(3, 'c', { identity: { ...first.identity, channel: 'user' } }))
    stream.push(operation(4, 'd', { identity: { ...first.identity, requestId: 'request-b' } }))
    stream.flush(); expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['a', 'b', 'c', 'd'])
    stream.dispose()
  })
  it('bounds bytes, identity count and flush latency; callbacks after dispose cannot publish', () => {
    vi.useFakeTimers()
    const publish = vi.fn(), reconcile = vi.fn(), stream = createTextCoalescer(publish, reconcile, { bytes: Buffer.byteLength(JSON.stringify(operation(1, ''))) + 4, items: 1, latencyMs: 10 })
    stream.push(operation(1, 'ab')); stream.push(operation(2, 'cde'))
    expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['ab'])
    vi.advanceTimersByTime(10); expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['ab', 'cde'])
    stream.push(operation(3, 'other', { identity: { ...operation(1, '').identity, itemId: 'other' } }))
    expect(reconcile).toHaveBeenCalledOnce()
    stream.push(operation(4, 'x')); stream.dispose(); stream.push(operation(5, 'late'))
    vi.runAllTimers(); expect(publish).toHaveBeenCalledTimes(2)
  })
  it('never invents sequence and reconciles provisional output across source restart', () => {
    const publish = vi.fn(), reconcile = vi.fn(), stream = createTextCoalescer(publish, reconcile)
    stream.push(operation(1, 'a', { source: {} })); stream.push(operation(2, 'b', { source: {} }))
    expect(publish).toHaveBeenCalledTimes(2)
    stream.push(operation(3, 'c')); stream.push(operation(1, 'd', { source: { connectionId: 'connection-b', sequence: 1 } }))
    expect(reconcile).toHaveBeenCalledOnce()
    expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['a', 'b', 'c'])
    stream.dispose()
  })
  it('distinguishes missing final text from explicitly empty Codex final text', () => {
    const event = { sequence: 2, occurredAt: '2026-10-01T00:00:00Z', type: 'item.completed', payload: { item: { type: 'agentMessage', id: 'item-a', text: '' } } }
    expect(completedNativeAssistantMessage(event, 'codex')).toEqual({ id: 'item-a', text: '' })
    expect(completedNativeAssistantMessage({ ...event, payload: { item: { type: 'agentMessage', id: 'item-a' } } }, 'codex')).toBeUndefined()
  })
})

describe('bounded source IDs', () => {
  it('deduplicates native event IDs within exact item identity without manufacturing source order', () => {
    const publish = vi.fn(), reconcile = vi.fn(), stream = createTextCoalescer(publish, reconcile, { bytes: 1024, items: 2, latencyMs: 5 })
    stream.push(operation(0, 'a', { source: { eventId: 'one' } }))
    stream.push(operation(0, 'b', { source: { eventId: 'two' } }))
    stream.push(operation(0, 'a', { source: { eventId: 'one' } }))
    stream.push(operation(0, 'c', { source: { eventId: 'three' } }))
    expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['a', 'b'])
    expect(reconcile).toHaveBeenCalledOnce()
    stream.dispose()
  })
})


it('disposal from a flushed callback prevents the next replacement or timer from publishing', () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  const stream = createTextCoalescer((operation) => { publish(operation); stream.dispose() }, vi.fn())
  stream.push(operation(1, 'pending'))
  stream.push(operation(2, 'final', { mode: 'replace', final: true }))
  stream.push(operation(3, 'late'))
  vi.runAllTimers()
  expect(publish.mock.calls.map(([op]) => op.text)).toEqual(['pending'])
  expect(vi.getTimerCount()).toBe(0)
})
it('bounds identity and deduplication metadata bytes without truncating canonical identity fields', () => {
  const publish = vi.fn(), reconcile = vi.fn(), stream = createTextCoalescer(publish, reconcile, { bytes: 1024, items: 4, latencyMs: 10 })
  stream.push(operation(1, 'text', { source: { eventId: 'uuid'.repeat(1024) } }))
  expect(publish).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce()
  stream.dispose()
})
