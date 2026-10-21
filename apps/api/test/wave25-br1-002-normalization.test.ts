import { describe, expect, it } from 'vitest'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { normalizeNativeProducerEvent, NATIVE_PRODUCER_MAX_BYTES,
  NATIVE_PRODUCER_REJECTION_TYPE } from '../src/modules/run-graph/nativeProducerNormalization.js'

function event(payload: Record<string, unknown> = {}, type = 'text.delta'): HarnessNativeEvent {
  return { executionId: 'execution-test', connectionId: 'connection-test', sequence: 12,
    type, occurredAt: '2026-09-22T00:00:00.000Z', payload }
}

describe('BR1-002 deterministic source normalization (not producer qualification)', () => {
  it('preserves every JSON-serializable raw field and does not mutate retained provider history', () => {
    const input = event({ text: 'already [REDACTED]', toolArguments: { relative: 'src/main.ts' }, extra: [1, false, null] })
    Object.freeze(input.payload)
    Object.freeze(input)
    const result = normalizeNativeProducerEvent(input)
    expect(result.rejected).toBe(false)
    expect(result.event).toEqual(input)
    expect(input.payload.text).toBe('already [REDACTED]')
  })

  it('matches persisted JSON semantics for optional undefined fields without unbounded stringify', () => {
    const input = { ...event({ optional: undefined, present: 'kept', array: [undefined, 'kept'] }), connectionId: undefined }
    const result = normalizeNativeProducerEvent(input)
    expect(result.rejected).toBe(false)
    expect(result.event).toEqual(JSON.parse(JSON.stringify(input)))
    expect('connectionId' in result.event).toBe(false)
  })

  it('accepts the exact raw-byte boundary and rejects one byte above it', () => {
    const overhead = Buffer.byteLength(JSON.stringify(event({ text: '' })))
    const exact = event({ text: 'a'.repeat(NATIVE_PRODUCER_MAX_BYTES - overhead) })
    expect(normalizeNativeProducerEvent(exact).rejected).toBe(false)
    const oversized = event({ text: `${exact.payload.text}a` })
    const normalized = normalizeNativeProducerEvent(oversized)
    expect(normalized.rejected).toBe(true)
    expect(normalized.event.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
    expect(Buffer.byteLength(JSON.stringify(normalized.event))).toBeLessThan(4096)
  })

  it('counts UTF-8 and JSON escapes, not just JavaScript character length', () => {
    for (const text of ['😀'.repeat(NATIVE_PRODUCER_MAX_BYTES / 4), '\u0000'.repeat(NATIVE_PRODUCER_MAX_BYTES / 6 | 0)]) {
      expect(normalizeNativeProducerEvent(event({ text })).rejected).toBe(true)
    }
  })

  it('re-normalizes an oversized retained source identically, then accepts the next valid source', () => {
    const retained = event({ text: 'private'.repeat(Math.ceil(NATIVE_PRODUCER_MAX_BYTES / 7)) })
    const first = normalizeNativeProducerEvent(retained)
    expect(normalizeNativeProducerEvent(retained)).toEqual(first)
    expect(first.event).toMatchObject({ executionId: retained.executionId, connectionId: retained.connectionId,
      sequence: retained.sequence, occurredAt: retained.occurredAt })
    expect(JSON.stringify(first.event)).not.toContain('private')
    expect(retained.type).toBe('text.delta')
    const next = { ...event({ text: 'next' }), sequence: retained.sequence + 1 }
    expect(normalizeNativeProducerEvent(next)).toEqual({ event: next, rejected: false })
  })

  it('also rejects a bounded raw frame whose semantic identity exceeds the evidence bound', () => {
    const input = event({ threadId: 'session-test', item: { id: 'i'.repeat(32769), type: 'commandExecution' } }, 'item.started')
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(NATIVE_PRODUCER_MAX_BYTES)
    expect(normalizeNativeProducerEvent(input).event.payload).toMatchObject({ code: 'GRAPH_EVIDENCE_TOO_LARGE' })
    expect(normalizeNativeProducerEvent({ ...input, type: ' item.started ' }).rejected).toBe(true)
  })

  it('does not salvage an oversized action array into a valid partial event', () => {
    const input = event({ item: { id: 'item-test', type: 'commandExecution', commandActions: Array.from({ length: 129 }, () => ({ type: 'read' })) } }, 'item.started')
    expect(normalizeNativeProducerEvent(input).rejected).toBe(true)
  })

  it('does not invoke accessors or custom toJSON while bounding malformed evidence', () => {
    let invoked = false
    const payload = Object.defineProperty({}, 'text', { enumerable: true, get() { invoked = true; throw new Error('must not run') } })
    expect(normalizeNativeProducerEvent(event(payload)).rejected).toBe(true)
    expect(normalizeNativeProducerEvent(event({ toJSON() { invoked = true; return 'must not run' } })).rejected).toBe(true)
    expect(invoked).toBe(false)
  })

  it('rejects cycles, deep structures and sparse arrays without poisoning subsequent normalization', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    let deep: Record<string, unknown> = {}
    for (let index = 0; index < 40; index++) deep = { nested: deep }
    const sparse = Array(2); sparse[0] = 'present'
    for (const payload of [cyclic, deep, { sparse }, { nonfinite: Infinity }, { symbol: Symbol('invalid') }]) {
      expect(normalizeNativeProducerEvent(event(payload)).rejected).toBe(true)
      expect(normalizeNativeProducerEvent(event({ text: 'still valid' })).rejected).toBe(false)
    }
  })

  it('does not turn a sparse array with a named property into a complete array', () => {
    const sparse: unknown[] & { extra?: string } = Array(2)
    sparse[0] = 'present'; sparse.extra = 'not an index'
    expect(normalizeNativeProducerEvent(event({ sparse })).rejected).toBe(true)
  })

  it('never renumbers duplicate, reordered or cross-connection frames', () => {
    for (const [connectionId, sequence] of [['connection-new', 10], ['connection-old', 2], ['connection-new', 9], ['connection-old', 2]] as const) {
      const input = { ...event({ text: 'raw' }), connectionId, sequence }
      expect(normalizeNativeProducerEvent(input)).toEqual({ event: input, rejected: false })
    }
  })

  it('does not infer native progress or completion from transport events', () => {
    for (const type of ['ping', 'session.disconnected', 'session.idle', 'transport.closed']) {
      const input = event({ sessionID: 'session-a' }, type)
      expect(normalizeNativeProducerEvent(input)).toEqual({ event: input, rejected: false })
    }
  })
})
