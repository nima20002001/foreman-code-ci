import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { CodexStdioTransport, isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery({ manualLateReplies: true })

  it('agent recovers a late creation rejection received before the uncertain request unwinds', async () => {
    const { native, request, sendAgent, readAgent } = fixture
    const rpcRequest = CodexStdioTransport.prototype.request
    const observed = vi.spyOn(CodexStdioTransport.prototype, 'request')
      .mockImplementation(async function (this: CodexStdioTransport, ...args) {
        try {
          return await rpcRequest.call(this, ...args)
        } catch (error) {
          if (args[0] === 'thread/start') {
            await native.flag('release-late-creation-rejection')
            // Process exit confirms the late rejection was received and its transport closed.
            await until(async () => {
              const records = await calls(native.directory)
              const owner = records.find(entry => isObject(entry.wire) && entry.wire.method === 'thread/start')
              return owner && records.some(entry => entry.exited === owner.processPid) || undefined
            })
          }
          throw error
        }
      })
    try {
      await native.flag('late-reject-thread-start')
      const id = (await sendAgent(request('late-rejected', null))).state.conversation!.id
      const failed = await until(async () => {
        await fixture.agentChat.recover()
        const state = await readAgent()
        return state.turns.find(turn => turn.requestId === 'late-rejected' && turn.delivery === 'failed')
      })
      assert.equal(failed.error?.code, 'CODEX_APP_SERVER_REQUEST_FAILED')
      assert.equal((await readAgent()).conversation?.id, id)
      assert.equal((await readAgent()).availability.canSend, true)
      const denied = await fixture.denied.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId: fixture.workspaceId, query: fixture.context,
      } })
      assert.equal(denied.isError, true)
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 0)
      await native.unflag('late-reject-thread-start')
      await sendAgent(request('retry', id))
      await until(async () => (await readAgent()).turns.some(turn =>
        turn.requestId === 'retry' && turn.delivery === 'completed') || undefined)
      assert.equal((await native.wire('thread/start')).length, 2)
      assert.equal((await native.wire('turn/start')).length, 1)
    } finally {
      observed.mockRestore()
    }
  })

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} retains a late definitive creation rejection, cleans up, and permits explicit retry`, async () => {
      const {
        native, repository, denied, reader, workspaceId, request, sendAgent, readAgent,
        createOperator, sendOperator, readOperator,
      } = fixture
      await native.flag('late-reject-thread-start')
      const id = kind === 'agent' ? (await sendAgent(request('late-rejected', null))).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'late-rejected')
      await until(async () => kind === 'agent'
        ? (await repository.turn(id, 'late-rejected'))?.delivery === 'unknown' || undefined
        : (await readOperator(id)).turnState === 'uncertain' || undefined)
      if (kind === 'agent') assert.equal((await readAgent()).availability.canSend, false)
      else assert.equal((await readOperator(id)).activeRequestId, 'late-rejected')
      await native.flag('release-late-creation-rejection')
      await until(async () => {
        if (kind === 'agent') {
          await fixture.agentChat.recover()
          return (await repository.turn(id, 'late-rejected'))?.delivery === 'failed' || undefined
        }
        await fixture.operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'error' || undefined
      })
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 0)
      if (kind === 'agent') {
        assert.equal((await repository.get(id))!.record.sessionCreation, undefined)
        assert.equal((await readAgent()).availability.canSend, true)
      } else assert.equal((await readOperator(id)).activeRequestId, null)
      if (kind === 'agent') {
        assert.equal((await sendAgent(request('late-rejected', id))).replayed, true)
        const before = await readAgent()
        await expectMcpAccessDenied(denied.callTool({ name: 'agent_chat_send', arguments: {
          workspaceId, request: request('denied', id),
        } }))
        assert.deepEqual(await readAgent(), before)
      } else {
        const before = await readOperator(id)
        await expectMcpAccessDenied(reader.callTool({ name: 'operator_chat_send', arguments: {
          conversationId: id, request: { requestId: 'denied', content: 'Denied', settings: fixture.settings },
        } }))
        assert.deepEqual(await readOperator(id), before)
      }
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 0)
      await native.unflag('late-reject-thread-start')
      if (kind === 'agent') {
        await sendAgent(request('retry', id))
        await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      } else {
        await sendOperator(id, 'retry')
        await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      }
      assert.equal((await native.wire('thread/start')).length, 2)
      assert.equal((await native.wire('turn/start')).length, 1)
    })

  }
})
