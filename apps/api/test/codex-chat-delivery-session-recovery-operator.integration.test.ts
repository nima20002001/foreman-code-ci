import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  it('Operator failure after a prompt write retains its request and a readback cannot replay it', async () => {
    const { database, native, messages, createOperator, sendOperator, readOperator } = fixture
    const id = await createOperator()
    await sendOperator(id, 'written', 'lost-start')
    await until(async () => (await readOperator(id)).turnState === 'uncertain' || undefined)
    const row = (await messages.active(id))!
    assert.equal(row.active_request_id, 'written')
    const receipt = (await database.pool.query('select result,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2',
      [id, 'written'])).rows[0]
    assert.equal(receipt.result, null)
    assert.equal(receipt.retryable, false)
    await sendOperator(id, 'written', 'lost-start')
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })

  it('Operator late creation recovery binds one session and sends no prompt until explicit retry', async () => {
    const { native, messages, createOperator, sendOperator, readOperator } = fixture
    await native.flag('late-thread-start')
    const id = await createOperator()
    await sendOperator(id, 'late')
    await until(async () => (await readOperator(id)).turnState === 'uncertain' || undefined)
    await until(async () => {
      await fixture.operatorChat.reconcileActive()
      return (await readOperator(id)).turnState === 'error' || undefined
    })
    const sessionId = (await messages.active(id))!.native_session_id
    assert(sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 0)
    await native.unflag('late-thread-start')
    await sendOperator(id, 'retry')
    await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
    assert.equal((await messages.active(id))!.native_session_id, sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })
})
