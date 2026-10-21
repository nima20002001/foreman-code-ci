import type { OperatorConversationStreamEvent, OperatorConversationState } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { agentMessage, emit, finish, until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Operator streaming after a native response', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  it.each(['approval', 'question'] as const)('keeps live output after answering a %s without background reconciliation', async kind => {
    const { native, messages, writer, reader, writerToken, readerToken, createOperator, sendOperator, readOperator } = fixture
    const id = await createOperator()
    const requestId = 'waiting-turn'
    const streamed: OperatorConversationStreamEvent[] = []
    const unsubscribe = fixture.operatorChat.events.subscribe(id, event => { streamed.push(event) })
    try {
      await sendOperator(id, requestId, 'wait')
      const submitted = await until(async () => {
        const row = await messages.active(id)
        return row?.native_session_id && row.active_native_turn_id ? row : undefined
      })
      const threadId = submitted.native_session_id!
      const turnId = submitted.active_native_turn_id!
      const method = kind === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput'
      const params = kind === 'approval' ? {
        itemId: 'waiting-command', command: 'printf harmless', cwd: native.directory, startedAtMs: 1,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      } : {
        itemId: 'waiting-question', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: false, options: null }],
      }
      await emit(native.directory, { id: 5103, method, params: { threadId, turnId, ...params } })
      const pending = await until(async () => (await readOperator(id)).pendingInteraction)
      const option = kind === 'approval'
        ? pending.responseOptions.find(item => item.semantic === 'approve_once')!
        : pending.responseOptions[0]!
      const request = { commandId: 'answer-wait', requestId, nativeRequestId: pending.turn.nativeRequestId!,
        optionId: option.optionId,
        ...(kind === 'question' ? { response: { answer: { answers: ['Continue streaming'] } } } : {}) }
      const url = `/api/operator/conversations/${id}/responses`
      const deniedHttp = await fixture.app.inject({ method: 'POST', url,
        headers: { authorization: `Bearer ${readerToken}` }, payload: request })
      expect(deniedHttp.statusCode).toBe(403)
      const deniedMcp = await reader.callTool({ name: 'operator_chat_respond', arguments: { conversationId: id, request } })
        .catch(() => ({ isError: true }))
      expect(deniedMcp.isError).toBe(true)
      if (kind === 'approval') {
        const responded = await fixture.app.inject({ method: 'POST', url,
          headers: { authorization: `Bearer ${writerToken}` }, payload: request })
        expect(responded.statusCode, responded.body).toBe(200)
      } else {
        const responded = await writer.callTool({ name: 'operator_chat_respond', arguments: { conversationId: id, request } })
        expect(responded.isError).not.toBe(true)
      }

      // Emit only after respond's one-shot history read has completed. No
      // reconciler runs in this fixture, so only the live consumer can deliver it.
      const itemId = 'after-response'
      const text = `Live output after ${kind}`
      await emit(native.directory, { method: 'item/started', params: {
        threadId, turnId, item: agentMessage(itemId, '', 'commentary'), startedAtMs: 2,
      } })
      await emit(native.directory, { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: text } })
      await vi.waitFor(() => expect(streamed).toContainEqual(expect.objectContaining({
        type: 'delta', data: expect.objectContaining({ requestId, activityChange: expect.objectContaining({
          change: expect.objectContaining({ kind: 'text.append', text, finality: 'provisional' }),
        }) }),
      })), { timeout: 20_000 })
      await emit(native.directory, { method: 'item/completed', params: {
        threadId, turnId, item: agentMessage(itemId, text, 'commentary'), completedAtMs: 3,
      } })
      await finish(native.directory, threadId)
      const state = await until(async () => {
        const result = await readOperator(id)
        return result.turnState === 'idle' ? result : undefined
      })
      expect(state.messages).toContainEqual(expect.objectContaining({ requestId, content: text }))
      const http = await fixture.app.inject({ method: 'GET', url: `/api/operator/conversations/${id}`,
        headers: { authorization: `Bearer ${writerToken}` } })
      expect(http.statusCode).toBe(200)
      expect((http.json() as OperatorConversationState).messages).toEqual(state.messages)
      expect(await native.wire('turn/start')).toHaveLength(1)
    } finally { unsubscribe() }
  })
})
