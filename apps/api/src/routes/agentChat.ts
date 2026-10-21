import { z } from 'zod'
import { ChatControlReceiptSchema, parseSessionCommand, SessionControlRequestSchema, SessionControlStateSchema } from '@foreman-code/contracts'
import type { FastifyInstance } from 'fastify'

import {
  AGENT_CHAT_MESSAGE_BODY_LIMIT_BYTES, AgentChatExecutionActivityPageSchema, AgentChatExecutionActivityQuerySchema, AgentChatHistoryPageSchema, AgentChatTurnPageSchema, AgentChatReadbackQuerySchema, AgentChatQuerySchema, AgentChatStateResponseSchema, AgentChatStateSchema, CancelQueuedAgentChatTurnRequestSchema,
  EnsureAgentChatConversationRequestSchema, InterruptAgentChatRequestSchema, RespondAgentChatInteractionRequestSchema, AgentChatMessageCommandSchema,
  AgentChatSendResponseSchema, ReadAgentChatRequestSchema, ReadAgentChatResponseSchema, type AgentChatStreamEvent,
} from '@foreman-code/contracts/agent-chat'

import { requirePrincipal } from '../modules/access/http.js'
import type { AgentChatService } from '../modules/conversations/agentChat.js'
import { DomainError } from '../modules/errors.js'
import { agentChatStreamFrame } from '../modules/conversations/agentChatStream.js'
import { createSseWriter } from './sseWriter.js'
import { registerSelectedRunChatRoutes } from './selectedRunChat.js'
import { registerAgentDeliveryRoutes } from '../modules/workflow-chat/httpDelivery.js'

interface WorkspaceParams { workspaceId: string }
interface ConversationParams extends WorkspaceParams { conversationId: string }
interface TurnParams extends ConversationParams { turnRequestId: string }
const MAX_STREAMS = 64
const MAX_OWNER_STREAMS = 16
const MAX_BOOTSTRAP_EVENTS = 128
const MAX_BOOTSTRAP_BYTES = 256 * 1024
const inputReadQuery = z.object({ deliveryInputCursor: z.string().optional(),
  deliveryInputLimit: z.coerce.number().int().min(1).max(100).optional(), deliveryInputReceiptId: z.string().min(1).optional(),
  deliveryInputBodyCursor: z.string().optional() })
const readQuery = AgentChatQuerySchema.extend(inputReadQuery.shape)
const controlResponse = AgentChatStateResponseSchema.extend({ receipt: ChatControlReceiptSchema.optional() })

