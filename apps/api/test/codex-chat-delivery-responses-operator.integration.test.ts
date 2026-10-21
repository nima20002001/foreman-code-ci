import { OperatorCompactCapabilitiesSchema, decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, it } from 'vitest'
import { type OperatorConversationState, type InteractionResponseValue } from '@foreman-code/contracts'
import { buildApp } from '../src/app.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, emit, until } from './fixtures/codex-test-helpers.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const kind of ['questions', 'form', 'standalone-form'] as const) {
    it(`Operator ${kind} responses deny read-only callers and preserve HTTP/MCP readback after service restart`, async () => {
      const {
        database, native, messages, writer, reader, writerToken, readerToken, access, resolver, authority,
        services, clients, createOperator, sendOperator, readOperator,
      } = fixture
      const id = await createOperator()
      for (const detail of ['compact', 'full']) {
        const result = await writer.callTool({ name: 'operator_get_capabilities', arguments: { detail } })
        assert.notEqual(result.isError, true)
        const capabilities = OperatorCompactCapabilitiesSchema.pick({ runtimeLimits: true }).strip()
          .parse(decodeMcpToolResult(result))
        const support = capabilities.runtimeLimits?.find(limit => limit.feature === 'general_questions_and_forms')
        assert.equal(support?.state, 'limited')
        assert.match(support!.detail, /Codex/)
        assert.match(support!.detail, /session/)
      }
      await sendOperator(id, 'input-turn', 'wait')
      const submission = await until(async () => {
        const row = await messages.active(id)
        return row?.native_session_id && row.active_native_turn_id ? row : undefined
      })
      const params = kind === 'questions' ? {
        itemId: 'questions', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: false, options: null }],
      } : { mode: 'openai/form', serverName: 'app', message: 'Enter details', _meta: null,
        requestedSchema: { type: 'object', additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }
      const method = kind === 'questions' ? 'item/tool/requestUserInput' : 'mcpServer/elicitation/request'
      await emit(native.directory, { id: 5102, method, params: {
        threadId: submission.native_session_id,
        turnId: kind === 'standalone-form' ? null : submission.active_native_turn_id, ...params,
      } })
      const pending = await until(async () => (await readOperator(id)).pendingInteraction)
      if (kind === 'standalone-form') assert.equal(pending.turn.nativeTurnId, undefined)
      const response: InteractionResponseValue = kind === 'questions'
        ? { answer: { answers: ['User-entered answer'] } } : { count: 2 }
      const input = { commandId: 'input-response', requestId: 'input-turn', nativeRequestId: pending.turn.nativeRequestId!,
        optionId: pending.responseOptions[0]!.optionId, response }
      const responses = async () => (await calls(native.directory)).filter((entry) => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 5102 && wire.result
      })
      const deniedHttp = await fixture.app.inject({ method: 'POST', url: `/api/operator/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${readerToken}` }, payload: input })
      assert.equal(deniedHttp.statusCode, 403)
      const deniedMcp = await reader.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: input,
      } }).catch(() => ({ isError: true }))
      assert.equal(deniedMcp.isError, true)
      const invalid = await writer.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: { ...input, response: {} },
      } })
      assert.equal(invalid.isError, true)
      assert.equal((await responses()).length, 0)
      const accepted = await fixture.app.inject({ method: 'POST', url: `/api/operator/conversations/${id}/responses`,
        headers: { authorization: `Bearer ${writerToken}` }, payload: input })
      assert.equal(accepted.statusCode, 200, accepted.body)
      const receipt = (await database.pool.query(`select result from management_command_receipts
        where operation='operator_chat_control' and command_id=$1`, [input.commandId])).rows[0]!
      assert.deepEqual(receipt.result.acceptedControl.choice.response, response)
      assert.equal(receipt.result.status, 'completed')
      if (kind === 'questions') assert.equal(receipt.result.providerAcknowledgment, undefined)
      else {
        assert.equal(receipt.result.providerAcknowledgment.nativeRequestId, input.nativeRequestId)
        assert.equal(receipt.result.providerAcknowledgment.optionId, input.optionId)
        assert.match(receipt.result.providerAcknowledgment.responseDigest, /^[a-f0-9]{64}$/)
      }
      const activity = (accepted.json().state as OperatorConversationState).activitySnapshot
      const decisions = [...(activity?.pendingInteractions ?? []),
        ...(activity?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? [])]
        .filter((item) => item.native?.requestId === input.nativeRequestId && item.answerRecorded)
      assert(decisions.length > 0)
      assert(decisions.every((item) => item.providerAcknowledged === (kind !== 'questions')))
      await fixture.operatorChat.shutdown()
      fixture.operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
        resolver, native.directory, authority)
      services.operatorChat = fixture.operatorChat
      await fixture.app.close()
      fixture.app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined } }, operator: { access, services } })
      registerOperatorChatRoutes(fixture.app, fixture.operatorChat)
      const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 })
      const restarted = new Client({ name: 'restarted-input-response', version: '1' })
      clients.push(restarted)
      await restarted.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => writerToken },
      }))
      const replay = await restarted.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: id, request: input,
      } })
      assert.notEqual(replay.isError, true, JSON.stringify(replay))
      const http = await fixture.app.inject({ method: 'GET', url: `/api/operator/conversations/${id}`,
        headers: { authorization: `Bearer ${writerToken}` } })
      assert.equal(http.statusCode, 200)
      assert.equal((await responses()).length, 1)
      assert.deepEqual((await database.pool.query(`select result from management_command_receipts
        where operation='operator_chat_control' and command_id=$1`, [input.commandId])).rows[0]!.result, receipt.result)
    })
  }
})
