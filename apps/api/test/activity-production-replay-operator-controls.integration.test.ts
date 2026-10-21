import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: operator-controls', { timeout: 120000 }, () => {
  for (const uncertain of [false, true]) it(`Operator control parity: ${uncertain ? 'uncertain' : 'accepted'} response, changed choice, cached grant checks and cancel`, async () => {
    const f = await setup()
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Operator parity controls' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'operator-parity-turn', content: 'Wait for exact native approval' })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => !!state.pendingInteraction && state.responseAvailability?.available === true)
    const pending = waiting.pendingInteraction!, option = pending.responseOptions.find((entry) => entry.semantic === 'approve_once')!
    const alternative = pending.responseOptions.find((entry) => entry.optionId !== option.optionId)!
    const request = { requestId: 'operator-parity-turn', nativeRequestId: pending.turn.nativeRequestId!, optionId: option.optionId, commandId: 'operator-answer-key' }
    const denied = await f.call('operator_chat_respond', { conversationId: id, request }, f.denied.token)
    expect(denied.isError).toBe(true); expect(f.replay.responses).toHaveLength(0)
    if (uncertain) f.replay.nextResponse = 'uncertain'
    const answered = await f.http('POST', `/api/operator/conversations/${id}/responses`, request)
    expect(answered.statusCode, answered.body).toBe(uncertain ? 409 : 200)
    const retried = await f.call('operator_chat_respond', { conversationId: id, request })
    expect(retried.isError === true).toBe(uncertain)
    expect(f.replay.responses).toHaveLength(1)
    const changed = await f.http('POST', `/api/operator/conversations/${id}/responses`, { ...request, optionId: alternative.optionId })
    expect(changed.statusCode, changed.body).toBe(409)
    expect(changed.json().error.code).toBe('OPERATOR_CHAT_REQUEST_CONFLICT')
    const receipt = (await f.db.pool.query(`select result from management_command_receipts where principal_id=$1
      and operation='operator_chat_control' and command_id=$2`, [f.writer.principal.id, request.commandId])).rows[0]!.result
    expect(receipt).toMatchObject({ status: uncertain ? 'uncertain' : 'completed', acceptedControl: { conversationId: id,
      modelRequestId: request.requestId, native: { sessionId: native.sessionId, turnId: native.turnId, requestId: request.nativeRequestId },
      choice: { optionId: option.optionId, semantic: option.semantic } } })
    expect((await f.call('operator_chat_get', { conversationId: id })).isError).not.toBe(true)
    const cancel = { requestId: request.requestId, commandId: 'operator-cancel-key' }
    const canceled = await f.http('POST', `/api/operator/conversations/${id}/cancel`, cancel)
    expect(canceled.statusCode, canceled.body).toBe(200)
    const nativeCancels = f.replay.calls.filter((entry) => entry.method === 'turn/interrupt').length
    const cancelRetry = await f.call('operator_chat_cancel', { conversationId: id, request: cancel })
    expect(cancelRetry.isError).not.toBe(true)
    expect(f.replay.calls.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(nativeCancels)
    expect((await f.db.pool.query(`select count(*)::int as count from management_command_receipts where principal_id=$1
      and operation='operator_chat_control' and command_id=$2`, [f.writer.principal.id, cancel.commandId])).rows[0]!.count).toBe(1)
    for (const title of ['First implicit control scope', 'Second implicit control scope']) {
      const newConversation = await f.http('POST', '/api/operator/conversations', { title })
      expect(newConversation.statusCode, newConversation.body).toBe(201)
      const otherId = newConversation.json().conversation.id
      expect((await f.http('POST', `/api/operator/conversations/${otherId}/messages`, { requestId: 'same-per-conversation-model-id', content: 'Own independent cancellation' })).statusCode).toBe(202)
      const implicit = await f.http('POST', `/api/operator/conversations/${otherId}/cancel`, { requestId: 'same-per-conversation-model-id' })
      expect(implicit.statusCode, implicit.body).toBe(200)
      const implicitRetry = await f.call('operator_chat_cancel', { conversationId: otherId, request: { requestId: 'same-per-conversation-model-id' } })
      expect(implicitRetry.isError).not.toBe(true)
    }
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
      JSON.stringify([{ actions: ['operator_chat:read'], scope: {} }])])
    const noAction = await f.call('operator_chat_respond', { conversationId: id, request })
    expect(noAction.isError).toBe(true)
    expect((await f.http('POST', `/api/operator/conversations/${id}/cancel`, cancel)).statusCode).toBe(403)
    expect(f.replay.responses).toHaveLength(1)
  })
})
