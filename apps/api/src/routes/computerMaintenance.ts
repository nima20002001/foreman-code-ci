import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ComputerMaintenanceReadInputSchema, ComputerMaintenanceListInputSchema } from '@foreman-code/contracts/computer-maintenance'
import type { FleetMaintenanceService } from '../modules/computers/fleet.js'
import { maintenanceHistoryResult } from '../modules/computers/maintenanceSummary.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerMaintenanceRoutes(app: FastifyInstance, service: FleetMaintenanceService): void {
  app.get('/api/management/computers/maintenance', async request => {
    const query = z.object({ refresh: z.enum(['true', 'false']).optional(),
      taskLimit: z.string().optional() }).parse(request.query)
    const input = ComputerMaintenanceListInputSchema.parse({ refresh: query.refresh === 'true',
      taskLimit: query.taskLimit === undefined ? undefined : Number(query.taskLimit) })
    return maintenanceHistoryResult(await service.list(requirePrincipal(request), 'http', input.refresh), input)
  })
  app.post('/api/management/computers/maintenance/read', async request => {
    const input = ComputerMaintenanceReadInputSchema.parse(request.body)
    return maintenanceHistoryResult(await service.readTarget(requirePrincipal(request), 'http', input), input)
  })
  app.post('/api/management/computers/maintenance/start', request =>
    service.start(requirePrincipal(request), 'http', request.body as Parameters<FleetMaintenanceService['start']>[2]))
}
