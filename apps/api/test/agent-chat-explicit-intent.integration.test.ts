import { expect, it } from 'vitest'
import { AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'

it('preserves ordinary explicit Agent intents through authenticated MCP before group composition is installed', async () => {
  const f = await remoteAgentConversation('codex', 'main')
  try {
    const sent = await f.send('Keep the existing conversation available')
    const request = { requestId: sent.requestId, content: 'Keep the existing conversation available', intent: 'next_turn',
      expectedConversationId: f.conversation.id, context: f.context }
    const denied = await f.call('agent_chat_send', { request }, f.reader.token)
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const replay = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
    expect(replay.replayed).toBe(true)
    expect(replay.turn).toMatchObject({ requestId: sent.requestId, delivery: 'completed' })
    const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    expect(read.messages.filter(message => message.role === 'user' && message.requestId === sent.requestId))
      .toHaveLength(1)
    const automatic = await f.call('agent_chat_send', { request: { ...request, requestId: 'automatic-unavailable', intent: 'auto' } })
    expect(automatic.result?.isError).toBe(true)
    expect(JSON.stringify(automatic)).toContain('CHAT_DELIVERY_UNAVAILABLE')
  } finally { await f.close() }
})
