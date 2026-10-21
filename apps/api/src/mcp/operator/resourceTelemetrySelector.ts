import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { TelemetrySelectorTargetSchema, type TelemetrySelectorService } from '@foreman-code/contracts/resource-telemetry'
import { toolFailure } from '../shared/results.js'
import { RESOURCE_TELEMETRY_SELECTOR_TOOL, resolveTelemetrySelector } from '../../modules/resource-telemetry/readback/selector.js'
import type { TelemetryDenialAudit } from '../../modules/resource-telemetry/readback/adapters.js'
import { defineOperatorTool } from './definition.js'
import { TELEMETRY_PERMISSION_DETAIL, telemetryDenialAudit, telemetryDiscoverable } from './resourceTelemetry.js'

const description = 'Resolve one authorized ResourceTelemetry selector from an exact public computer, Run execution, CI attempt, or conversation reference. The server supplies authenticated host and collector generations from existing live ownership; this never creates an owner, starts collection or execution, or grants computer access from an owned scope. Denied and unavailable results expose no identities, owners, or metric values.'
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

async function respond(selectors: TelemetrySelectorService<ManagementPrincipal>, principal: ManagementPrincipal,
  input: unknown, extra: ServerContext, audit: TelemetryDenialAudit) {
  try {
    const result = await resolveTelemetrySelector(selectors, principal, input, extra.mcpReq.signal, 'mcp', audit)
    return { ...(result.kind === 'denied' ? { isError: true } : {}),
      content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) { return toolFailure(error) }
}

export const resourceTelemetrySelectorTool = defineOperatorTool({
  name: RESOURCE_TELEMETRY_SELECTOR_TOOL,
  requires: [['devices:metrics:read', 'global'], ['runs:read', 'resource'], ['jobs:read', 'resource'], ['agent_chat:read', 'resource'], ['operator_chat:read', 'resource']],
  enabled: s => !!s.resourceTelemetry,
  discoverable: telemetryDiscoverable,
  permissionDetail: TELEMETRY_PERMISSION_DETAIL,
  description,
  inputSchema: TelemetrySelectorTargetSchema,
  annotations,
  handle: (context, input, { extra }) => respond(context.services.resourceTelemetry!.selectors, context.principal, input, extra,
    telemetryDenialAudit(context, RESOURCE_TELEMETRY_SELECTOR_TOOL)),
})

export function registerResourceTelemetrySelectorTools(server: McpServer, principal: ManagementPrincipal,
  selectors: TelemetrySelectorService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  server.registerTool(RESOURCE_TELEMETRY_SELECTOR_TOOL, { description, inputSchema: TelemetrySelectorTargetSchema, annotations },
    (input, extra) => respond(selectors, principal, input, extra, audit))
}
