import type { FastifyInstance } from 'fastify'
import type { ComputerActivityService } from '../modules/computers/activity.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerActivityRoutes(app: FastifyInstance, service: ComputerActivityService): void {
  app.get('/api/management/computers/activity', request => service.list(requirePrincipal(request)))
  app.post('/api/management/computers/rename', request => service.rename(requirePrincipal(request), 'http', request.body))
}
