import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { WorkflowChatPostRequestSchema } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkflowChatService } from '../modules/workflow-chat/service.js'
import type { WorkflowChatChange } from '../modules/workflow-chat/model.js'
import { createSseWriter } from './sseWriter.js'

interface Scope { workspaceId: string; workflowId: string }
const readQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  postId: z.string().min(1).optional(), receiptId: z.string().min(1).optional(), runId: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(), mode: z.literal('body').optional(), bodyCursor: z.string().optional() })

export function registerWorkflowChatRoutes(app: FastifyInstance, chat: WorkflowChatService): void {
  const root = '/api/workspaces/:workspaceId/workflows/:workflowId/chat'
  app.get<{ Params: Scope; Querystring: unknown }>(root, async request => {
    const input = readQuery.parse(request.query)
    if (input.mode === 'body' || input.bodyCursor !== undefined) {
      if (!input.postId) throw new DomainError('CHAT_POST_REQUIRED', 'An exact body read needs its post ID.', 422)
      return chat.body(requirePrincipal(request), request.params, input.postId, input.bodyCursor)
    }
    return chat.read(requirePrincipal(request), request.params, input)
  })
  app.post<{ Params: Scope; Body: unknown }>(`${root}/posts`, async (request, reply) => {
    const input = WorkflowChatPostRequestSchema.parse(request.body)
    if (input.workspaceId !== request.params.workspaceId || input.workflowId !== request.params.workflowId) {
      throw new DomainError('CHAT_SCOPE_MISMATCH', 'The post does not belong to the selected workflow.', 403)
    }
    const result = await chat.post(requirePrincipal(request), input)
    reply.code(result.replayed ? 200 : 201)
    return result
  })
  app.get<{ Params: Scope; Querystring: unknown }>(`${root}/deliveries`, request =>
    chat.receipts(requirePrincipal(request), request.params, readQuery.parse(request.query)))
  app.post<{ Params: Scope & { receiptId: string }; Body: unknown }>(`${root}/deliveries/:receiptId/cancel`, request => {
    const input = z.object({ commandId: z.string().min(1).optional() }).parse(request.body ?? {})
    return chat.cancel(requirePrincipal(request), request.params, request.params.receiptId, input.commandId)
  })
  registerEvents(app, root, chat)
}

function registerEvents(app: FastifyInstance, root: string, chat: WorkflowChatService): void {
  const streams = new Map<() => void, string>()
  app.addHook('preClose', async () => { for (const stop of streams.keys()) stop(); streams.clear() })
  app.get<{ Params: Scope }>(`${root}/events`, async (request, reply) => {
    let principal = requirePrincipal(request)
    if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
    if (streams.size >= 64 || [...streams.values()].filter(owner => owner === principal.id).length >= 8) {
      throw new DomainError('STREAM_LIMIT', 'Close an inactive chat stream and try again.', 429)
    }
    let stopped = false
    let bootstrapping = true
    let checking = false
    let bytes = 0
    let heartbeat: NodeJS.Timeout | undefined
    let unsubscribe = () => {}
    const queue: WorkflowChatChange[] = []
    const stop = () => {
      if (stopped) return
      stopped = true; unsubscribe(); writer.close(); clearInterval(heartbeat); streams.delete(stop)
      queue.length = 0
      reply.raw.removeListener('close', stop); reply.raw.removeListener('error', stop)
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end()
    }
    const writer = createSseWriter(reply.raw, () => !stopped && Date.parse(principal.expiresAt) > Date.now(), stop)
    const write = (event: WorkflowChatChange) => writer.write(`id: ${event.revision}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)
    unsubscribe = chat.events.subscribe(request.params.workflowId, event => {
      if (stopped) return
      if (!bootstrapping) { write(event); return }
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (queue.length >= 128 || bytes > 256 * 1024) { stop(); return }
      queue.push(event)
    })
    streams.set(stop, principal.id)
    reply.raw.once('close', stop); reply.raw.once('error', stop)
    try {
      const snapshot = await chat.read(principal, request.params)
      principal = await request.reauthorizeOperator()
      await chat.assertReadable(principal, request.params)
      if (stopped) throw new DomainError('STREAM_RECONNECT_REQUIRED', 'Reconnect for a fresh Group snapshot.', 503)
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' })
      // The client already owns its bounded query; bootstrap invalidates once, without replaying token history.
      write({ revision: snapshot.revision, snapshotRequired: true })
      bootstrapping = false
      for (const event of queue) if (event.revision > snapshot.revision) write(event)
      queue.length = 0
      heartbeat = setInterval(() => {
        if (checking || stopped) return
        checking = true
        void (async () => {
          principal = await request.reauthorizeOperator!()
          await chat.assertReadable(principal, request.params)
          writer.write(': heartbeat\n\n')
        })().catch(stop).finally(() => { checking = false })
      }, 5_000)
      heartbeat.unref()
    } catch (error) { stop(); throw error }
  })
}
