import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatResetResponseSchema, AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'

type Fixture = Awaited<ReturnType<typeof remoteAgentConversation>>

function selected(f: Fixture) {
  const source = f.executions[0]!
  return { workflowId: f.context.workflowId, runId: source.runId,
    workflowNodeId: f.context.workflowNodeId, executionId: source.id }
}

async function reset(f: Fixture, expectedConversationId: string | null = f.conversation.id) {
  return AgentChatResetResponseSchema.parse(await f.value('agent_chat_send', {
    selection: selected(f), message: { requestId: randomUUID(), content: '/new', expectedConversationId },
  }))
}

async function completed(f: Fixture, conversationId: string, requestId: string) {
  let state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context, conversationId }))
  await vi.waitFor(async () => {
    state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context, conversationId }))
    const turn = state.turns.find(value => value.requestId === requestId)
    if (turn?.delivery === 'failed' || turn?.delivery === 'canceled') {
      throw new Error(JSON.stringify(turn.error))
    }
    expect(turn?.delivery).toBe('completed')
  }, { timeout: 5000 })
  return state
}

it.each(['main', 'worker'] as const)('sends the first Claude Run-chat turn after /new on %s', async location => {
  const f = await remoteAgentConversation('claude', location, { runAttempts: 1 })
  try {
    const response = await reset(f)
    const id = response.state.conversation!.id
    const requestId = randomUUID()
    await f.value('agent_chat_send', { request: { requestId, content: 'Start a fresh Run conversation',
      expectedConversationId: id, context: f.context } })
    const state = await completed(f, id, requestId)
    expect(state.conversation?.origin).toEqual(f.conversation.record.origin)
    expect(state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Start a fresh Run conversation'])
    expect(state.conversation?.nativeSession?.nativeSessionId).not.toBe(f.executions[0]!.nativeSessionId)
  } finally { await f.close() }
}, 30_000)

it.each(['codex', 'claude'] as const)('starts a fresh %s session when /new precedes the first Run-chat message', async harness => {
  const f = await remoteAgentConversation(harness, 'main', { runAttempts: 1 })
  try {
    await f.db.pool.query('delete from operator_conversations where id=$1', [f.conversation.id])
    const response = await reset(f, null)
    const id = response.state.conversation!.id
    expect(response.reset.previousConversationId).toBeNull()
    expect(response.state.messages).toEqual([])
    const requestId = randomUUID()
    await f.value('agent_chat_send', { request: { requestId, content: 'Use fresh context instead of the Run transcript',
      expectedConversationId: id, context: f.context } })
    const state = await completed(f, id, requestId)
    expect(f.providers.flatMap(provider => provider.calls).filter(method => method === 'thread/fork')).toEqual([])
    expect(f.providers.flatMap(provider => provider.prompts)).toHaveLength(1)
    expect(state.conversation?.nativeSession?.nativeSessionId).not.toBe(f.executions[0]!.nativeSessionId)
  } finally { await f.close() }
}, 30_000)

it.each(['http', 'mcp'] as const)('resets an earlier Run execution through the ordinary %s message endpoint', async transport => {
  const f = await remoteAgentConversation('codex', 'main', { runAttempts: 2 })
  try {
    const { workspaceId, ...context } = f.context
    const request = { requestId: randomUUID(), content: '/new', intent: 'next_turn',
      expectedConversationId: f.conversation.id, context }
    const send = async () => {
      if (transport === 'mcp') return f.value('agent_chat_send', { request })
      const response = await f.app.inject({ method: 'POST',
        url: `/api/workspaces/${workspaceId}/agent-chat/messages`,
        headers: { authorization: `Bearer ${f.writer.token}` }, payload: request })
      expect([200, 202], response.body).toContain(response.statusCode)
      return response.json()
    }
    const first = AgentChatResetResponseSchema.parse(await send())
    expect(first.state.conversation?.origin).toEqual(f.conversation.record.origin)
    expect(first.reset.previousConversationId).toBe(f.conversation.id)
    const replay = AgentChatResetResponseSchema.parse(await send())
    expect(replay.replayed).toBe(true)
    expect(replay.state.conversation?.id).toBe(first.state.conversation?.id)
    const foreign = await f.call('agent_chat_send', { request: { ...request, requestId: randomUUID(),
      context: { ...f.context, workflowNodeId: 'another-node' } } })
    expect(foreign.error || foreign.result?.isError).toBeTruthy()
    expect(f.providers.flatMap(provider => provider.prompts)).toEqual([])
  } finally { await f.close() }
}, 30_000)

it.each(['fresh', 'selected Run'] as const)('handles concurrent %s resets with one database connection', async origin => {
  const options = origin === 'fresh' ? { poolSize: 1 } : { poolSize: 1, runAttempts: 1 }
  const f = await remoteAgentConversation('codex', 'main', options)
  try {
    const message = { requestId: randomUUID(), content: '/new', expectedConversationId: f.conversation.id }
    const args = origin === 'fresh' ? { request: { ...message, context: f.context } }
      : { selection: selected(f), message }
    const responses = await Promise.all([f.value('agent_chat_send', args), f.value('agent_chat_send', args)])
    const resets = responses.map(value => AgentChatResetResponseSchema.parse(value))
    expect(resets.map(value => value.replayed).sort()).toEqual([false, true])
    expect(new Set(resets.map(value => value.state.conversation!.id)).size).toBe(1)
    const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context,
      conversationId: resets[0]!.state.conversation!.id }))
    expect(read.conversation?.id).toBe(resets[0]!.state.conversation!.id)
  } finally { await f.close() }
}, 30_000)

it('recovers a lost Run-chat Codex session and requires an explicit retry before sending the message', async () => {
  const f = await remoteAgentConversation('codex', 'main', { runAttempts: 1 })
  try {
    const resetResponse = await reset(f)
    const id = resetResponse.state.conversation!.id
    const provider = await f.prepareProvider(id)
    provider.loseNextCreationResponse()
    const requestId = randomUUID()
    await f.value('agent_chat_send', { request: { requestId, content: 'Recover this one message',
      expectedConversationId: id, context: f.context } })
    let state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context, conversationId: id }))
    await vi.waitFor(async () => {
      state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context, conversationId: id }))
      expect(state.conversation?.nativeSession?.nativeSessionId).toBeTruthy()
      expect(state.turns.find(turn => turn.requestId === requestId)).toMatchObject({ delivery: 'failed',
        error: { message: 'The original session was recovered before the message was sent. Send the message again.' } })
    }, { timeout: 5000 })
    const session = state.conversation!.nativeSession!
    expect(provider.prompts).toEqual([])
    const replay = await f.value('agent_chat_send', { request: { requestId, content: 'Recover this one message',
      expectedConversationId: id, context: f.context } }) as { replayed: boolean }
    expect(replay.replayed).toBe(true)
    expect(provider.prompts).toEqual([])
    const retry = await f.send('Send the explicitly retried message', 'completed', [], id)
    state = await completed(f, id, retry.requestId)
    expect(state.conversation?.nativeSession).toEqual(session)
    expect(provider.calls.filter(method => method === 'thread/start')).toHaveLength(1)
    expect(provider.calls.filter(method => method === 'thread/fork')).toEqual([])
    expect(provider.prompts).toHaveLength(1)
    expect(state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Recover this one message', 'Send the explicitly retried message'])
  } finally { await f.close() }
}, 30_000)
