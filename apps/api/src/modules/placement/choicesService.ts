import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema, type NodePlacementChoicesInput, type NodePlacementChoice, type NodePlacementChoicesResult } from '@foreman-code/contracts/placement-readback'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'

/** Discovery reads authorized destination metadata; Start validates the selected pins again. */
export interface PlacementChoiceDiscovery {
  list(principal: ManagementPrincipal, input: NodePlacementChoicesInput, source?: 'http' | 'mcp'):
    Promise<{ choices: readonly NodePlacementChoice[]; pending: boolean }>
}
export const placementChoiceRequirements = [
  { action: 'workflows:read', scope: 'workflow' },
  { action: 'workspace_locations:read', scope: 'workspace' },
  { action: 'source_roots:read', scope: 'workspace' },
  { action: 'sources:read', scope: 'workspace' },
  { action: 'harnesses:read', scope: 'global' },
] as const
export class NodePlacementChoicesService {
  constructor(private readonly pool: pg.Pool, private readonly discovery: PlacementChoiceDiscovery) {}
  private async pinned(principal: ManagementPrincipal, input: NodePlacementChoicesInput) {
    const authorize = (p: ManagementPrincipal) => {
      for (const requirement of placementChoiceRequirements) {
        let resource = {}
        if (requirement.scope === 'workflow') resource = { workspaceId: input.workspaceId, workflowId: input.workflowId }
        if (requirement.scope === 'workspace') resource = { workspaceId: input.workspaceId }
        requireAuthorization(p, requirement.action, resource)
      }
    }
    authorize(principal)
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      authorize(live)
      const main = (await client.query<{ id: string }>(
        'select id from application_installation where singleton=true',
      )).rows[0]
      if (!main) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Computer choices are not initialized.', 503)
      const row = (await client.query<{ record: unknown }>(`select v.record from workflows w
        join workflow_versions v on v.id=w.current_version_id
        where w.workspace_id=$1 and w.id=$2 and w.archived_at is null`, [input.workspaceId, input.workflowId])).rows[0]
      if (!row) throw new DomainError('WORKFLOW_NOT_SAVED', 'Placement choices require a saved workflow.', 409)
      const version = WorkflowVersionV3Schema.parse(row.record)
      const node = version.definition.nodes.find(n => n.id === input.nodeId)
      if (!node || node.kind === 'job' || version.agentConfigurationVersionIds[node.agentId] !== input.agentConfigurationVersionId) throw new DomainError(
        'PLACEMENT_CONFIGURATION_CONFLICT', 'Placement choices require the saved node configuration.', 409)
      authorize(principal)
      authorize(live)
      return { mainId: main.id }
    })
  }
  async get(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'mcp'): Promise<NodePlacementChoicesResult> {
    const input = NodePlacementChoicesInputSchema.parse(raw)
    const { mainId } = await this.pinned(principal, input)
    const { choices, pending } = await this.discovery.list(principal, input, source)
    const current = await this.pinned(principal, input) // external discovery held no SQL locks
    const result = NodePlacementChoicesResultSchema.parse({ ...input, choices, pending })
    if (current.mainId !== mainId || result.choices.some(choice => choice.placement.hostRef.mainId !== mainId)
      || new Set(result.choices.map(choice => choice.id)).size !== result.choices.length) throw new DomainError(
      'PLACEMENT_CHOICES_INVALID', 'Destination discovery returned duplicate selection identities.', 409)
    return result
  }
}
