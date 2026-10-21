import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { server } from '../../mocks/server'
import { agentChatApi } from './agentChat'

it.each([false, true])('accepts a persisted Agent delivery receipt without inventing a turn (snapshot: %s)', async snapshot => {
  const { workspaceId, ...context } = agentChatFixtures.empty.context
  const request = { requestId: 'retained-command', content: 'Keep this input', intent: 'next_turn' as const,
    expectedConversationId: null, context }
  const receipt = { id: 'receipt', commandId: request.requestId, target: { kind: 'agent_conversation',
    agent: { workspaceId, ...context }, conversationId: 'conversation' }, requestedIntent: 'next_turn', appliedIntent: 'next_turn',
    state: 'queued', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  const response = { receipt, replayed: false, ...(snapshot ? { state: agentChatFixtures.empty } : {}) }
  server.use(http.post(`/api/workspaces/${workspaceId}/agent-chat/messages`, async ({ request: incoming }) => {
    expect(await incoming.json()).toEqual({ ...request, attachments: [] })
    return HttpResponse.json(response)
  }))
  await expect(agentChatApi.send(workspaceId, request)).resolves.toEqual(response)
})
