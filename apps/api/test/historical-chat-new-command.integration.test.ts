import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatResetResponseSchema } from '@foreman-code/contracts/agent-chat'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { forkHistoricalChat, historicalChatPlacement, historicalChatSource,
  waitForHistoricalChatTurn } from './helpers/historicalChatPlacement.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('keeps the accepted Run Worker, profile and working tree after /new while discarding native history', async () => {
  await historicalChatPlacement(async fixture => {
    await fixture.provider.blockRequesterSession()
    const source = await historicalChatSource(fixture, { parent: 'active' })
    expect(source.before.run.executionState).toBe('running')
    const original = await forkHistoricalChat(fixture, source)
    const { workspaceId, selection, execution, before, started } = source
    const reader = await fixture.access.issue({ name: 'Run chat history reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const request = { selection, workspaceId,
      message: { requestId: randomUUID(), content: '/new', expectedConversationId: original.id } }
    const denied = await fixture.call('agent_chat_send', request, reader.token)
    expect(denied.isError).toBe(true)
    const response = AgentChatResetResponseSchema.parse(await fixture.value('agent_chat_send', request))
    const id = response.state.conversation!.id
    const requestId = randomUUID()
    await fixture.value('agent_chat_send', { workspaceId, selection,
      message: { requestId, content: 'Start a fresh task on the accepted Worker', expectedConversationId: id } })
    const state = await waitForHistoricalChatTurn(source.read, requestId, 'fresh Run chat on the accepted Worker')
    expect(state.conversation?.nativeSession?.nativeSessionId).not.toBe(original.completed.conversation?.nativeSession?.nativeSessionId)
    expect(state.conversation?.nativeSession?.nativeSessionId).not.toBe(execution.nativeSessionId)
    const readBinding = async (conversationId: string) => {
      const row = (await fixture.db.pool.query<{ worker_conversation_binding: unknown }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [conversationId])).rows[0]!
      return WorkerConversationBindingSchema.parse(row.worker_conversation_binding)
    }
    const oldBinding = await readBinding(original.id)
    const newBinding = await readBinding(id)
    expect(newBinding.profile).toEqual(oldBinding.profile)
    expect(newBinding.profile.target.hostRef).toEqual(fixture.hostRef)
    expect(newBinding.sourceExecution).toEqual(oldBinding.sourceExecution)
    expect(newBinding.workingDirectory).toBe(oldBinding.workingDirectory)
    expect((await fixture.provider.calls()).filter(call => call.forkedSession)).toHaveLength(1)
    expect(await fixture.details(started.run.id)).toEqual(before)
    await fixture.value('run_stop', { workspaceId, runId: started.run.id, commandId: randomUUID() })
    await waitForRemoteReview(async () => {
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, value => value.run.executionState === 'completed' && value.cleanupPending !== true,
    'stopped source Run cleanup', fixture.subscribeNativeChanges)
  }, { workflow: 'approval' })
}, 240_000)
