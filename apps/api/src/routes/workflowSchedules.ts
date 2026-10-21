import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ScheduleDisableInputSchema, ScheduleSaveInputSchema } from '@foreman-code/contracts/schedules'
import { requirePrincipal } from '../modules/access/http.js'
import type { WorkflowScheduleService } from '../modules/schedules/service.js'
import { ScheduleOccurrenceListInputSchema } from '../modules/schedules/transportSchemas.js'

interface Scope { workspaceId: string; workflowId: string }
const SaveBody = ScheduleSaveInputSchema.omit({ workspaceId: true, workflowId: true })
const CommandBody = ScheduleDisableInputSchema.omit({ workspaceId: true, workflowId: true })
const PageQuery = ScheduleOccurrenceListInputSchema.omit({ workspaceId: true, workflowId: true }).extend({
  // Only HTTP query strings coerce; JSON/MCP inputs remain the frozen strict numeric types.
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

export function registerWorkflowScheduleRoutes(app: FastifyInstance, service: WorkflowScheduleService): void {
  // The management namespace delegates full scoped authorization to the shared service.
  const root = '/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule'
  app.get<{ Params: Scope }>(root, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.get(requirePrincipal(request), request.params)
  })
  app.put<{ Params: Scope; Body: unknown }>(root, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.save(requirePrincipal(request), 'http', { ...SaveBody.parse(request.body), ...request.params })
  })
  app.post<{ Params: Scope; Body: unknown }>(`${root}/enable`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.enable(requirePrincipal(request), 'http', { ...CommandBody.parse(request.body), ...request.params })
  })
  app.post<{ Params: Scope; Body: unknown }>(`${root}/disable`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.disable(requirePrincipal(request), 'http', { ...CommandBody.parse(request.body), ...request.params })
  })
  app.post<{ Params: Scope; Body: unknown }>(`${root}/clear`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.clear(requirePrincipal(request), 'http', { ...CommandBody.parse(request.body), ...request.params })
  })
  app.get<{ Params: Scope; Querystring: unknown }>(`${root}/occurrences`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.recentOccurrences(requirePrincipal(request), { ...PageQuery.parse(request.query), ...request.params })
  })
}
