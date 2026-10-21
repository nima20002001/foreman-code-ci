import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  it('Operator pre-send file failure settles as retryable after cleanup and is visible through MCP', async () => {
    const { database, native, reader, settings, createOperator, sendOperator, readOperator } = fixture
    fixture.operatorFiles = { prepare: async () => { throw new Error('The admitted attachment is unavailable.') } }
    const id = await createOperator()
    await sendOperator(id, 'unsent')
    const state = await until(async () => {
      const current = await readOperator(id)
      return current.turnState === 'error' ? current : undefined
    })
    assert.equal(state.activeRequestId, null)
    assert.equal((await native.wire('turn/start')).length, 0)
    const receipt = (await database.pool.query('select result,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2',
      [id, 'unsent'])).rows[0]
    assert.equal(receipt.result.outcome, 'failed')
    assert.equal(receipt.retryable, true)
    await expectMcpAccessDenied(reader.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'denied', content: 'Denied', settings },
    } }))
    fixture.operatorFiles = undefined
    await sendOperator(id, 'retry')
    await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })
})
