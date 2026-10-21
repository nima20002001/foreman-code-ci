import type { FastifyInstance } from 'fastify'
import type { ComputerSyncService } from '../modules/computers/sync.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerSyncRoutes(app: FastifyInstance, service: ComputerSyncService): void {
  app.post('/api/management/computers/sync/status', request => service.read(requirePrincipal(request), 'http', request.body))
  app.post('/api/management/computers/sync/update', request => service.update(requirePrincipal(request), 'http', request.body))
}
