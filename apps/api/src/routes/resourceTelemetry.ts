import type { FastifyInstance } from 'fastify'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { TelemetryReadService } from '@foreman-code/contracts/resource-telemetry'
import { requirePrincipal } from '../modules/access/http.js'
import { readTelemetry, RESOURCE_TELEMETRY_READ_ROUTE, type TelemetryDenialAudit } from '../modules/resource-telemetry/readback/adapters.js'
/** Register under existing authenticated Operator HTTP hook, never as a worker endpoint. */
export function registerResourceTelemetryRoutes(app: FastifyInstance, reads: TelemetryReadService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  app.post(RESOURCE_TELEMETRY_READ_ROUTE, { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    const principal = requirePrincipal(request)
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.raw.once('aborted', abort)
    try {
      const result = await readTelemetry(reads, principal, request.body, controller.signal, 'http', audit)
      return reply.code(result.kind === 'denied' ? 403 : 200).send(result)
    } finally { request.raw.removeListener('aborted', abort) }
  })
}
