import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WORKFLOW_HIERARCHY_ROUTE, WorkflowHierarchyReadInputSchema,
  WorkflowHierarchyUpdateInputSchema, WorkflowReportsReadInputSchema, type WorkflowHierarchyChange } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkflowHierarchyService } from '../modules/workflow-hierarchy/service.js'
import { createSseWriter } from './sseWriter.js'

type Scope = { workspaceId: string; workflowId: string }
const ReportQuery = WorkflowReportsReadInputSchema.omit({ workspaceId: true, workflowId: true }).extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
function scoped(params: Scope, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('INVALID_INPUT', 'Provide a hierarchy update object.', 400)
  const value = body as Record<string, unknown>
  if (value.workspaceId !== undefined && value.workspaceId !== params.workspaceId
    || value.workflowId !== undefined && value.workflowId !== params.workflowId) {
    throw new DomainError('RESOURCE_ID_MISMATCH', 'The hierarchy update must match its URL scope.', 400)
  }
  return { ...value, ...params }
}
export function registerWorkflowHierarchyRoutes(app: FastifyInstance, service: WorkflowHierarchyService): void {
  app.get<{ Params: Scope; Querystring: unknown }>(WORKFLOW_HIERARCHY_ROUTE, request => {
    const query = z.object({ runId: WorkflowHierarchyReadInputSchema.shape.runId,
      workflowVersionId: WorkflowHierarchyReadInputSchema.shape.workflowVersionId }).strict().parse(request.query)
    return service.read(requirePrincipal(request), { ...request.params, ...query })
  })
  app.put<{ Params: Scope; Body: unknown }>(WORKFLOW_HIERARCHY_ROUTE, request =>
    service.update(requirePrincipal(request), 'http', WorkflowHierarchyUpdateInputSchema.parse(scoped(request.params, request.body))))
  app.get<{ Params: Scope; Querystring: unknown }>(`${WORKFLOW_HIERARCHY_ROUTE}/reports`, request =>
    service.reports(requirePrincipal(request), { ...request.params, ...ReportQuery.parse(request.query) }))
  app.get<{ Params: Scope; Querystring: unknown }>(`${WORKFLOW_HIERARCHY_ROUTE}/events`, async (request, reply) => {
    const query = z.object({ runId: z.string().min(1), after: z.coerce.number().int().nonnegative().optional() }).strict().parse(request.query)
    const principal = requirePrincipal(request), input = { ...request.params, runId: query.runId }
    const first = await service.changes(principal, input)
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    let closed = false, polling = false, cursor: string | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const close = () => { closed = true; if (timer) clearInterval(timer); writer.close(); reply.raw.end() }
    const writer = createSseWriter(reply.raw, () => !closed, close)
    const publish = (next: WorkflowHierarchyChange) => {
      if (next.cursor !== cursor) {
        cursor = next.cursor
        writer.write(`id: ${cursor}\nevent: changed\ndata: ${JSON.stringify(next)}\n\n`)
      } else writer.write(': current\n\n')
    }
    publish(first)
    const poll = async () => {
      if (closed || polling) return
      polling = true
      try { const next = await service.changes(principal, input); if (!closed) publish(next) }
      catch (error) {
        app.log.warn({ err: error, runId: query.runId }, 'Hierarchy report stream stopped')
        if (!closed) { writer.write('event: unavailable\ndata: {}\n\n'); close() }
      } finally { polling = false }
    }
    timer = setInterval(() => { void poll() }, 2000)
    timer.unref()
    reply.raw.once('close', () => { closed = true; if (timer) clearInterval(timer); writer.close() })
  })
}
