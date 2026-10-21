import { expect, it } from 'vitest'
import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { operatorActivity, currentOperatorHistory } from '../src/modules/conversations/operatorActivity.js'
import { nativeActivityFence } from '../src/modules/conversations/nativeActivityFence.js'
import { normalizeNativeTextOperations } from '../src/modules/conversations/nativeTextStream.js'

const session: NativeSessionReference = { harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'actual-session' }
const receipt = { kind: 'message' as const, nativeSessionId: session.nativeSessionId,
  nativeMessageId: 'observed-input-message', clientCorrelationId: 'accepted-correlation' }
function event(type: string, payload: Record<string, unknown>): NativeHarnessEvent {
  return { type, sequence: 777, occurredAt: '2026-10-01T00:00:00.000Z', payload: {
    nativeSessionId: session.nativeSessionId, clientCorrelationId: receipt.clientCorrelationId, nativeGeneration: 'sdk-generation', ...payload,
  } }
}

it('shared chat activity mounts the provider tool/task mapper without promoting private bodies', () => {
  expect(operatorActivity(event('claude.tool', { itemId: 'actual-tool', name: 'Read', status: 'running',
    input: { path: '/private' }, output: 'private body' }), 'claude', 'accepted-request')).toEqual({
    id: 'actual-tool', requestId: 'accepted-request', kind: 'file_read', title: 'Read file', status: 'running',
  })
  expect(operatorActivity(event('claude.task', { taskId: 'actual-child', status: 'unknown', summary: 'private child output' }), 'claude', 'accepted-request')).toEqual({
    id: 'claude:task:actual-child', requestId: 'accepted-request', kind: 'subagent', title: 'Subagent activity', status: 'unknown',
  })
  expect(operatorActivity(event('claude.text', { itemId: 'child-text', text: 'child answer', parentToolUseId: 'actual-tool' }), 'claude', 'accepted-request')).toBeUndefined()
})

it('native message mutation fences retain actual generation/event identity without a turn or arrival watermark', () => {
  const fence = nativeActivityFence(session, null, event('claude.tool', { toolUseId: 'actual-tool', source: { eventId: 'sdk-event', sequence: '3' } }), false, receipt)
  expect(fence.native).toEqual({ harness: 'claude', sessionId: session.nativeSessionId, generation: 'sdk-generation', itemId: 'actual-tool' })
  expect(fence.source).toMatchObject({ eventId: 'sdk-event', nativeSequence: '3' })
  expect(fence.source?.transportSequence).toBeUndefined()
  expect(fence.source?.sequence).toBeUndefined()
  expect(fence.nativeTurnId).toBeUndefined()
  expect(() => nativeActivityFence(session, null, event('claude.tool', { nativeSessionId: 'another-session' }), false, receipt)).toThrow('observed receipt')
  expect(() => nativeActivityFence(session, 'invented-turn', event('claude.tool', {}), false, receipt)).toThrow('observed receipt')
})

it('shared text normalization retains actual SDK block/message identity and excludes child answers', () => {
  const input = { harness: 'claude' as const, owner: () => ({ scope: { kind: 'operator_chat' as const, conversationId: 'conversation' },
    requestId: 'accepted-request', sessionId: session.nativeSessionId }), kinds: new Map<string, string>(), parents: new Map<string, string>() }
  const text = event('claude.text', { itemId: 'actual-block', messageId: 'api-message', contentIndex: 2,
    operation: 'replace', text: 'public answer', final: true, source: { eventId: 'actual-output-event' } })
  const [operation] = normalizeNativeTextOperations(text, input)
  expect(operation?.identity).toMatchObject({ sessionId: session.nativeSessionId, generation: 'sdk-generation', itemId: 'actual-block', parentId: 'api-message', partId: '2' })
  expect(operation?.identity.turnId).toBeUndefined()
  expect(operation?.source).toEqual({ eventId: 'actual-output-event' })
  expect(operation?.final).toBe(true)
  expect(normalizeNativeTextOperations({ ...text, payload: { ...text.payload, parentToolUseId: 'actual-tool' } }, input)).toEqual([])
})

it('reads only the submitted Claude message history after observer detachment', () => {
  const owned = event('claude.text', { itemId: 'answer', text: 'owned' })
  const other = event('claude.text', { itemId: 'other', clientCorrelationId: 'another-request' })
  const child = event('claude.text', { itemId: 'child', parentToolUseId: 'tool' })
  expect(currentOperatorHistory({ correlationId: receipt.clientCorrelationId, nativeSubmission: receipt,
    events: [owned, other, child], pendingInteractions: [] }, 'claude')).toEqual([owned])
  expect(currentOperatorHistory({ events: [owned], pendingInteractions: [] }, 'claude')).toEqual([])
})
