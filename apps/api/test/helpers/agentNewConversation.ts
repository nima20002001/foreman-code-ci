import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import type { remoteAgentConversation } from './remoteAgentConversation.js'

export async function assertAgentNewConversation(f: Awaited<ReturnType<typeof remoteAgentConversation>>) {
  const id = f.conversation.id
  await f.send('Keep this conversation in history')
  const original = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
  const request = { requestId: randomUUID(), content: '/new', intent: 'next_turn',
    expectedConversationId: id, context: f.context }
  const denied = await f.call('agent_chat_send', { request }, f.reader.token)
  expect(denied.error || denied.result?.isError).toBeTruthy()
  expect(AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))).toMatchObject({
    conversation: { id, nativeSession: original.conversation!.nativeSession },
  })
  const response = await f.value('agent_chat_send', { request }) as {
    state: unknown; replayed: boolean; reset: { requestId: string; previousConversationId: string }
  }
  expect(response.replayed).toBe(false)
  expect(response.reset).toEqual({ requestId: request.requestId, previousConversationId: id })
  const fresh = AgentChatStateSchema.parse(response.state)
  const freshId = fresh.conversation!.id
  expect(freshId).not.toBe(id)
  expect(fresh.conversation).toMatchObject({ agentId: f.context.agentId, harness: f.configuration.harness.harness,
    nativeSession: null, previousConversationId: id })
  expect(fresh.messages).toEqual([])
  expect(fresh.turns).toEqual([])
  expect(f.provider.prompts).toHaveLength(1)
  const replay = await f.value('agent_chat_send', { request }) as typeof response
  expect(replay.replayed).toBe(true)
  expect(AgentChatStateSchema.parse(replay.state).conversation?.id).toBe(freshId)
  const conflict = await f.call('agent_chat_send', { request: { ...request, intent: 'interrupt_and_send' } })
  expect(conflict.error || conflict.result?.isError).toBeTruthy()
  const stale = await f.call('agent_chat_send', { request: { ...request, requestId: randomUUID() } })
  expect(stale.error || stale.result?.isError).toBeTruthy()
  await f.send('Start with no previous context', 'completed', [], freshId)
  const current = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
  expect(current.conversation?.id).toBe(freshId)
  expect(current.conversation?.nativeSession?.nativeSessionId).toBeTruthy()
  expect(current.conversation?.nativeSession?.nativeSessionId).not.toBe(original.conversation?.nativeSession?.nativeSessionId)
  expect(current.messages.filter(message => message.role === 'user').map(message => message.content))
    .toEqual(['Start with no previous context'])
  const historical = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context, conversationId: id }))
  expect(historical.conversation?.nativeSession).toEqual(original.conversation?.nativeSession)
  expect(historical.messages).toEqual(original.messages)
  expect(f.providers).toHaveLength(2)
  expect(f.providers[1]!.prompts).toHaveLength(1)
}
