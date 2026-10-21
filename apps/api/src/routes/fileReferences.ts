import type { FastifyInstance } from 'fastify'
import type { PermanentFileScope } from '@foreman-code/contracts/files'

import { registerFileScopeRoutes, type FileRouteParams, type FileScopeRoute } from './files.js'
import { requirePrincipal } from '../modules/access/http.js'
import { FileReferenceRemoveBodySchema } from '@foreman-code/contracts/files'
import type { FileReferenceService } from '../modules/files/references/service.js'

export function registerFileReferenceRoutes(app: FastifyInstance, service: FileReferenceService): void {
  const routes: FileScopeRoute<PermanentFileScope>[] = [
    { root: '/api/workspaces/:workspaceId/reference-files',
      target: (params) => ({ kind: 'workspace_reference', workspaceId: params.workspaceId! }) },
    { root: '/api/workspaces/:workspaceId/workflows/:workflowId/reference-files',
      target: (params) => ({ kind: 'workflow_reference', workspaceId: params.workspaceId!, workflowId: params.workflowId! }) },
  ]
  registerFileScopeRoutes(app, service, routes)
  for (const { root, target } of routes) {
    app.delete<{ Params: FileRouteParams; Body: unknown }>(`${root}/:fileId/revisions/:revisionId`, async (request) => {
      const input = FileReferenceRemoveBodySchema.parse(request.body)
      return service.remove(requirePrincipal(request), target(request.params), { ...input,
        fileId: request.params.fileId, revisionId: request.params.revisionId }, 'http')
    })
  }
}
