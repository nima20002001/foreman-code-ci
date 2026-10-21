import { expect, it } from 'vitest'
import { knownNativeActivity } from '../src/modules/conversations/knownNativeActivity.js'
it('extracts only exact known tool terminal identity, never an unlinked parent/message terminal', () => {
  const source = { sequence: 7, occurredAt: '2026-10-01T00:00:00Z', type: 'native.unlinked_notification',
    payload: { runtimeGeneration: 2, method: 'item/completed', params: { threadId: 'original-session', turnId: 'original-turn',
      item: { id: 'original-tool', type: 'commandExecution', status: 'completed', command: 'readonly command' } } } }
  expect(knownNativeActivity(source, 'codex')).toMatchObject({ change: { id: 'original-tool', kind: 'tool', status: 'completed' },
    native: { harness: 'codex', sessionId: 'original-session', turnId: 'original-turn', itemId: 'original-tool', generation: '2' } })
  expect(knownNativeActivity({ ...source, payload: { ...source.payload, method: 'turn/completed' } }, 'codex')).toBeUndefined()
  expect(knownNativeActivity({ ...source, payload: { ...source.payload, params: { ...source.payload.params,
    item: { id: 'answer', type: 'agentMessage', text: 'not root terminal authority', phase: 'final_answer' } } } }, 'codex')).toBeUndefined()
})
