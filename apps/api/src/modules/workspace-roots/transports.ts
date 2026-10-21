import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkspaceRootListInputSchema, WorkspaceRootListResultSchema } from '@foreman-code/contracts/workspace-root-policies'
import { WorkspaceBoundLocationGetInputSchema, WorkspaceBoundLocationValidateInputSchema, WorkspaceBoundLocationBrowseInputSchema,
  WorkspaceBoundLocationSetInputSchema, WorkspaceBoundLocationValidationSchema, WorkspaceBoundLocationBrowseResultSchema,
  WorkspaceBoundLocationReadbackSchema, WorkspaceBoundLocationSetResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { WorkspaceRootConfigurationAdoptSchema, WorkspaceRootConfigurationAdoptResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { requirePrincipal } from '../access/http.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import type { WorkspaceBoundLocationService } from './service.js'
import { defineOperatorTool, registerToolDefinition } from '../../mcp/operator/definition.js'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'

const TOOLS = { adopt: 'workspace_root_configuration_adopt', choices: 'workspace_root_choices_list', get: 'workspace_root_location_get',
  validate: 'workspace_root_location_validate', browse: 'workspace_root_directories_list', set: 'workspace_root_location_set' } as const
function scoped(workspaceId: string, raw: unknown) {
  if (raw === undefined) return { workspaceId }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('INVALID_REQUEST', 'Expected an object body.', 400)
  const body = raw as Record<string, unknown>
  if (body.workspaceId !== undefined && body.workspaceId !== workspaceId) throw new DomainError('RESOURCE_ID_MISMATCH', 'Workspace scope does not match the route.', 400)
  return { ...body, workspaceId }
}
/** Existing authenticated management mount only. Main state changes remain in
 * the original workspace.location.set command receipt/audit namespace. */
export function registerWorkspaceRootRoutes(app: FastifyInstance, service: WorkspaceBoundLocationService): void {
  type Request = { Params: { workspaceId: string }; Body: unknown; Querystring: Record<string, unknown> }
  const base = '/api/management/workspaces/:workspaceId'
  app.post<Request>(`${base}/root-configurations/adopt`, request => service.adopt(requirePrincipal(request), 'http', scoped(request.params.workspaceId, request.body)))
  app.get<Request>(`${base}/root-policies`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service.choices(requirePrincipal(request), scoped(request.params.workspaceId, request.query))
  })
  app.get<Request>(`${base}/root-location`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    return service.get(requirePrincipal(request), scoped(request.params.workspaceId, request.query))
  })
  app.post<Request>(`${base}/root-location/validate`, request => service.validate(requirePrincipal(request), 'http', scoped(request.params.workspaceId, request.body)))
  app.post<Request>(`${base}/root-location/browse`, request => service.browse(requirePrincipal(request), scoped(request.params.workspaceId, request.body)))
  app.put<Request>(`${base}/root-location`, request => service.set(requirePrincipal(request), 'http', scoped(request.params.workspaceId, request.body)))
}
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
type Commands = Pick<PostgresCommandCoordinator, 'recordDenied'>
async function invoke(principal: ManagementPrincipal, commands: Commands, name: string, work: () => Promise<unknown>) {
  try { return toolResult(await work()) } catch (error) {
    if (error instanceof DomainError && error.status === 403) await commands.recordDenied(principal.id, 'mcp', name, `mcp:${name}`)
    return toolFailure(error)
  }
}
const adoption = { description: 'Adopt the approved root configuration from the selected authenticated host installation, including product-managed storage approved by its current human pairing. Arbitrary user paths require explicit owner approval on that host. Requires scoped source_roots:read/bind and workspace_locations:read/validate/update. No caller paths or new approval; persists the configuration with an idempotent command receipt and audit. Then list, validate and bind its root choices. CI enrollment adopts and binds product-managed storage automatically.',
  inputSchema: WorkspaceRootConfigurationAdoptSchema, outputSchema: WorkspaceRootConfigurationAdoptResultSchema, annotations: { ...read, readOnlyHint: false } }

