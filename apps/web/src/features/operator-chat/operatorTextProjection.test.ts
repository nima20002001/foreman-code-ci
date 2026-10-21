import { expect, it } from 'vitest'
import type { Message } from '@foreman-code/contracts'
import { projectOperatorEnvelope, operatorTextPartKey, OPERATOR_TEXT_BYTES, projectOperatorText } from './operatorTextProjection'
const envelope = (text: string, kind: 'text.append' | 'text.replace', eventId: string, final = false) => ({ schemaVersion: 1,
  owner: { kind: 'chat_request', conversationId: 'chat', requestId: 'A' }, native: { harness: 'codex' as const, sessionId: 'session', turnId: 'turn', itemId: 'item' },
  source: { schemaVersion: 1, system: 'codex', eventId, observedAt: '2026-10-01T00:00:00Z' },
  change: { kind, itemId: 'item', text, finality: final ? 'authoritative_final' : 'provisional' } })
it('actual Operator envelope consumer deduplicates, replaces with empty final and refuses delayed deltas', () => {
  const key = operatorTextPartKey({ harness: 'codex', sessionId: 'session', turnId: 'turn', itemId: 'item' })
  let projected = projectOperatorEnvelope(undefined, 'chat', 'A', envelope('long provisional', 'text.append', '1'), [])
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('long provisional', 'text.append', '1'), [])
  expect(projected?.parts[key]).toBe('long provisional')
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('', 'text.replace', '2', true), [])
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('late', 'text.append', '3'), [])
  expect(projected?.parts[key]).toBe(''); expect(projected?.timeline).toEqual([])
})
it('preserves truncation from live envelopes and clears it when a complete replacement arrives', () => {
  const incoming = envelope('retained prefix', 'text.append', 'truncated')
  const truncation = { truncated: true, originalBytes: 30_000 }
  let projected = projectOperatorEnvelope(undefined, 'chat', 'A', {
    ...incoming, change: { ...incoming.change, truncation },
  }, [])
  const key = operatorTextPartKey(incoming.native)
  expect(projected?.truncations?.[key]).toEqual(truncation)
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('complete answer', 'text.replace', 'full', true), [])
  expect(projected?.truncations?.[key]).toBeUndefined()
})
it('a reconnect cannot append a buffered delta already represented by canonical partial text', () => {
  const saved = [{ id: 'message', conversationId: 'chat', requestId: 'A', role: 'assistant' as const, nativeMessageId: 'item', nativeMessageComplete: false, content: 'already persisted' }]
  expect(projectOperatorEnvelope(undefined, 'chat', 'A', envelope('persisted', 'text.append', '1'), saved)).toBeUndefined()
  expect(projectOperatorEnvelope(undefined, 'foreign', 'A', envelope('foreign', 'text.replace', '2', true), [])).toBeUndefined()
})
const savedNative = { harness: 'codex', sessionId: 'session', turnId: 'turn', itemId: 'item', partId: '0', parentItemId: 'parent', generation: '1' }
const savedMessage: Message = { id: 'message', conversationId: 'chat', requestId: 'A', role: 'assistant', nativeMessageId: 'item',
  nativeMessageComplete: false, content: 'already persisted', activityNative: savedNative, activityChannel: 'assistant' }
it.each([
  { itemId: 'new-item' }, { sessionId: 'new-session' }, { turnId: 'new-turn' }, { parentItemId: 'new-parent' }, { generation: '2' },
])('saved part 0 does not suppress another full native identity %j in the same request', (identity) => {
  const incoming = envelope('new text', 'text.append', 'new-event')
  const native = { ...savedNative, ...identity }
  const result = projectOperatorEnvelope(undefined, 'chat', 'A', { ...incoming, native,
    change: { ...incoming.change, itemId: native.itemId, partId: '0' } }, [savedMessage])
  expect(result?.parts[operatorTextPartKey(native)]).toBe('new text')
})
it('saved assistant text does not suppress reasoning with the same native part', () => {
  const incoming = envelope('thinking', 'text.append', 'reasoning-event')
  const result = projectOperatorEnvelope(undefined, 'chat', 'A', { ...incoming, native: savedNative,
    change: { ...incoming.change, partId: '0', channel: 'reasoning' } }, [savedMessage])
  expect(result?.parts[operatorTextPartKey(savedNative, 'reasoning')]).toBe('thinking')
})
it.each([false, true])('deduplicates the same saved native part (complete=%s) and preserves authoritative finality', (complete) => {
  const messages = [{ ...savedMessage, nativeMessageComplete: complete }]
  const incoming = envelope('buffered text', 'text.append', 'same-event')
  const append = { ...incoming, native: savedNative, change: { ...incoming.change, partId: '0' } }
  expect(projectOperatorEnvelope(undefined, 'chat', 'A', append, messages)).toBeUndefined()
  const final = envelope('canonical final', 'text.replace', 'final-event', true)
  const projected = projectOperatorEnvelope(undefined, 'chat', 'A', { ...final, native: savedNative,
    change: { ...final.change, partId: '0' } }, messages)
  expect(projected?.parts[operatorTextPartKey(savedNative)]).toBe('canonical final')
  expect(projectOperatorEnvelope(projected, 'chat', 'A', append, [])?.parts[operatorTextPartKey(savedNative)]).toBe('canonical final')
})
it('bounds provisional live bytes without truncating an authoritative HTTP message', () => {
  expect(projectOperatorText(undefined, 'A', { requestId: 'A', partId: 'item', mode: 'append', text: 'x'.repeat(OPERATOR_TEXT_BYTES + 1) })?.parts.item).toBeUndefined()
})


it('native items sharing a provider block index cannot merge their live text', () => {
  const first = envelope('first', 'text.append', 'shared-uuid')
  const second = { ...envelope('second', 'text.append', 'shared-uuid'), native: { ...first.native, itemId: 'second', partId: '0' }, change: { ...first.change, itemId: 'second', partId: '0', text: 'second' } }
  const one = { ...first, native: { ...first.native, partId: '0' }, change: { ...first.change, partId: '0' } }
  let result = projectOperatorEnvelope(undefined, 'chat', 'A', one, [])
  result = projectOperatorEnvelope(result, 'chat', 'A', second, [])
  expect(Object.values(result!.parts)).toEqual(['first', 'second'])
})
it('never turns a native user echo into the parent assistant answer', () => {
  const user = envelope('input echo', 'text.append', 'echo')
  expect(projectOperatorEnvelope(undefined, 'chat', 'A', { ...user, change: { ...user.change, channel: 'user' } }, [])).toBeUndefined()
})
