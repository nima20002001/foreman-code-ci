import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, AgentChatStreamEventSchema } from '@foreman-code/contracts/agent-chat'
import { server } from '../../mocks/server'
import { agentChatFixtureFor, createAgentChatMock } from '../mocks/agentChatHandlers'
import { agentChatApi } from './agentChat'

describe('frozen Agent chat HTTP client', () => {
  it.each(Object.entries(agentChatFixtures))('parses shared fixture %s through MSW', async (_name, fixture) => {
    server.use(...createAgentChatMock(fixture).handlers)
    expect(await agentChatApi.read(fixture.context)).toEqual(fixture)
  })
  it('encodes all query identity fields including the selected Run', async () => {
    const context = { workspaceId: 'space id', workflowId: 'flow&other', workflowNodeId: 'node/2', agentId: 'Agent + two', runId: 'run?two' }
    const state = agentChatFixtureFor(agentChatFixtures.runActive, context)
    let requested: URL | undefined
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', ({ request }) => { requested = new URL(request.url); return HttpResponse.json(state) }))
    expect(await agentChatApi.read(context)).toEqual(state)
    expect(requested!.pathname).toBe('/api/workspaces/space%20id/agent-chat')
    for (const field of ['workflowId', 'workflowNodeId', 'agentId', 'runId'] as const) expect(requested!.searchParams.get(field)).toBe(context[field])
  })
  it('rejects malformed success instead of pretending a message was delivered', async () => {
    server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', () => HttpResponse.json({ ok: true })))
    const { workspaceId, ...context } = agentChatFixtures.empty.context
    await expect(agentChatApi.send(workspaceId, { requestId: 'request-test', context, content: 'Hello', intent: 'next_turn', expectedConversationId: null }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects a foreign history page and keeps history bounded', async () => {
    const state = agentChatFixtures.active
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:id/history', ({ request }) => {
      expect(new URL(request.url).searchParams.get('limit')).toBe('50')
      expect(new URL(request.url).searchParams.get('before')).toBe('12')
      return HttpResponse.json({ conversationId: 'wrong-conversation', messages: [], nextCursor: null })
    }))
    await expect(agentChatApi.history(state.context.workspaceId, state.conversation.id, '12')).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
  })
  it('serves an enveloped contract snapshot over the MSW SSE endpoint', async () => {
    const state = agentChatFixtures.active
    server.use(...createAgentChatMock(state).handlers)
    const response = await fetch(`${location.origin}/api/workspaces/${state.context.workspaceId}/agent-chat/conversations/${state.conversation.id}/events`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text(), data = text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)
    const event = AgentChatStreamEventSchema.parse(JSON.parse(data))
    expect(event.type).toBe('snapshot'); expect(event.data).toEqual(state)
  })
})