export function registerAgentChatRoutes(app: FastifyInstance, chat: AgentChatService): void {
  const root = '/api/workspaces/:workspaceId/agent-chat'
  if (chat.deliveryBridge) registerAgentDeliveryRoutes(app, chat.deliveryBridge.router)
  registerSelectedRunChatRoutes(app, chat)
  app.get<{ Params: WorkspaceParams; Querystring: unknown }>(`${root}/session-controls`, request => {
    const { executionId, ...query } = AgentChatQuerySchema.extend({ executionId: z.string().min(1).optional() }).parse(request.query)
    const context = { workspaceId: request.params.workspaceId, ...query }
    return chat.readContextControls(requirePrincipal(request), context, executionId)
  })
  app.post<{ Params: WorkspaceParams; Body: unknown }>(`${root}/session-controls`, request => {
    const body = z.object({ context: AgentChatQuerySchema, request: SessionControlRequestSchema, executionId: z.string().min(1).optional() }).strict().parse(request.body)
    return chat.changeContextControls(requirePrincipal(request), { workspaceId: request.params.workspaceId, ...body.context }, body.request, 'http', body.executionId)
  })
  app.get<{ Params: ConversationParams }>('/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/session-controls', async request =>
    SessionControlStateSchema.parse(await chat.readSessionControls(requirePrincipal(request), request.params.workspaceId, request.params.conversationId)))
  app.post<{ Params: ConversationParams; Body: unknown }>('/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/session-controls', async request =>
    SessionControlStateSchema.parse(await chat.changeSessionControls(requirePrincipal(request), request.params.workspaceId, request.params.conversationId, SessionControlRequestSchema.parse(request.body))))
  const streams = new Map<() => void, string>()
  let closing = false
  app.addHook('preClose', async () => {
    closing = true
    for (const stop of streams.keys()) stop()
    streams.clear()
  })

  app.get<{ Params: WorkspaceParams; Querystring: unknown }>(root, async request => {
    const { deliveryInputCursor: cursor, deliveryInputLimit: limit, deliveryInputReceiptId: receiptId,
      deliveryInputBodyCursor: bodyCursor, ...query } = readQuery.parse(request.query)
    const principal = requirePrincipal(request), workspaceId = request.params.workspaceId
    const state = await chat.read(principal, workspaceId, query)
    if (cursor === undefined && limit === undefined && receiptId === undefined && bodyCursor === undefined) return ReadAgentChatResponseSchema.parse(state)
    if (!chat.deliveryBridge) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Retained delivery input is unavailable.', 503)
    const inputs = ReadAgentChatRequestSchema.shape.deliveryInputs.unwrap().parse({ cursor, limit, receiptId, bodyCursor })
    return ReadAgentChatResponseSchema.parse({ ...state,
      deliveryInputs: await chat.deliveryBridge.readAgentInputs(principal, workspaceId, { query, target: state.deliveryTarget }, inputs) })
  })
  app.get<{ Params: WorkspaceParams; Querystring: unknown }>(`${root}/execution-activity`, async (request) => {
    const { cursor, executionId, before, itemId, limit, ...query } = AgentChatExecutionActivityQuerySchema.parse(request.query)
    return AgentChatExecutionActivityPageSchema.parse(await chat.executionActivity(requirePrincipal(request), request.params.workspaceId,
      query, { cursor, executionId, before, itemId, limit }))
  })
  app.post<{ Params: WorkspaceParams; Body: unknown }>(`${root}/messages`, { bodyLimit: AGENT_CHAT_MESSAGE_BODY_LIMIT_BYTES }, async (request, reply) => {
    const principal = requirePrincipal(request), input = AgentChatMessageCommandSchema.parse(request.body)
    const explicit = Object.hasOwn(Object(request.body), 'intent')
    if (input.intent === 'auto' && !chat.deliveryBridge) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Automatic delivery is unavailable.', 503)
    const result = chat.deliveryBridge && explicit && parseSessionCommand(input.content).kind !== 'new'
      ? await chat.deliveryBridge.sendAgent(principal, request.params.workspaceId, input)
      : await chat.sendCommand(principal, request.params.workspaceId, input)
    reply.code(result.replayed ? 200 : 202)
    return AgentChatSendResponseSchema.parse(result)
  })
  app.get<{ Params: ConversationParams; Querystring: unknown }>(`${root}/conversations/:conversationId`, async request => {
    const { deliveryInputCursor: cursor, deliveryInputLimit: limit, deliveryInputReceiptId: receiptId,
      deliveryInputBodyCursor: bodyCursor } = inputReadQuery.parse(request.query)
    const principal = requirePrincipal(request), { workspaceId, conversationId } = request.params
    const state = await chat.readConversation(principal, workspaceId, conversationId)
    if (cursor === undefined && limit === undefined && receiptId === undefined && bodyCursor === undefined) return AgentChatStateSchema.parse(state)
    if (!chat.deliveryBridge) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Retained delivery input is unavailable.', 503)
    const inputs = ReadAgentChatRequestSchema.shape.deliveryInputs.unwrap().parse({ cursor, limit, receiptId, bodyCursor })
    return ReadAgentChatResponseSchema.parse({ ...state, deliveryTargetState: 'existing',
      deliveryTarget: { kind: 'agent_conversation', conversationId, agent: { workspaceId,
        workflowId: state.context.workflowId, workflowNodeId: state.context.workflowNodeId, agentId: state.context.agentId } },
      deliveryInputs: await chat.deliveryBridge.readAgentInputs(principal, workspaceId, { conversationId }, inputs) })
  })
  app.post<{ Params: WorkspaceParams; Body: unknown }>(`${root}/conversation`, async (request) => {
    const { context, executionId } = EnsureAgentChatConversationRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.ensureConversation(requirePrincipal(request),
      { workspaceId: request.params.workspaceId, ...context }, executionId) })
  })
  app.post<{ Params: ConversationParams; Body: unknown }>(`${root}/conversations/:conversationId/interrupt`, async (request) => {
    const input = InterruptAgentChatRequestSchema.parse(request.body)
    const principal = requirePrincipal(request)
    return controlResponse.parse(input.scope && chat.deliveryBridge
      ? await chat.deliveryBridge.stopAgent(principal, request.params.workspaceId, request.params.conversationId, { ...input, scope: input.scope })
      : { state: await chat.interrupt(principal, request.params.workspaceId, request.params.conversationId, input) })
  })
  app.post<{ Params: TurnParams; Body: unknown }>(`${root}/conversations/:conversationId/turns/:turnRequestId/cancel`, async (request) => {
    const input = CancelQueuedAgentChatTurnRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.cancelQueued(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, request.params.turnRequestId, input) })
  })
  app.post<{ Params: ConversationParams; Body: unknown }>(`${root}/conversations/:conversationId/responses`, async (request) => {
    const input = RespondAgentChatInteractionRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.respond(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, input) })
  })
  app.get<{ Params: ConversationParams; Querystring: unknown }>(`${root}/conversations/:conversationId/history`, async (request) => {
    const query = AgentChatReadbackQuerySchema.parse(request.query)
    return AgentChatHistoryPageSchema.parse(await chat.history(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, query.before, query.limit))
  })

  app.get<{ Params: ConversationParams; Querystring: unknown }>(`${root}/conversations/:conversationId/turns`, async (request) => {
    const query = AgentChatReadbackQuerySchema.parse(request.query)
    return AgentChatTurnPageSchema.parse(await chat.receipts(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, query.before, query.limit))
  })

  app.get<{ Params: ConversationParams }>(`${root}/conversations/:conversationId/events`, async (request, reply) => {
    if (closing) throw new DomainError('STREAM_CLOSING', 'Chat streams are closing.', 503)
    let principal = requirePrincipal(request)
    if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
    if (streams.size >= MAX_STREAMS || [...streams.values()].filter((owner) => owner === principal.id).length >= MAX_OWNER_STREAMS) {
      throw new DomainError('STREAM_LIMIT', 'Too many open chat streams. Close an inactive tab and retry.', 429)
    }
    const { workspaceId, conversationId: id } = request.params
    let stopped = false
    let bootstrapping = true
    let heartbeat: NodeJS.Timeout | undefined
    let checking = false
    let queuedBytes = 0
    let unsubscribe = () => {}
    const queued: string[] = []
    const stop = () => {
      if (stopped) return
      stopped = true; writer.close(); clearInterval(heartbeat); unsubscribe(); streams.delete(stop)
      queued.length = 0; queuedBytes = 0
      reply.raw.removeListener('close', stop); reply.raw.removeListener('error', stop)
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end()
    }
    const writer = createSseWriter(reply.raw, () => !stopped && Date.parse(principal.expiresAt) > Date.now(), stop)
    const event = (value: AgentChatStreamEvent) => {
      if (stopped) return
      const frame = agentChatStreamFrame(value)
      if (!bootstrapping) { writer.write(frame); return }
      const bytes = Buffer.byteLength(frame)
      if (queued.length >= MAX_BOOTSTRAP_EVENTS || queuedBytes + bytes > MAX_BOOTSTRAP_BYTES) { stop(); return }
      queued.push(frame); queuedBytes += bytes
    }
    // Subscribe before the snapshot so nothing between the read and the stream is lost.
    unsubscribe = chat.events.subscribe(id, event)
    if (stopped) { unsubscribe(); return }
    streams.set(stop, principal.id)
    reply.raw.once('close', stop); reply.raw.once('error', stop)
    try {
      const snapshot = await chat.readConversation(principal, workspaceId, id)
      principal = await request.reauthorizeOperator()
      await chat.assertReadable(principal, workspaceId, id)
      if (stopped) throw new DomainError('STREAM_RECONNECT_REQUIRED', 'Stream initialization overflowed or disconnected. Reconnect for a fresh snapshot.', 503)
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' })
      // Bootstrap from a snapshot, or an explicit HTTP readback invalidation if
      // the frame would be too large. Never truncate a result or replay deltas.
      writer.write(agentChatStreamFrame({ id: 0, conversationId: id, type: 'snapshot', data: snapshot }))
      bootstrapping = false
      for (const queuedFrame of queued) { if (stopped) break; writer.write(queuedFrame) }
      queued.length = 0; queuedBytes = 0
      if (stopped) return
      heartbeat = setInterval(() => {
        if (checking || stopped) return
        checking = true
        void (async () => {
          principal = await request.reauthorizeOperator!()
          await chat.assertReadable(principal, workspaceId, id)
          writer.write(': heartbeat\n\n')
        })().catch(stop).finally(() => { checking = false })
      }, 5_000)
      heartbeat.unref()
    } catch (error) { stop(); throw error }
  })
}
