import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { PostgresOperatorConversationRepository } from './operatorChatRepository.js'

it('reads a retired Operator transcript with its saved model controls and handoff facts', async () => {
  const createdAt = '2026-10-01T00:00:00.000Z'
  const conversation = { id: 'conversation', agentId: 'operator', scope: 'application',
    operatorConfigurationVersionId: 'configuration', status: 'open', createdAt }
  const configuration = {
    id: 'configuration', operatorId: 'operator', version: 1,
    harness: { harness: 'opencode', model: 'saved-model', variant: 'saved-variant', nativeAgent: 'build',
      thinking: true, autoApprove: false },
    contentHash: `sha256:${'a'.repeat(64)}`, createdAt,
  }
  const message = { id: 'message', conversationId: 'conversation', role: 'assistant', content: 'Saved answer',
    nativeMessageId: 'saved-message', acceptedModel: { harness: 'opencode', model: 'saved-model' }, createdAt }
  const row = {
    id: conversation.id, record: conversation, configuration, updated_at: new Date(createdAt),
    parent_conversation_id: 'parent-conversation', handoff_source_harness: 'opencode',
    handoff_source_sequence: '3', handoff_omitted_messages: 2,
    messages: [message], activities: [], activity_cursor: null, message_count: '1',
    turn_state: 'idle', revision: '4', active_request_id: null, native_submission: null,
    last_error: null, last_result: null, pending_interaction: null, response_delivery: null,
  }
  const saved = structuredClone(row)
  const query = vi.fn(async () => ({ rows: [row] }))
  const repository = new PostgresOperatorConversationRepository({ query } as unknown as pg.Pool)
  expect(await repository.get(conversation.id)).toMatchObject({
    conversation,
    settings: { harness: 'opencode', model: 'saved-model', variant: 'saved-variant', showThinking: true },
    messages: [message],
    handoff: { parentConversationId: 'parent-conversation', sourceHarness: 'opencode',
      sourceMessageSequence: '3', omittedMessages: 2 },
  })
  expect(row).toEqual(saved)
})
