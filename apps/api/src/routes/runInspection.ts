import { registerRunHistoryRoutes } from './runHistory.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { OperatorServices } from '../mcp/operator/types.js'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'

type Request = { Params: Record<string, string>; Querystring: Record<string, unknown> }
function input(params: Request['Params'], query: Request['Querystring']) {
  if (Object.keys(params).some((key) => Object.hasOwn(query, key))) throw new DomainError(
    'RESOURCE_ID_MISMATCH', 'Inspection scope identifiers must be supplied in the URL, not query parameters.', 400)
  return { ...query, ...params, ...(query.limit === undefined ? {} : {
    limit: typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : query.limit,
  }) }
}
function privateRead(reply: FastifyReply) {
  reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
}
/** Registered below the existing authenticated management HTTP hook. Parsing,
 * authorization, bounds, exact readback and output validation all live in the
 * same service called by Operator MCP. Existing global denial audit is retained. */
export function registerRunInspectionRoutes(app: FastifyInstance, services: OperatorServices): void {
  registerRunHistoryRoutes(app, services)
  const reads = () => {
    if (!services.runs?.inspection) throw new DomainError('RUN_INSPECTION_UNAVAILABLE',
      'Run inspection services are not composed in this application.', 503)
    return services.runs.inspection
  }
  const base = '/api/management/workspaces/:workspaceId/runs/:runId'
  app.get<Request>(`${base}/record`, async (request, reply) => {
    privateRead(reply)
    const principal = requirePrincipal(request)
    return reads().record(principal, input(request.params, request.query))
  })
  app.get<Request>(`${base}/executions`, async (request, reply) => {
    privateRead(reply)
    const principal = requirePrincipal(request)
    return reads().executions(principal, input(request.params, request.query))
  })
  app.get<Request>(`${base}/executions/:executionId`, async (request, reply) => {
    privateRead(reply)
    const principal = requirePrincipal(request)
    return reads().executionDetail(principal, input(request.params, request.query))
  })
  app.get<Request>(`${base}/executions/:executionId/bindings`, async (request, reply) => {
    privateRead(reply)
    const principal = requirePrincipal(request)
    return reads().bindings(principal, input(request.params, request.query))
  })
  app.get<Request>(`${base}/version`, async (request, reply) => {
    privateRead(reply)
    const principal = requirePrincipal(request)
    return reads().version(principal, input(request.params, request.query))
  })
}
