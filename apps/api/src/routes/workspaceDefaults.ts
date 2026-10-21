import type { FastifyInstance } from 'fastify'
import { ManagedWorkspaceDefaultsSchema, WorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema, WorkspaceDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { requirePrincipal } from '../modules/access/http.js'
import type { OperatorServices } from '../mcp/operator/types.js'

export function registerWorkspaceDefaultsRoutes(app: FastifyInstance, services: OperatorServices): void {
  const settings = services.settings
  if (!settings) return
  app.get('/api/management/settings/workspaces', async (request) =>
    ManagedWorkspaceDefaultsSchema.parse(await settings.getWorkspaceDefaults(requirePrincipal(request))))
  app.get('/api/management/settings/workspaces/creation', async (request) =>
    WorkspaceDefaultsSchema.parse(await settings.getWorkspaceCreationDefaults(requirePrincipal(request))))
  app.put<{ Body: unknown }>('/api/management/settings/workspaces', async (request) =>
    WorkspaceDefaultsUpdateResultSchema.parse(await settings.updateWorkspaceDefaults(requirePrincipal(request), 'http', WorkspaceDefaultsUpdateInputSchema.parse(request.body))))
}
