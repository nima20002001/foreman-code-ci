import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { createNativeTextStream } from './nativeTextStream.js'
const owner = () => ({ scope: { kind: 'operator_chat' as const, conversationId: 'chat-a', requestId: 'request-a' }, requestId: 'request-a', sessionId: 'session-a', turnId: 'turn-a' })
const delta = (sequence: number, text: string): NativeHarnessEvent => ({ connectionId: 'connection-a', sequence, occurredAt: '2026-10-01T00:00:00Z', type: 'assistant.delta', payload: { itemId: 'item-a', text } })
afterEach(() => vi.useRealTimers())
describe('shared admitted-owner native text path', () => {
  it('flushes before publication/tool transitions; completed text emits only after the canonical commit', () => {
    const timeline: string[] = []
    const stream = createNativeTextStream({ owner, harness: 'codex', publish: (operation) => timeline.push(operation.text), reconcile: vi.fn() })
    stream.push(delta(1, 'a')); stream.push(delta(2, 'b'))
    stream.before({ ...delta(3, ''), type: 'publication.changed' }); timeline.push('file committed')
    const final = { ...delta(4, ''), type: 'item.completed', payload: { item: { id: 'item-a', type: 'agentMessage', text: '' } } }
    stream.before(final); timeline.push('final committed'); stream.push(final); stream.push(delta(5, 'late'))
    expect(timeline).toEqual(['ab', 'file committed', 'final committed', ''])
    stream.dispose()
  })
  it('requests readback for absent native identity and drops callbacks after disposal', () => {
    vi.useFakeTimers()
    const publish = vi.fn(), reconcile = vi.fn(), stream = createNativeTextStream({ owner, harness: 'codex', publish, reconcile })
    stream.push({ ...delta(1, 'x'), payload: { text: 'x' } })
    expect(reconcile).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled()
    stream.push(delta(2, 'buffered')); stream.dispose(); stream.push(delta(3, 'late')); vi.runAllTimers()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('Claude block source provenance', () => {
  it('keeps multiple blocks sharing an SDK UUID and suppresses child text and duplicate block events', () => {
    const publish = vi.fn(), stream = createNativeTextStream({ owner, harness: 'claude', publish, reconcile: vi.fn() })
    const event = (itemId: string, text: string): NativeHarnessEvent => ({ ...delta(0, ''), connectionId: undefined, type: 'claude.text', payload: {
      itemId, messageId: 'shared-message', operation: 'replace', final: true, text, source: { eventId: 'sdk-uuid' },
    } })
    stream.push(event('block-a', 'a')); stream.push(event('block-b', '')); stream.push(event('block-a', 'a'))
    stream.push({ ...event('child-block', 'child'), payload: { ...event('child-block', 'child').payload, parentToolUseId: 'parent-tool' } })
    expect(publish.mock.calls.map(([operation]) => [operation.identity.itemId, operation.text, operation.source])).toEqual([
      ['block-a', 'a', { eventId: 'sdk-uuid' }], ['block-b', '', { eventId: 'sdk-uuid' }],
    ])
    stream.dispose()
  })
  it('aborts timers and ignores late callbacks without ending the native owner', () => {
    vi.useFakeTimers()
    const controller = new AbortController(), publish = vi.fn()
    const stream = createNativeTextStream({ owner, harness: 'codex', publish, reconcile: vi.fn(), signal: controller.signal })
    stream.push(delta(1, 'buffered')); controller.abort(); vi.runAllTimers(); stream.push(delta(2, 'late'))
    expect(publish).not.toHaveBeenCalled()
  })
})