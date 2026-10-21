import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`Operator ${fault} creation failure permits explicit retry after cleanup`, async () => {
      const { native, messages, createOperator, sendOperator, readOperator } = fixture
      if (fault === 'auth') await native.flag('logged-out')
      if (fault === 'model') await native.json('models.json', { models: [] })
      if (fault === 'initialize') await native.flag('reject-initialize')
      const id = await createOperator()
      await sendOperator(id, 'first')
      await until(async () => (await readOperator(id)).turnState === 'error' || undefined)
      assert.equal((await messages.active(id))!.active_request_id, null)
      assert.equal((await messages.active(id))!.native_session_id, null)
      assert.equal((await native.wire('thread/start')).length, 0)
      await native.unflag('logged-out')
      await native.unflag('models.json')
      await native.unflag('reject-initialize')
      await sendOperator(id, 'retry')
      await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 1)
    })
  }
})
