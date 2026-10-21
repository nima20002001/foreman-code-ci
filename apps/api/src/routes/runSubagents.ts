import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorServices } from '../mcp/operator/types.js'

type Read = { Params: Record<string, string>; Querystring: Record<string, unknown> }
type Command = { Params: Record<string, string>; Body: unknown }
function scopedInput(params: Record<string, string>, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('INVALID_INPUT', 'Expected an object input.', 400)
  const fields = raw as Record<string, unknown>
  for (const [key, value] of Object.entries(params)) if (Object.hasOwn(fields, key) && fields[key] !== value) {
    throw new DomainError('RESOURCE_ID_MISMATCH', 'Child scope must match the URL.', 400)
  }
  return { ...fields, ...params, ...(fields.limit === undefined ? {} : { limit: typeof fields.limit === 'string' && /^\d+$/.test(fields.limit) ? Number(fields.limit) : fields.limit }) }
}
export function registerRunSubagentRoutes(app: FastifyInstance, services: OperatorServices) {
  const service = () => {
    if (!services.runs?.subagents) throw new DomainError('SUBAGENT_SERVICES_UNAVAILABLE', 'Child services are not composed.', 503)
    return services.runs.subagents
  }
  const base = '/api/management/workspaces/:workspaceId/runs/:runId/subagents'
  app.get<Read>(base, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service().list(requirePrincipal(request), scopedInput(request.params, request.query))
  })
  app.get<Read>(`${base}/:subagentId`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service().get(requirePrincipal(request), scopedInput(request.params, request.query))
  })
  app.get<Read>(`${base}/:subagentId/messages`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service().messages(requirePrincipal(request), scopedInput(request.params, request.query))
  })
  app.get<Read>(`${base}/:subagentId/tools`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service().tools(requirePrincipal(request), scopedInput(request.params, request.query))
  })
  app.post<Command>(`${base}/:subagentId/input`, async request => service().input(requirePrincipal(request), 'http', scopedInput(request.params, request.body)))
  app.post<Command>(`${base}/:subagentId/interrupt`, async request => service().interrupt(requirePrincipal(request), 'http', scopedInput(request.params, request.body)))
  app.post<Command>(`${base}/:subagentId/responses`, async request =>
    service().respond(requirePrincipal(request), 'http', scopedInput(request.params, request.body)))
}
