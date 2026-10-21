import { describe, expect, it } from 'vitest'
import { completedNativeAssistantMessage, nativeAssistantText } from '../src/modules/conversations/operatorText.js'

describe('operator thinking presentation', () => {
  it('keeps provider reasoning summaries separate from assistant response text', () => {
    expect(nativeAssistantText({ sequence: 1, type: 'native.notification', occurredAt: new Date().toISOString(),
      payload: { nativeMethod: 'item/reasoning/summaryTextDelta', itemId: 'r1', delta: 'Checking the arithmetic.' } }))
      .toEqual([{ partId: 'thinking:r1', text: 'Checking the arithmetic.', mode: 'append' }])
    expect(nativeAssistantText({ sequence: 2, type: 'claude.text', occurredAt: new Date().toISOString(),
      payload: { itemId: 'assistant-1', text: 'The result is ready.', operation: 'replace' } }))
      .toEqual([{ partId: 'assistant-1', text: 'The result is ready.', mode: 'replace' }])
  })
  it('persists completed Codex commentary and Claude text blocks with stable identities', () => {
    const occurredAt = new Date().toISOString()
    expect(completedNativeAssistantMessage({ sequence: 3, type: 'item.completed', occurredAt,
      payload: { item: { id: 'commentary-1', type: 'agentMessage', text: 'Checking the folder.' } } }, 'codex'))
      .toEqual({ id: 'commentary-1', text: 'Checking the folder.' })
    expect(completedNativeAssistantMessage({ sequence: 4, type: 'claude.text', occurredAt,
      payload: { itemId: 'part-1', messageId: 'message-1', text: 'Done.', operation: 'replace', final: true } }, 'claude'))
      .toEqual({ id: 'part-1', parentMessageId: 'message-1', text: 'Done.', complete: true })
  })
})
