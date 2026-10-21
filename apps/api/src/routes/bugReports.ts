import {
  BugReportCloseInputSchema,
  BugReportCreateInputSchema,
  BugReportListInputSchema,
  BugReportUpdateInputSchema,
} from '@foreman-code/contracts/management'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { BugReportService } from '../modules/bug-reports/service.js'

export function registerBugReportRoutes(app: FastifyInstance, service: BugReportService): void {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/management/bug-reports', request => {
    const query = request.query
    return service.list(requirePrincipal(request), BugReportListInputSchema.parse({
      ...query,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    }))
  })
  app.post<{ Body: unknown }>('/api/management/bug-reports', async (request, reply) => {
    const result = await service.report(requirePrincipal(request), 'http', BugReportCreateInputSchema.parse(request.body))
    if (!result.replayed && !result.deduplicated) reply.code(201)
    return result
  })
  app.post<{ Body: unknown }>('/api/management/bug-reports/close', request =>
    service.close(requirePrincipal(request), 'http', BugReportCloseInputSchema.parse(request.body)))
  app.get<{ Params: { reportId: string } }>('/api/management/bug-reports/:reportId', request =>
    service.get(requirePrincipal(request), request.params.reportId))
  app.post<{ Params: { reportId: string }; Body: unknown }>(
    '/api/management/bug-reports/:reportId/status', request => {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new DomainError('INVALID_INPUT', 'The request body must be an object.', 400)
      }
      const input = body as Record<string, unknown>
      if (input.reportId !== undefined && input.reportId !== request.params.reportId) {
        throw new DomainError('RESOURCE_ID_MISMATCH', 'The report ID must match the URL.', 400)
      }
      return service.update(requirePrincipal(request), 'http', BugReportUpdateInputSchema.parse({
        ...input,
        reportId: request.params.reportId,
      }))
    },
  )
}