export const workspaceRootTools = [
  defineOperatorTool({
    name: TOOLS.choices,
    requires: [['source_roots:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.workspaceRoots,
    description: 'List persisted computer/base/root policies for an existing workspace, including Main app-managed Workspaces storage, pairing-approved product-managed Worker storage and explicitly owner-approved additional roots, without filesystem probing. managedBy identifies pairing-approved managed bases; bindingPurpose identifies CI enrollment roots that preserve the workspace’s primary location. Requires scoped source_roots:read and workspace_locations:read. No Agent or workflow is required; metadata-only is not worker readiness.',
    inputSchema: WorkspaceRootListInputSchema, outputSchema: WorkspaceRootListResultSchema, annotations: read,
    handle: (context, input) => invoke(context.principal, context.services.commands, TOOLS.choices,
      () => context.services.workspaceRoots!.choices(context.principal, input)),
  }),
  defineOperatorTool({
    name: TOOLS.get,
    requires: [['workspace_locations:read', 'workspace'], ['source_roots:read', 'workspace']],
    enabled: s => !!s.workspaceRoots,
    description: 'Read the current exact workspace root binding and location revision. Requires scoped source_roots:read and workspace_locations:read. Legacy locations explicitly lack root evidence; never infer a host from a path.',
    inputSchema: WorkspaceBoundLocationGetInputSchema, outputSchema: WorkspaceBoundLocationReadbackSchema, annotations: read,
    handle: (context, input) => invoke(context.principal, context.services.commands, TOOLS.get,
      () => context.services.workspaceRoots!.get(context.principal, input)),
  }),
  defineOperatorTool({
    name: TOOLS.validate,
    requires: [['workspace_locations:validate', 'workspace'], ['source_roots:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.workspaceRoots,
    description: 'Validate a relative directory through its approved computer/base configuration with native component-safe attestation. Correctable folder failures return stable domain codes such as ROOT_RELATIVE_PATH_INVALID. Requires scoped source_roots:read, workspace_locations:read and workspace_locations:validate. Does not set a location or launch a harness.',
    inputSchema: WorkspaceBoundLocationValidateInputSchema, outputSchema: WorkspaceBoundLocationValidationSchema, annotations: read,
    handle: (context, input) => invoke(context.principal, context.services.commands, TOOLS.validate,
      () => context.services.workspaceRoots!.validate(context.principal, 'mcp', input)),
  }),
  defineOperatorTool({
    name: TOOLS.browse,
    requires: [['workspace_locations:validate', 'workspace'], ['source_roots:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.workspaceRoots,
    description: 'Browse directories only within the selected approved native base and current root/config/location revisions. Requires scoped source_roots:read and workspace_locations:read/validate. Never sends caller absolute paths or follows escaped components.',
    inputSchema: WorkspaceBoundLocationBrowseInputSchema, outputSchema: WorkspaceBoundLocationBrowseResultSchema, annotations: read,
    handle: (context, input) => invoke(context.principal, context.services.commands, TOOLS.browse,
      () => context.services.workspaceRoots!.browse(context.principal, input)),
  }),
  defineOperatorTool({
    name: TOOLS.set,
    requires: [['workspace_locations:update', 'workspace'], ['source_roots:read', 'workspace'], ['workspace_locations:read', 'workspace'], ['source_roots:bind', 'workspace'], ['workspace_locations:validate', 'workspace']],
    enabled: s => !!s.workspaceRoots,
    description: 'Revision-check and save an approved native workspace root binding using the existing location command receipt/audit path. Main root selections update the primary execution location and its revision. Device root selections add or update that computer’s root only, preserving the primary location and its revision; the response describes the selected root. Selecting the same folder reattests its identity and can repair a replaced directory. Correctable native folder failures return stable domain codes. Requires scoped source_roots:read/bind plus workspace_locations:read/validate/update. The server derives canonical path and registered application runner identity. Existing source roots and runtime profiles keep their saved bindings across location changes while their host and policy remain authorized. Existing Runs retain accepted pins. Reuse commandId and exact input after unknown acknowledgment; never substitute another host.',
    inputSchema: WorkspaceBoundLocationSetInputSchema, outputSchema: WorkspaceBoundLocationSetResultSchema, annotations: { ...read, readOnlyHint: false },
    handle: (context, input) => invoke(context.principal, context.services.commands, TOOLS.set,
      () => context.services.workspaceRoots!.set(context.principal, 'mcp', input)),
  }),
]

/** Not a catalogued Operator tool: it is listed with the composed workspace-root service. */
export function registerWorkspaceRootAdoptionTool(server: McpServer, service: WorkspaceBoundLocationService, principal: ManagementPrincipal,
  commands: Commands, principalForCall = () => principal): void {
  server.registerTool(TOOLS.adopt, adoption, input => {
    const caller = principalForCall()
    return invoke(caller, commands, TOOLS.adopt, () => service.adopt(caller, 'mcp', input))
  })
}
export function registerWorkspaceRootTools(server: McpServer, service: WorkspaceBoundLocationService, principal: ManagementPrincipal,
  commands: Commands): void {
  registerWorkspaceRootAdoptionTool(server, service, principal, commands)
  const context = { principal, services: { workspaceRoots: service, commands } } as unknown as OperatorRequestContext
  for (const tool of workspaceRootTools) registerToolDefinition(server, context, tool)
}
export function workspaceRootCapabilityLimit(composed: boolean) {
  return { feature: 'workspace_registered_roots', state: composed ? 'limited' as const : 'unsupported' as const,
    detail: composed ? 'Independent workspace roots expose exact schemas through tools/list: workspace_root_configuration_adopt persists authenticated approved host configuration, including product-managed Worker storage approved by human pairing, with source_roots:read/bind and workspace_locations:read/validate/update; workspace_root_choices_list/location_get require source_roots:read and workspace_locations:read; directories_list/location_validate additionally require workspace_locations:validate; location_set additionally requires source_roots:bind and workspace_locations:update. CI enrollment and placement discovery adopt and bind product-managed Worker storage automatically for callers with the existing write grants, without changing the primary workspace location. Device root setters also preserve the primary location and its revision. Location changes preserve existing source roots and runtime profile bindings while authorized. The legacy workspace_location_set rejects workspaces with approved computer roots; use workspace_root_location_set. Generic workspace readback inspects saved roots on their approved host and reports missing host authority. Main app-managed Workspaces storage is initialized by the installation; paired Worker managed storage is approved by pairing.'

      : 'Registered workspace root services are not composed.' }
}
