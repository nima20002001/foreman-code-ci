import type { FastifyInstance } from 'fastify'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { TelemetrySelectorService } from '@foreman-code/contracts/resource-telemetry'
import { requirePrincipal } from '../modules/access/http.js'
import { RESOURCE_TELEMETRY_SELECTOR_ROUTE, resolveTelemetrySelector } from '../modules/resource-telemetry/readback/selector.js'
import type { TelemetryDenialAudit } from '../modules/resource-telemetry/readback/adapters.js'

export function registerResourceTelemetrySelectorRoutes(app: FastifyInstance, selectors: TelemetrySelectorService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  app.post(RESOURCE_TELEMETRY_SELECTOR_ROUTE, { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    const principal = requirePrincipal(request)
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.raw.once('aborted', abort)
    try {
      const result = await resolveTelemetrySelector(selectors, principal, request.body, controller.signal, 'http', audit)
      return reply.code(result.kind === 'denied' ? 403 : 200).send(result)
    } finally { request.raw.removeListener('aborted', abort) }
  })
}
