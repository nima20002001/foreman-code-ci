import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WORKFLOW_EXECUTION_CHAT_ROUTE, WorkflowExecutionChatTargetSchema,
  type WorkflowExecutionChatChange } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkflowExecutionChatService } from '../modules/collaboration/workflowChatService.js'
import { createSseWriter } from './sseWriter.js'

const querySchema = z.object({ target: z.string().transform((value, context) => {
  try { return JSON.parse(value) as unknown }
  catch {
    context.addIssue({ code: 'custom', message: 'Provide the exact chat target as JSON.' })
    return z.NEVER
  }
}).pipe(WorkflowExecutionChatTargetSchema) }).strict()

export function registerWorkflowExecutionChatEvents(app: FastifyInstance, service: WorkflowExecutionChatService) {
  const streams = new Map<() => void, string>()
  app.addHook('preClose', async () => { for (const close of streams.keys()) close() })
  app.get<{ Params: { workspaceId: string; workflowId: string }; Querystring: unknown }>(
    `${WORKFLOW_EXECUTION_CHAT_ROUTE}/events`, async (request, reply) => {
      const { target } = querySchema.parse(request.query)
      if (target.agent.workspaceId !== request.params.workspaceId || target.agent.workflowId !== request.params.workflowId) {
        throw new DomainError('RESOURCE_ID_MISMATCH', 'The chat target must match its workflow URL.', 400)
      }
      let principal = requirePrincipal(request)
      if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
      if (streams.size >= 64 || [...streams.values()].filter(id => id === principal.id).length >= 8) {
        throw new DomainError('STREAM_LIMIT', 'Close an inactive chat stream and try again.', 429)
      }
      let closed = false
      let ready = false
      let dirty = false
      let flushing = false
      let checking = false
      let sequence = 0
      let snapshot: Awaited<ReturnType<WorkflowExecutionChatService['changes']>> | undefined
      const timers: { flush?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout } = {}
      const close = () => {
        if (closed) return
        closed = true
        clearTimeout(timers.flush)
        clearInterval(timers.heartbeat)
        watch.close()
        streams.delete(close)
        writer.close()
        if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end()
      }
      const writer = createSseWriter(reply.raw, () => !closed && Date.parse(principal.expiresAt) > Date.now(), close)
      const publish = (change: WorkflowExecutionChatChange) => {
        const event = { ...change, sequence: sequence++ }
        writer.write(`id: ${event.cursor}\nevent: changed\ndata: ${JSON.stringify(event)}\n\n`)
      }
      const fail = (error: unknown) => {
        app.log.warn({ err: error }, 'Execution chat stream stopped')
        if (!closed && ready && error instanceof DomainError && [401, 403, 404].includes(error.status)) {
          writer.write('event: unavailable\ndata: {}\n\n')
        }
        close()
      }
      const changed = () => {
        dirty = true
        if (closed || !ready || flushing || timers.flush) return
        timers.flush = setTimeout(() => { delete timers.flush; void flush() }, 25)
      }
      const flush = async () => {
        if (closed || flushing || !snapshot) return
        flushing = true
        dirty = false
        try {
          principal = await request.reauthorizeOperator!()
          const next = await service.changes(principal, target, snapshot.nativeRevision)
          if (closed) return
          const gap = next.messages?.hasMore || BigInt(next.nativeRevision) < BigInt(snapshot.nativeRevision)
          if (gap || next.stateCursor !== snapshot.stateCursor) publish(next.change)
          else for (const message of next.messages?.messages ?? []) {
            const event = { target, message, revision: next.change.revision,
              cursor: `${next.change.cursor}:${sequence}` }
            if (Buffer.byteLength(JSON.stringify(event)) > 60 * 1024) { publish(next.change); break }
            publish(event)
          }
          snapshot = next
        } catch (error) { fail(error) }
        finally { flushing = false; if (dirty) changed() }
      }
      const watch = service.subscribe(target, changed, fail)
      streams.set(close, principal.id)
      reply.raw.once('close', close)
      reply.raw.once('error', close)
      try {
        await watch.ready
        snapshot = await service.changes(principal, target)
        if (closed) throw new DomainError('CHAT_STREAM_UNAVAILABLE', 'Reconnect to the execution chat.', 503)
        reply.hijack()
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive', 'x-accel-buffering': 'no' })
        ready = true
        publish(snapshot.change)
        if (dirty) changed()
        timers.heartbeat = setInterval(() => {
          if (closed || checking) return
          checking = true
          void (async () => {
            principal = await request.reauthorizeOperator!()
            await service.assertReadable(principal, target)
            if (!closed) writer.write(': heartbeat\n\n')
          })().catch(fail).finally(() => { checking = false })
        }, 2000)
        timers.heartbeat.unref()
      } catch (error) {
        close()
        throw error
      }
    })
}
