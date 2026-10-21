import { AgentSchema, AgentConfigurationVersionSchema, projectHarnessEffort } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

interface AgentRow {
  record: unknown; metadata_revision: string; archived_at: Date | null
  current_configuration_version_id: string | null; configuration_record: unknown | null
}
function managedAgent(row: AgentRow) {
  let agent = AgentSchema.parse(row.record)
  if (row.current_configuration_version_id) {
    if (!row.configuration_record) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'The saved agent configuration is unavailable.', 409)
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration_record)
    const harness = configuration.harness
    agent = AgentSchema.parse({ ...agent, productRole: configuration.productRole, configurationVersionId: configuration.id,
      harness: harness.harness, harnessConfiguration: harness, model: harness.model,
      effort: projectHarnessEffort(harness),
      fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
      prompt: configuration.prompt, assignedSkills: configuration.assignedSkills, graphqlTools: configuration.graphqlTools,
      nativeTools: configuration.nativeTools })
  }
  return { agent, metadataRevision: Number(row.metadata_revision), archivedAt: row.archived_at?.toISOString() ?? null }
}
const AGENT_READ = `select a.record, a.metadata_revision, a.archived_at, a.current_configuration_version_id, c.record as configuration_record
  from agents a left join agent_configuration_versions c on c.id = a.current_configuration_version_id
    and c.workspace_id = a.workspace_id and c.agent_id = a.id`

export class AgentManagementService {
  constructor(private readonly pool: pg.Pool) {}
  async list(principal: ManagementPrincipal, input: { workspaceId: string; workflowId?: string | undefined; cursor?: string | undefined; limit: number; includeArchived?: boolean | undefined }) {
    requireAuthorization(principal, 'agents:read', { workspaceId: input.workspaceId, ...(input.workflowId ? { workflowId: input.workflowId } : {}) })
    const values: unknown[] = [input.workspaceId, input.cursor ?? null, input.limit + 1]
    const filter = input.workflowId ? `and exists (
      select 1 from workflows w, jsonb_array_elements(w.record->'nodes') n
      where w.id = $4 and w.workspace_id = $1 and n->>'agentId' = a.id)` : ''
    if (input.workflowId) values.push(input.workflowId)
    const result = await this.pool.query<AgentRow>(`${AGENT_READ}
      where a.workspace_id = $1 and ($2::text is null or a.id > $2) ${input.includeArchived ? '' : 'and a.archived_at is null'} ${filter} order by a.id limit $3`, values)
    const items = result.rows.slice(0, input.limit).map(managedAgent)
    return { items, pageInfo: { nextCursor: result.rows.length > input.limit ? items.at(-1)!.agent.id : null } }
  }
  async get(principal: ManagementPrincipal, workspaceId: string, agentId: string) {
    requireAuthorization(principal, 'agents:read', { workspaceId })
    const result = await this.pool.query<AgentRow>(`${AGENT_READ} where a.workspace_id = $1 and a.id = $2`, [workspaceId, agentId])
    const row = result.rows[0]
    if (!row) throw new DomainError('AGENT_NOT_FOUND', `Agent '${agentId}' was not found.`, 404)
    const workflows = await this.pool.query<{ id: string }>(`select id from workflows where workspace_id = $1 and exists (
      select 1 from jsonb_array_elements(record->'nodes') n where n->>'agentId' = $2) order by id`, [workspaceId, agentId])
    return { ...managedAgent(row), workflowIds: workflows.rows.map((item) => item.id) }
  }
}
