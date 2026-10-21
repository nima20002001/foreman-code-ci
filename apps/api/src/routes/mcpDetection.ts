import { AgentHarnessSchema, ScopedMcpDetectionSchema } from '@foreman-code/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DeviceProvisioningHostReferenceSchema } from '@foreman-code/contracts/device-resources'
import type { HarnessMcpSettingsService } from '../modules/harnesses/mcpSettings.js'
import { DomainError } from '../modules/errors.js'

import { requirePrincipal } from '../modules/access/http.js'
import { requireAuthorization } from '../modules/access/policy.js'
import type { McpDetectionService } from '../modules/harnesses/mcpDetection.js'
import type { WorkspaceLocationService } from '../modules/workspaces/location.js'

export function registerMcpDetectionRoute(
  app: FastifyInstance,
  locations: WorkspaceLocationService,
  detection: McpDetectionService,
  settings?: HarnessMcpSettingsService,
): void {
  app.get<{ Params: { workspaceId: string; harness: string } }>(
    '/api/management/workspaces/:workspaceId/harnesses/:harness/mcp-detection',
    async (request, reply) => {
      const params = z.object({ workspaceId: z.string().trim().min(1), harness: AgentHarnessSchema }).strict().parse(request.params)
      const principal = requirePrincipal(request)
      const resource = { workspaceId: params.workspaceId }
      requireAuthorization(principal, 'harnesses:read', resource)
      requireAuthorization(principal, 'workspace_locations:read', resource)
      const query = request.query as { hostRef?: string }
      const hostRef = query.hostRef ? DeviceProvisioningHostReferenceSchema.parse(JSON.parse(query.hostRef)) : undefined
      if (hostRef?.kind === 'device') {
        if (!settings) throw new DomainError('MCP_PRESET_UNAVAILABLE', 'Device MCP inspection is unavailable.', 503)
        return ScopedMcpDetectionSchema.parse(await settings.detectDevice(principal, params.harness, hostRef, resource))
      }
      const controller = new AbortController()
      const abandoned = () => controller.abort(new Error('MCP detection request abandoned.'))
      const closed = () => { if (!reply.raw.writableEnded) abandoned() }
      request.raw.once('aborted', abandoned)
      reply.raw.once('close', closed)
      try {
        if (request.raw.aborted || reply.raw.destroyed) abandoned()
        controller.signal.throwIfAborted()
        const location = await locations.inspectionSnapshot(params.workspaceId, controller.signal)
        return ScopedMcpDetectionSchema.parse(await detection.inspect({
          harness: params.harness, runnerId: location.runnerId, workingDirectory: location.rootPath,
          signal: controller.signal, phase: 'configuration',
        }))
      } finally {
        request.raw.removeListener('aborted', abandoned)
        reply.raw.removeListener('close', closed)
      }
    },
  )
}
