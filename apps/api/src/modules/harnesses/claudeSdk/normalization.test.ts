import { describe, expect, it } from 'vitest'
import { createClaudeEventNormalizer, type ClaudeDecodedEvent } from './normalization.js'

function fixture() {
  const normalizer = createClaudeEventNormalizer({
    owner: { ownerId: 'owner', attemptId: 'attempt', generation: 'generation' },
    observedAt: () => '2026-10-04T00:00:00.000Z',
  })
  let sequence = 0
  const stream = (event: unknown) => normalizer.ingest({ type: 'stream_event',
    session_id: 'session', uuid: `event-${sequence++}`, event })
  const begin = (text = '') => {
    stream({ type: 'message_start', message: { id: 'message' } })
    return stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text } })
  }
  const delta = (text: string) => stream({ type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text } })
  const canonical = (text: string) => normalizer.ingest({ type: 'assistant', session_id: 'session',
    uuid: `canonical-${sequence++}`, message: { id: 'message', content: [{ type: 'text', text }] } })
  return { begin, delta, canonical }
}
function textChange(events: ClaudeDecodedEvent[]) {
  expect(events).toHaveLength(1)
  const change = events[0]!.change
  if (change.kind !== 'text') throw new Error('Expected normalized text')
  return change
}

describe('Claude bounded text', () => {
  it.each([23999, 24000, 24001])('retains the initial and canonical prefix of %i characters', (length) => {
    const f = fixture()
    const text = 'a'.repeat(length)
    const expected = text.slice(0, 24000)
    for (const change of [textChange(f.begin(text)), textChange(f.canonical(text))]) {
      expect(change.text).toBe(expected)
      expect(change.truncation).toEqual({ truncated: length > 24000, originalBytes: length })
    }
    expect(textChange(f.canonical(text)).final).toBe(true)
  })

  it('fills the remaining prefix on overflow and never appends later suffixes', () => {
    const f = fixture()
    const start = textChange(f.begin('a'.repeat(23998)))
    const overflow = textChange(f.delta('BCDE'))
    const later = textChange(f.delta('z'))
    expect(start.text + overflow.text + later.text).toBe('a'.repeat(23998) + 'BC')
    expect(overflow.truncation).toEqual({ truncated: true, originalBytes: 24002 })
    expect(later.truncation).toEqual({ truncated: true, originalBytes: 24003 })
    expect(textChange(f.canonical('a'.repeat(23998) + 'BCDEz')).text).toBe('a'.repeat(23998) + 'BC')
  })

  it('bounds an oversized first delta and accounts for later bytes', () => {
    const f = fixture()
    f.begin()
    expect(textChange(f.delta('é'.repeat(24001))).text).toBe('é'.repeat(24000))
    expect(textChange(f.delta('尾')).truncation).toEqual({ truncated: true, originalBytes: 48005 })
  })

  it('keeps complete Unicode characters at the boundary', () => {
    const f = fixture()
    const prefix = 'é'.repeat(23999)
    const text = prefix + '😀x'
    const initial = textChange(f.begin(text))
    expect(initial.text).toBe(prefix)
    expect(textChange(f.delta('z')).text).toBe('')
    const canonical = textChange(f.canonical(text + 'z'))
    expect(canonical.text).toBe(prefix)
    expect(canonical.truncation).toEqual({ truncated: true, originalBytes: Buffer.byteLength(text + 'z') })
  })
})
