import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { type OperatorConversationState } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, emit, finish, until } from './fixtures/codex-test-helpers.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const surface of ['agent', 'operator'] as Array<'agent' | 'operator'>) {
    for (const scenario of [
      { answer: 'Pear', completed: true },
      { answer: 'Native forms custom label', completed: true },
      { answer: 'Pear', completed: false },
    ]) {
      it(`${surface} native answer ${scenario.answer} reads back ${scenario.completed ? 'confirmed' : 'unconfirmed'}`, async () => {
        const {
          database, native, writer, denied, reader, writerToken, context, workspaceId, request, sendAgent,
          readAgent, createOperator, sendOperator, readOperator, restartAgentService,
        } = fixture
        const id = surface === 'agent'
          ? (await sendAgent({ ...request('question-turn', null), content: 'wait' })).state.conversation!.id
          : await createOperator()
        if (surface === 'operator') await sendOperator(id, 'question-turn', 'wait')
        const read = () => surface === 'agent' ? readAgent() : readOperator(id)
        const active = await until(async () => {
          const current = await read()
          const native = current.activitySnapshot?.active.find(item => item.ref.kind === 'chat_request')?.native
          return native?.turnId ? native : undefined
        })
        await emit(native.directory, { id: 5200, method: 'item/tool/requestUserInput', params: {
          threadId: active.sessionId, turnId: active.turnId!, itemId: 'fruit-question',
          isBlocking: true, autoResolutionMs: null, questions: [{ id: 'fruit', header: 'Fruit',
            question: 'Choose a fruit', isOther: true, isSecret: false,
            options: [{ label: 'Apple', description: 'Apple' }, { label: 'Pear', description: 'Pear' }] }],
        } })
        const pending = await until(async () => (await read()).pendingInteraction)
        const response = { fruit: { answers: [scenario.answer] } }
        const choice = { nativeRequestId: pending.turn.nativeRequestId!, optionId: pending.responseOptions[0]!.optionId,
          response }
        const tool = surface === 'agent' ? 'agent_chat_respond' : 'operator_chat_respond'
        const args = surface === 'agent'
          ? { workspaceId, conversationId: id, requestId: 'answer-control', ...choice }
          : { conversationId: id, request: { commandId: 'answer-control', requestId: 'question-turn', ...choice } }
        await expectMcpAccessDenied((surface === 'agent' ? denied : reader).callTool({
          name: tool, arguments: args,
        }))
        const accepted = await writer.callTool({ name: tool, arguments: args })
        assert.notEqual(accepted.isError, true, JSON.stringify(accepted))
        const summary = (current: AgentChatState | OperatorConversationState) => {
          const activity = current.activitySnapshot
          return [...(activity?.pendingInteractions ?? []), ...(activity?.activities.flatMap(item =>
            item.kind === 'interaction' ? [item.interaction] : []) ?? [])]
            .find(item => item.native?.requestId === choice.nativeRequestId && item.answerRecorded)
        }
        assert.equal(summary(await read())?.providerAcknowledged, false)
        if (scenario.completed) {
          await finish(native.directory, active.sessionId, `RECEIVED ${scenario.answer}`)
          await until(async () => {
            if (surface === 'operator') await fixture.operatorChat.reconcileActive()
            const current = await read()
            const idle = surface === 'agent' ? (current as AgentChatState).sessionState === 'idle'
              : (current as OperatorConversationState).turnState === 'idle'
            return idle && summary(current)?.providerAcknowledged ? current : undefined
          })
        }
        const operation = surface === 'agent' ? 'agent_chat_control' : 'operator_chat_control'
        const stored = (await database.pool.query(`select result from management_command_receipts
          where operation=$1 and command_id='answer-control'`, [operation])).rows[0]!.result
        assert.equal(Boolean(stored.providerAcknowledgment), scenario.completed)
        assert.deepEqual(stored.acceptedControl.choice.response, response)
        const url = surface === 'agent' ? `/api/workspaces/${workspaceId}/agent-chat?workflowId=${context.workflowId}`
          + `&workflowNodeId=${context.workflowNodeId}&agentId=${context.agentId}` : `/api/operator/conversations/${id}`
        const http = await fixture.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${writerToken}` } })
        assert.equal(http.statusCode, 200, http.body)
        assert.equal(summary(http.json())?.providerAcknowledged, scenario.completed)
        assert.equal(summary(await read())?.providerAcknowledged, scenario.completed)
        if (scenario.completed && surface === 'agent') {
          await fixture.agentChat.shutdown()
          restartAgentService()
          assert.equal(summary(await readAgent())?.providerAcknowledged, true)
        }
        const replay = await writer.callTool({ name: tool, arguments: args })
        assert.notEqual(replay.isError, true, JSON.stringify(replay))
        const responses = (await calls(native.directory)).filter(entry => {
          const wire = entry.wire as { id?: number; result?: unknown } | undefined
          return wire?.id === 5200 && wire.result
        })
        assert.equal(responses.length, 1)
      })
    }
  }
})
