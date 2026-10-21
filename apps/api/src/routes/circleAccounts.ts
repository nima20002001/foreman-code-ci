import type { FastifyInstance } from 'fastify'
import { CircleAccountAddInputSchema, CircleAccountRemoveInputSchema } from '@foreman-code/contracts/management'
import { requirePrincipal } from '../modules/access/http.js'
import type { CircleAccountsManagementService } from '../modules/settings/circleAccounts.js'

export function registerCircleAccountRoutes(app: FastifyInstance, service: CircleAccountsManagementService): void {
  const path = '/api/management/settings/circle-accounts'
  app.get(path, request => service.get(requirePrincipal(request)))
  app.post(path, request => service.add(requirePrincipal(request), 'http', CircleAccountAddInputSchema.parse(request.body)))
  app.delete(path, request => service.remove(requirePrincipal(request), 'http', CircleAccountRemoveInputSchema.parse(request.body)))
}
