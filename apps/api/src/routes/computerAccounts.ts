import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ComputerAccountsReadInputSchema } from '@foreman-code/contracts/computer-accounts'
import type { ComputerAccountsService } from '../modules/computers/accounts.js'
import { requirePrincipal } from '../modules/access/http.js'

const Query = z.object({ refresh: z.enum(['true', 'false']).optional(), cursor: z.uuid().optional() }).strict()
export function registerComputerAccountsRoutes(app: FastifyInstance, service: ComputerAccountsService): void {
  app.get('/api/management/computers/accounts', request => {
    const query = Query.parse(request.query)
    return service.list(requirePrincipal(request), 'http', query.refresh === 'true', query.cursor)
  })
  app.post('/api/management/computers/accounts/read', request =>
    service.readTarget(requirePrincipal(request), 'http', ComputerAccountsReadInputSchema.parse(request.body)))
}
