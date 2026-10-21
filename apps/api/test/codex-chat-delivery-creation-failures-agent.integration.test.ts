import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`Agent ${fault} rejection retires only the unsent creation and allows an explicit retry`, async () => {
      const { native, repository, denied, workspaceId, request, sendAgent, readAgent } = fixture
      if (fault === 'auth') await native.flag('logged-out')
      if (fault === 'model') await native.json('models.json', { models: [] })
      if (fault === 'initialize') await native.flag('reject-initialize')
      const input = request('first', null)
      const admitted = await sendAgent(input)
      const id = admitted.state.conversation!.id
      await until(async () => (await repository.turn(id, 'first'))?.delivery === 'failed' || undefined)
      assert.equal((await readAgent()).availability.canSend, true)
      assert.equal((await repository.get(id))!.record.sessionCreation, undefined)
      assert.equal((await sendAgent({ ...input, expectedConversationId: id })).replayed, true)
      const before = await repository.state(id)
      const refusal = await denied.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: request('denied', id) } })
      assert.equal(refusal.isError, true)
      assert.deepEqual(await repository.state(id), before)
      assert.equal((await native.wire('thread/start')).length, 0)
      await native.unflag('logged-out')
      await native.unflag('models.json')
      await native.unflag('reject-initialize')
      await sendAgent(request('retry', id))
      await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 1)
    })
  }
})
