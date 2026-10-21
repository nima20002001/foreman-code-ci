import { expect, it } from 'vitest'
import { activityTextEnvelope } from './activityTextEnvelope.js'
import { normalizeNativeTextOperations } from './nativeTextStream.js'
const state = () => ({ kinds: new Map<string, string>(), parents: new Map<string, string>() })
it('shares actual source/native identity and intentional empty final across admitted execution and chat owners', () => {
  const scope = { kind: 'workflow_execution' as const, workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version', executionId: 'execution', attemptKey: '4' }
  const operations = normalizeNativeTextOperations({ connectionId: 'transport', sequence: 999, occurredAt: '2026-10-01T00:00:00Z', type: 'item.completed',
    payload: { source: { eventId: 'native-event', sequence: '7' }, item: { id: 'native-item', type: 'agentMessage', text: '' } } },
  { harness: 'codex', owner: () => ({ scope, sessionId: 'session', turnId: 'turn' }), ...state() })
  const envelope = activityTextEnvelope(operations[0]!, 'codex')
  expect(envelope.owner).toEqual({ ...scope, kind: 'execution' })
  expect(envelope.source.sequence).toBe('7'); expect(envelope.source.eventId).toBe('native-event')
  expect(envelope.change).toMatchObject({ kind: 'text.replace', text: '', finality: 'authoritative_final' })
  expect(envelope.native).toMatchObject({ sessionId: 'session', turnId: 'turn', itemId: 'native-item' })
})
it('never substitutes an arrival counter for missing native sequence or manufactures a turn', () => {
  const operations = normalizeNativeTextOperations({ connectionId: 'arrival', sequence: 456, occurredAt: '2026-10-01T00:00:00Z', type: 'assistant.delta', payload: { itemId: 'item', text: 'hello' } },
  { harness: 'codex', owner: () => ({ scope: { kind: 'operator_chat', conversationId: 'chat' }, requestId: 'request', sessionId: 'session' }), ...state() })
  const envelope = activityTextEnvelope(operations[0]!, 'codex')
  expect(envelope.source.sequence).toBeUndefined(); expect(envelope.native?.turnId).toBeUndefined()
  expect(envelope.owner).toEqual({ kind: 'chat_request', conversationId: 'chat', requestId: 'request' })
})
it('keeps proven block indices and generation while never fabricating missing provider part identity', () => {
  const owner = () => ({ scope: { kind: 'operator_chat' as const, conversationId: 'chat' }, requestId: 'request', sessionId: 'session', generation: 'lease-4' })
  const base = { sequence: 4, occurredAt: '2026-10-01T00:00:00Z', type: 'native.notification', payload: { nativeMethod: 'item/reasoning/summaryTextDelta', itemId: 'item', delta: 'summary', summaryIndex: 2, nativeGeneration: 'lease-3' } }
  const op = normalizeNativeTextOperations(base, { owner, harness: 'codex', ...state() })[0]!
  expect(op.identity.partId).toBe('2'); expect(op.identity.generation).toBe('lease-3')
  const envelope = activityTextEnvelope(op, 'codex')
  expect(envelope.native).toMatchObject({ itemId: 'item', partId: '2', generation: 'lease-3' })
})
it('preserves an explicit source turn instead of attributing an old callback to the current admitted turn', () => {
  const op = normalizeNativeTextOperations({ sequence: 1, occurredAt: '2026-10-01T00:00:00Z', type: 'assistant.delta',
    payload: { itemId: 'item', text: 'old callback', nativeSessionId: 'source-session', nativeTurnId: 'source-turn' } },
  { harness: 'codex', owner: () => ({ scope: { kind: 'operator_chat', conversationId: 'chat' }, requestId: 'current-request', sessionId: 'current-session', turnId: 'current-turn' }), ...state() })[0]!
  expect(op.identity.sessionId).toBe('source-session'); expect(op.identity.turnId).toBe('source-turn')
})
