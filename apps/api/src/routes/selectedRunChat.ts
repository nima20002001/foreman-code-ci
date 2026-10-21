import type { FastifyInstance } from 'fastify'
import { AGENT_CHAT_MESSAGE_BODY_LIMIT_BYTES, AgentChatStateResponseSchema, AgentChatSendResponseSchema } from '@foreman-code/contracts/agent-chat'
import {
  ReadSelectedRunChatResponseSchema, SelectedRunChatSelectionSchema, SelectedRunChatTargetSchema,
  SendSelectedRunChatRequestSchema, InterruptSelectedRunChatRequestSchema,
} from '@foreman-code/contracts/selected-run-chat'
import { requirePrincipal } from '../modules/access/http.js'
import type { AgentChatService } from '../modules/conversations/agentChat.js'

/** Remains under the existing chat authentication boundary, not the generic Run-start routes. */
export function registerSelectedRunChatRoutes(app: FastifyInstance, chat: AgentChatService): void {
  const root = '/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId'
  const querySchema = SelectedRunChatSelectionSchema.pick({ executionId: true })
  const messageSchema = SendSelectedRunChatRequestSchema.shape.message.extend({
    executionId: SendSelectedRunChatRequestSchema.shape.selection.shape.executionId,
  })
  const interruptSchema = InterruptSelectedRunChatRequestSchema.shape.request.extend({
    executionId: InterruptSelectedRunChatRequestSchema.shape.key.unwrap().shape.executionId,
    conversationId: InterruptSelectedRunChatRequestSchema.shape.key.unwrap().shape.conversationId,
    agentId: InterruptSelectedRunChatRequestSchema.shape.key.unwrap().shape.agentId,
  })
  app.get<{ Params: unknown; Querystring: unknown }>(root, async (request, reply) => {
    const target = SelectedRunChatTargetSchema.parse(request.params)
    // Repeated scope ids/Agent ids in a query are rejected, never allowed to override the URL.
    const query = querySchema.parse(request.query)
    reply.header('cache-control', 'private, no-store').header('vary', 'Authorization')
    return ReadSelectedRunChatResponseSchema.parse(await chat.readSelectedRun(requirePrincipal(request), {
      selection: { ...target, ...query },
    }))
  })
  app.post<{ Params: unknown; Body: unknown }>(`${root}/messages`, { bodyLimit: AGENT_CHAT_MESSAGE_BODY_LIMIT_BYTES }, async (request, reply) => {
    const target = SelectedRunChatTargetSchema.parse(request.params)
    const { executionId, ...message } = messageSchema.parse(request.body)
    const result = await chat.sendSelectedRunCommand(requirePrincipal(request), { selection: { ...target, executionId }, message })
    reply.code(result.replayed ? 200 : 202)
    return AgentChatSendResponseSchema.parse(result)
  })
  app.post<{ Params: unknown; Body: unknown }>(`${root}/interrupt`, async (request) => {
    const target = SelectedRunChatTargetSchema.parse(request.params)
    const { executionId, conversationId, agentId, ...command } = interruptSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.interruptSelectedRun(requirePrincipal(request), {
      key: { ...target, executionId, conversationId, agentId }, request: command,
    }) })
  })
}
