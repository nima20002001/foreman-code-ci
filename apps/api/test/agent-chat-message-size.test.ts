import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'

it.each((['regular', 'selected'] as const).flatMap(kind =>
  [120_000, 1_048_576].map(characters => ({ kind, characters }))))(
  'parses $characters escaped characters through the $kind HTTP chat route before service admission', async ({ kind, characters }) => {
  const app = Fastify()
  registerOperatorHttpSecurity(app, {
    authenticate: async () => localHumanPrincipal,
  } as unknown as PostgresAccessService)
  const received: string[] = []
  const sendCommand = vi.fn(async (_principal: unknown, _workspaceId: string, input: { content: string }) => {
    received.push(input.content)
    throw new Error('Message reached the service')
  })
  const sendSelectedRunCommand = vi.fn(async (_principal: unknown, input: { message: { content: string } }) => {
    received.push(input.message.content)
    throw new Error('Message reached the service')
  })
  registerAgentChatRoutes(app, { sendCommand, sendSelectedRunCommand } as unknown as AgentChatService)
  try {
    const content = '\u0001'.repeat(characters)
    const message = { requestId: 'large-log', content, expectedConversationId: null }
    const url = kind === 'regular' ? '/api/workspaces/workspace/agent-chat/messages'
      : '/api/workspaces/workspace/agent-chat/workflows/workflow/runs/run/nodes/node/messages'
    const payload = kind === 'regular' ? { ...message,
      context: { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' } }
      : { ...message, executionId: 'execution' }
    const response = await app.inject({ method: 'POST', url,
      headers: { authorization: 'Bearer fixture-token' }, payload })
    expect(response.json().message).toBe('Message reached the service')
    expect(received).toEqual([content])
  } finally { await app.close() }
})
