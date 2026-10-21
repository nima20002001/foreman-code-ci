import { CiComputersOutputSchema, CiCancelOutputSchema, CiGetOutputSchema, CiListOutputSchema, CiLogsInputSchema, CiLogsOutputSchema, CiRunInputSchema, CiRunOutputSchema,
  CiTestStatusFilterSchema, CiTestsOutputSchema, OperatorCiListInputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import type { HostCiService } from '../modules/ci-host/service.js'
import { DomainError } from '../modules/errors.js'

export function registerHostCiRoutes(app: FastifyInstance, services: { ci?: HostCiService }): void {
  // Production initializes CI after registering the management routes.
  const ci = () => {
    if (!services.ci) throw new DomainError('CI_UNAVAILABLE', 'CI is not initialized yet.', 503)
    return services.ci
  }
  const root = '/api/management/workspaces/:workspaceId/ci'
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(root, async request =>
    CiRunOutputSchema.parse(await ci().run(requirePrincipal(request), {
      ...CiRunInputSchema.parse(request.body), workspaceId: request.params.workspaceId,
    }, 'http')))
  app.get<{ Params: { workspaceId: string } }>(`${root}/computers`, async request =>
    CiComputersOutputSchema.parse(await ci().computers(requirePrincipal(request), request.params)))
  app.delete<{ Params: { workspaceId: string; ticketId: string } }>(`${root}/:ticketId`, async request =>
    CiCancelOutputSchema.parse(await ci().cancel(requirePrincipal(request), request.params, 'http')))
  // The CI tickets of one Run, for the Board's CI component (the Operator uses ci_list).
  const listQuery = OperatorCiListInputSchema.pick({ runId: true, executionId: true }).strict()
  app.get<{ Params: { workspaceId: string }; Querystring: unknown }>(root, async request =>
    CiListOutputSchema.parse(await ci().list(requirePrincipal(request), {
      workspaceId: request.params.workspaceId, ...listQuery.parse(request.query),
    })))
  // ?status=failed,skipped limits the tests (the Operator uses ci_get testStatus).
  const testsQuery = z.object({ status: z.string().max(40).transform(value => value.split(',').filter(Boolean))
    .pipe(CiTestStatusFilterSchema).optional() }).strict()
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId/tests`, async request =>
    CiTestsOutputSchema.parse(await ci().tests(requirePrincipal(request), {
      ...request.params, ...testsQuery.parse(request.query),
    })))
  app.get<{ Params: { workspaceId: string; ticketId: string } }>(`${root}/:ticketId`, async request =>
    CiGetOutputSchema.parse(await ci().get(requirePrincipal(request), request.params)))
  const logsQuery = CiLogsInputSchema.omit({ ticketId: true }).extend({
    afterOffset: z.coerce.number().int().nonnegative().optional(),
    maxBytes: z.coerce.number().pipe(CiLogsInputSchema.shape.maxBytes.unwrap()).optional(),
    group: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  })
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId/logs`, async request =>
    CiLogsOutputSchema.parse(await ci().logs(requirePrincipal(request), {
      ...request.params, ...logsQuery.parse(request.query),
    })))
}
