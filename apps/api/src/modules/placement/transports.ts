import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunPlacementGetInputSchema, RunPlacementGetResultSchema, NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { requirePrincipal } from '../access/http.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { toolFailure } from '../../mcp/shared/results.js'
import type { RunPlacementReadService } from './readService.js'
import { placementChoiceRequirements } from './choicesService.js'
import { defineOperatorTool, grants, registerToolDefinition } from '../../mcp/operator/definition.js'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'

/** Mount under the existing management auth hook. No caller placement/proof JSON
 * is accepted by this read-only adapter or by the existing shared Start route. */
export function registerRunPlacementRoutes(app: FastifyInstance, reads: RunPlacementReadService): void {
  app.get<{ Params: Record<string, string> }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie')
    return reads.get(requirePrincipal(request), request.params)
  })
}

type Commands = Pick<PostgresCommandCoordinator, 'recordDenied'>
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
async function respond(principal: ManagementPrincipal, commands: Commands, name: 'run_node_placement_get' | 'workflow_node_placement_choices',
  read: () => Promise<Record<string, unknown>>) {
  try {
    const result = await read()
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) await commands.recordDenied(principal.id, 'mcp', name, `mcp:${name}`)
    return toolFailure(error)
  }
}

export const runPlacementTool = defineOperatorTool({
  name: 'run_node_placement_get',
  requires: [['runs:read', 'run'], ['workspace_locations:read', 'workspace']],
  enabled: s => !!s.runs && !!s.runPlacements,
  description: 'Read accepted host, configuration, root, source and requested Agent branch prefix for one Run node. Persisted native placements report each prepared branch and materialized working directory separately. Inherited Main nodes without a per-node binding return legacy_missing evidence. Requires live scoped runs:read and workspace_locations:read for canonical paths. Current Board settings are never substituted and this read does not launch work.',
  inputSchema: RunPlacementGetInputSchema, outputSchema: RunPlacementGetResultSchema, annotations: readAnnotations,
  handle: (context, input) => respond(context.principal, context.services.commands, 'run_node_placement_get',
    () => context.services.runPlacements!.get(context.principal, input)),
})
export function registerRunPlacementTool(server: McpServer, reads: RunPlacementReadService, principal: ManagementPrincipal, commands: Commands): void {
  const context = { principal, services: { runPlacements: reads, commands } } as unknown as OperatorRequestContext
  registerToolDefinition(server, context, runPlacementTool)
}

export function registerNodePlacementChoicesRoutes(app: FastifyInstance, reads: import('./choicesService.js').NodePlacementChoicesService): void {
  app.get<{ Params: Record<string, string>; Querystring: Record<string, unknown> }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie')
    if (Object.keys(request.params).some(key => Object.hasOwn(request.query, key))) throw new DomainError('RESOURCE_ID_MISMATCH', 'Placement choice scope must be supplied in the URL.', 400)
    return reads.get(requirePrincipal(request), { ...request.query, ...request.params }, 'http')
  })
}
export const nodePlacementChoicesTool = defineOperatorTool({
  name: 'workflow_node_placement_choices',
  requires: grants(placementChoiceRequirements),
  enabled: s => !!s.placementChoices && !!s.workflows,
  description: 'List computers, approved sources and roots, and matching harness profiles for one saved node/configuration. Enabled matching profiles with missing or stale checks are checked automatically; checking or failed profiles remain unavailable with a reason. pending=true means a matching profile is still being checked or a computer is temporarily unavailable or changed during discovery; a paired computer may be missing from choices until it settles; read again until pending=false. Unusable roots remain visible as unavailable choices with a reason, including released sources. Existing host bindings remain selectable after workspace location changes while their saved policy and source remain authorized. Requires scoped workflows:read, workspace_locations:read, source_roots:read and sources:read, plus global harnesses:read. Clear node placement through workflow_save_v3 to inherit the workflow default, or Main when no default is saved. For callers with scoped source_roots:bind and workspace_locations:validate/update, discovery automatically prepares pairing-managed storage and binds the current approved source on ready matching paired Agent hosts. Read-only callers only see existing bindings. Primary workspace location stays unchanged. Save and Start revalidate revisions and authority.',
  inputSchema: NodePlacementChoicesInputSchema, outputSchema: NodePlacementChoicesResultSchema, annotations: { ...readAnnotations, readOnlyHint: false },
  handle: (context, input) => respond(context.principal, context.services.commands, 'workflow_node_placement_choices',
    () => context.services.placementChoices!.get(context.principal, input)),
})
export function registerNodePlacementChoicesTool(server: McpServer, reads: import('./choicesService.js').NodePlacementChoicesService,
  principal: ManagementPrincipal, commands: Commands): void {
  const context = { principal, services: { placementChoices: reads, commands } } as unknown as OperatorRequestContext
  registerToolDefinition(server, context, nodePlacementChoicesTool)
}

/** Discovery and accepted Run readback have separate grants and do not authorize execution. */
export function placementCapabilityLimit(composed: boolean) {
  return { feature: 'accepted_node_placement', state: composed ? 'limited' as const : 'unsupported' as const,
    detail: composed
      ? 'run_node_placement_get requires runs:read and workspace_locations:read. '
        + 'Inherited Main nodes without a per-node binding return legacy_missing evidence. '
        + 'workflow_node_placement_choices requires scoped workflows:read, workspace_locations:read, '
        + 'source_roots:read and sources:read, plus global harnesses:read. '
        + 'Ready paired Agent hosts automatically receive pairing-managed workspace storage and the current source binding when the caller has source_roots:bind and workspace_locations:validate/update. Read-only callers only discover existing roots. Primary location remains unchanged. '
        + 'Existing host bindings retain their saved revisions across workspace location changes while authorized. '
        + 'Enabled matching profiles with missing or stale checks are checked automatically; checks deduplicate per instance revision. '
        + 'Computer probes run once per installation outside metadata transactions; connection, storage and overload failures leave healthy computers usable. pending=true also covers temporary computer failures or settings changed during discovery. '
        + 'Checking or failed profiles and unusable roots remain visible as unavailable choices with a reason, including released sources. '
        + 'Clear a saved node placement through workflow_save_v3 to inherit the workflow default, '
        + 'or Main when no default is saved. Requested branches and persisted native branch/CWD facts are separate. '
        + 'Accepted Run binding remains unchanged; remote execution requires the approved device dispatch bridge.'
      : 'Placement readback and authorized choices are not composed in this application.' }
}
