import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { PostgresSourceService } from '../modules/sources/service.js'

/** Authenticated management routes share the exact Operator domain service. */
export function registerSourceRoutes(app: FastifyInstance, service: PostgresSourceService): void {
  type Params = { workspaceId: string }
  const merge = (params: Params, body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('INVALID_REQUEST', 'Expected a source request object.', 400)
    const input = body as Record<string, unknown>
    if (input.workspaceId !== undefined && input.workspaceId !== params.workspaceId) throw new DomainError('RESOURCE_ID_MISMATCH', 'Workspace must match the URL.', 400)
    return { ...input, ...params }
  }
  app.get<{ Params: Params; Querystring: Record<string, string | undefined> }>('/api/management/workspaces/:workspaceId/sources', request =>
    service.list(requirePrincipal(request), 'http', { ...request.params, ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      ...(request.query.afterSnapshotId ? { afterSnapshotId: request.query.afterSnapshotId } : {}) }))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/sources/get', request =>
    service.get(requirePrincipal(request), 'http', merge(request.params, request.body)))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/sources/approve', request =>
    service.approve(requirePrincipal(request), 'http', merge(request.params, request.body)))
  app.get<{ Params: Params; Querystring: { limit?: string } }>('/api/management/workspaces/:workspaceId/source-roots', request =>
    service.rootList(requirePrincipal(request), 'http', { ...request.params,
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}) }))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/source-roots/get', request => service.rootGet(requirePrincipal(request), 'http', merge(request.params, request.body)))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/source-roots/bind', request => service.bindRoot(requirePrincipal(request), 'http', merge(request.params, request.body)))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/source-preparations/get', request => service.preparationGet(requirePrincipal(request), 'http', merge(request.params, request.body)))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/source-preparations/reconcile', request => service.preparationReconcile(requirePrincipal(request), 'http', merge(request.params, request.body)))
}
