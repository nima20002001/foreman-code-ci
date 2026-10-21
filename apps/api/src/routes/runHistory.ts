import type { FastifyInstance } from 'fastify'
import type { OperatorServices } from '../mcp/operator/types.js'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'

type Request = { Params: Record<string, string>; Querystring: Record<string, unknown> }
function input(params: Request['Params'], query: Request['Querystring']) {
  if (Object.keys(params).some((key) => Object.hasOwn(query, key))) throw new DomainError(
    'RESOURCE_ID_MISMATCH', 'Run history scope must be supplied in the URL, not query parameters.', 400)
  return { ...query, ...params, ...(query.limit === undefined ? {} : {
    limit: typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : query.limit,
  }) }
}

/** Mounted beneath the existing authenticated management hook, not a second
 * authentication surface. MCP uses the exact same RunHistoryService instance. */
export function registerRunHistoryRoutes(app: FastifyInstance, services: OperatorServices): void {
  const reads = () => {
    if (!services.runs?.history) throw new DomainError('RUN_HISTORY_UNAVAILABLE',
      'Run history services are not composed in this application.', 503)
    return services.runs.history
  }
  const base = '/api/management/workspaces/:workspaceId/workflows/:workflowId/runs'
  app.get<Request>(`${base}/summaries`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    const principal = requirePrincipal(request)
    return reads().list(principal, input(request.params, request.query))
  })
  app.get<Request>(`${base}/:runId/snapshot`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    const principal = requirePrincipal(request)
    return reads().snapshot(principal, input(request.params, request.query))
  })
}
