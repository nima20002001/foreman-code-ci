import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { z } from 'zod'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import { defineOperatorTool, registerToolDefinition } from '../../mcp/operator/definition.js'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import { ConnectionProbeSchema, HostDiscoverySchema, TrustedEndpointSchema } from './trustedConnectionProbe.js'
import { TrustedConnectionCheckSchema, TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionReadSchema, type PostgresTrustedConnectionSetup } from './trustedConnectionSetup.js'

export type TrustedConnectionManagementService = Pick<PostgresTrustedConnectionSetup, 'read' | 'configure' | 'inspect' | 'check'> & {
  /** Composition must revalidate the live principal before exposing local host facts. */
  discover(principal: ManagementPrincipal): Promise<z.infer<typeof HostDiscoverySchema>>
}
const DeviceInput = z.object({ deviceId: z.uuid() }).strict()
const InspectInput = DeviceInput.extend({ endpoint: TrustedEndpointSchema }).strict()
export function registerTrustedConnectionRoutes(app: FastifyInstance, service: TrustedConnectionManagementService,
  authenticate: (request: FastifyRequest) => Promise<ManagementPrincipal>): void {
  app.get('/api/devices/connection-host', async request => service.discover(await authenticate(request)))
  app.post('/api/devices/connection-read', async request => service.read(await authenticate(request), DeviceInput.parse(request.body).deviceId))
  app.post('/api/devices/connection-inspect', async request => {
    const input = InspectInput.parse(request.body)
    return service.inspect(await authenticate(request), input.deviceId, input.endpoint)
  })
  app.post('/api/devices/connection-check', async request => service.check(await authenticate(request), DeviceInput.parse(request.body).deviceId))
  app.post('/api/devices/connection-configure', async request => service.configure(await authenticate(request), TrustedConnectionConfigureSchema.parse(request.body), 'http'))
}
async function invoke(principal: ManagementPrincipal, action: 'settings:read' | 'settings:update', operation: () => Promise<unknown>) {
  try { requireAuthorization(principal, action); return toolResult(await operation()) }
  catch (error) { return toolFailure(error, 'The trusted device connection operation failed.') }
}
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const read = [['settings:read', 'global']] as const
const service = (context: OperatorRequestContext) => context.services.trustedConnections!
export const trustedConnectionTools = [
  defineOperatorTool({
    name: 'device_connection_host_discover', requires: read, enabled: s => !!s.trustedConnections,
    description: 'Read local OS user, installed SSH/rsync/Tailscale and actual LAN/Tailscale self candidate addresses. Discovery does not prove reachability or grant remote commands.', inputSchema: z.object({}).strict(), outputSchema: HostDiscoverySchema, annotations: readAnnotations,
    handle: (context) => invoke(context.principal, 'settings:read', () => service(context).discover(context.principal)),
  }),
  defineOperatorTool({
    name: 'device_connection_read', requires: read, enabled: s => !!s.trustedConnections,
    description: 'Read existing paired identity and current revisioned owner consent. No credentials or agent grants.', inputSchema: DeviceInput, outputSchema: TrustedConnectionReadSchema, annotations: readAnnotations,
    handle: (context, input) => invoke(context.principal, 'settings:read', () => service(context).read(context.principal, input.deviceId)),
  }),
  defineOperatorTool({
    name: 'device_connection_inspect', requires: read, enabled: s => !!s.trustedConnections,
    description: 'Perform fixed read-only SSH diagnostics against a selected endpoint/user using existing authentication and strict host trust. Reports observed host key and installed remote executables; never installs or grants access.', inputSchema: InspectInput, outputSchema: ConnectionProbeSchema, annotations: { ...readAnnotations, openWorldHint: true },
    handle: (context, input) => invoke(context.principal, 'settings:read', () => service(context).inspect(context.principal, input.deviceId, input.endpoint)),
  }),
  defineOperatorTool({
    name: 'device_connection_check', requires: read, enabled: s => !!s.trustedConnections,
    description: 'Check current consent, paired revisions, strict SSH authentication, host key, selected OS user and remote executables. Reports offline/revoked/auth states truthfully. Does not qualify harnesses or authorize agent execution.', inputSchema: DeviceInput, outputSchema: TrustedConnectionCheckSchema, annotations: { ...readAnnotations, openWorldHint: true },
    handle: (context, input) => invoke(context.principal, 'settings:read', () => service(context).check(context.principal, input.deviceId)),
  }),
  defineOperatorTool({
    name: 'device_connection_configure', requires: [['settings:update', 'global']], enabled: s => !!s.trustedConnections,
    description: 'Persist or revoke remote-command consent for a paired device as the selected OS user. Requires global settings:update; pairing authorizes direct connection changes through HTTP and MCP. Does not enable live SSH/VPN, root/sudo, persistent credentials or agent grants. Requires current device and consent revisions.',
    inputSchema: TrustedConnectionConfigureSchema, outputSchema: TrustedConnectionConsentSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handle: (context, input) => invoke(context.principal, 'settings:update', () => service(context).configure(context.principal, input, 'mcp')),
  }),
]
export function registerTrustedConnectionTools(server: McpServer, service: TrustedConnectionManagementService, principal: ManagementPrincipal): void {
  const context = { principal, services: { trustedConnections: service } } as unknown as OperatorRequestContext
  for (const tool of trustedConnectionTools) {
    if (isAuthorized(principal, tool.requires[0][0], {})) registerToolDefinition(server, context, tool)
  }
}
