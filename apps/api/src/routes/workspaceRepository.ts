import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkspaceRepositoryService } from '../modules/workspaces/repositoryService.js'

function scoped(workspaceId: string, raw: unknown) {
  if (raw === undefined) return { workspaceId }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('INVALID_REQUEST', 'Expected an object request.', 400)
  }
  const input = raw as Record<string, unknown>
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) {
    throw new DomainError('RESOURCE_ID_MISMATCH', 'The workspace must match the route.', 400)
  }
  return { ...input, workspaceId }
}

export function registerWorkspaceRepositoryRoutes(app: FastifyInstance, service: WorkspaceRepositoryService): void {
  type Request = { Params: { workspaceId: string }; Body: unknown; Querystring: Record<string, unknown> }
  const path = '/api/management/workspaces/:workspaceId/repository'
  app.get<Request>(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service.get(requirePrincipal(request), 'http', scoped(request.params.workspaceId, request.query))
  })
  app.post<Request>(path, request => service.add(requirePrincipal(request), 'http',
    scoped(request.params.workspaceId, request.body)))
}
