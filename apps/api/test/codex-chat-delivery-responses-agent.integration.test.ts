import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { type InteractionResponseValue } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, emit, until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const kind of ['questions', 'form', 'standalone-form'] as const) {
    it(`Agent ${kind} responses validate through HTTP and MCP, persist, and never replay native input`, async () => {
      const {
        database, native, writer, denied, writerToken, workspaceId, request, sendAgent, readAgent,
      } = fixture
      const admitted = await sendAgent({ ...request('input-turn', null), content: 'wait' })
      const id = admitted.state.conversation!.id
      const active = await until(async () => {
        const current = await readAgent()
        return current.activeTurn?.nativeTurnId && current.conversation?.nativeSession ? current : undefined
      })
      const params = kind === 'questions' ? {
        itemId: 'questions', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: true, options: null }],
      } : { mode: 'openai/form', serverName: 'app', message: 'Enter details', _meta: null,
        requestedSchema: { type: 'object', additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }
      const method = kind === 'questions' ? 'item/tool/requestUserInput' : 'mcpServer/elicitation/request'
      await emit(native.directory, { id: 5101, method, params: {
        threadId: active.conversation!.nativeSession!.nativeSessionId,
        turnId: kind === 'standalone-form' ? null : active.activeTurn!.nativeTurnId, ...params,
      } })
      const pending = await until(async () => (await readAgent()).pendingInteraction)
      if (kind === 'standalone-form') assert.equal(pending.turn.nativeTurnId, undefined)
      const response: InteractionResponseValue = kind === 'questions'
        ? { answer: { answers: ['User-entered answer'] } } : { count: 2 }
      const input = { requestId: 'input-response', nativeRequestId: pending.turn.nativeRequestId!,
        optionId: pending.responseOptions[0]!.optionId, response }
      const responses = async () => (await calls(native.directory)).filter((entry) => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 5101 && wire.result
      })
      assert.equal((await responses()).length, 0)
      const refusal = await denied.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } }).catch(() => ({ isError: true }))
      assert.equal(refusal.isError, true)
      const invalid = await fixture.app.inject({ method: 'POST',
        url: `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${writerToken}` }, payload: { ...input, response: {} } })
      assert.equal(invalid.statusCode, 400)
      assert.equal((await responses()).length, 0)
      assert.equal((await readAgent()).pendingInteraction?.turn.nativeRequestId, pending.turn.nativeRequestId)
      const valid = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } })
      assert.notEqual(valid.isError, true, JSON.stringify(valid))
      const receipt = (await database.pool.query(`select result from management_command_receipts
        where operation='agent_chat_control' and command_id=$1`, [input.requestId])).rows[0]!
      assert.deepEqual(receipt.result.acceptedControl.choice.response, response)
      assert.equal(receipt.result.status, 'completed')
      if (kind === 'questions') assert.equal(receipt.result.providerAcknowledgment, undefined)
      else {
        assert.equal(receipt.result.providerAcknowledgment.nativeRequestId, input.nativeRequestId)
        assert.equal(receipt.result.providerAcknowledgment.optionId, input.optionId)
        assert.match(receipt.result.providerAcknowledgment.responseDigest, /^[a-f0-9]{64}$/)
      }
      const state = (decodeMcpToolResult(valid) as { state: AgentChatState }).state
      const activity = state.activitySnapshot
      const decisions = [...(activity?.pendingInteractions ?? []),
        ...(activity?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? [])]
        .filter((item) => item.native?.requestId === input.nativeRequestId && item.answerRecorded)
      assert(decisions.length > 0)
      assert(decisions.every((item) => item.providerAcknowledged === (kind !== 'questions')))
      const replay = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
      } })
      assert.notEqual(replay.isError, true, JSON.stringify(replay))
      assert.equal((await responses()).length, 1)
      const conflict = await writer.callTool({ name: 'agent_chat_respond', arguments: {
        workspaceId, conversationId: id, ...input,
        response: kind === 'questions' ? { answer: { answers: ['Different answer'] } } : { count: 3 },
      } })
      assert.equal(conflict.isError, true)
      assert.equal((await responses()).length, 1)
      const nativeResponse = (await responses())[0]!.wire as { result: unknown }
      assert.deepEqual(nativeResponse.result, kind === 'questions' ? { answers: response }
        : { action: 'accept', content: response, _meta: null })
    })

  }
})
