import type { AgentConfigurationVersion, ResolvedSkill } from '@foreman-code/contracts'
import type pg from 'pg'
import type { SavedWorkflowDefinition, SavedWorkflowVersion } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { referencesCreatedByExecution } from '../runs/workflowDeliverable.js'
import type { NodeSkillOverride, OutputReferenceKind } from '@foreman-code/contracts/wave25'
import { readImmutableWorkflowVersion, readImmutableAgentConfiguration, readSavedWorkflowDefinition, IMMUTABLE_WORKFLOW_VERSION_COLUMNS,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow } from './immutableRead.js'

export class PostgresWorkflowRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async list(workspaceId: string): Promise<SavedWorkflowDefinition[]> {
    const result = await this.pool.query<{ id: string; workspace_id: string; record: unknown }>(
      'select id,workspace_id,record from workflows where workspace_id = $1 order by order_position, id',
      [workspaceId],
    )
    return result.rows.map((row) => readSavedWorkflowDefinition(row, { workspaceId }))
  }

  async get(workspaceId: string, workflowId: string): Promise<SavedWorkflowDefinition | undefined> {
    const result = await this.pool.query<{ id: string; workspace_id: string; record: unknown }>(
      'select id,workspace_id,record from workflows where workspace_id = $1 and id = $2',
      [workspaceId, workflowId],
    )
    return result.rows[0] ? readSavedWorkflowDefinition(result.rows[0], { workspaceId, workflowId }) : undefined
  }

  /** Every consumer receives the same immutable, hash-checked current V3. */
  async getVersion(workflowVersionId: string) {
    const version = await this.getSavedVersion(workflowVersionId)
    return version
  }

  async getSavedVersion(workflowVersionId: string): Promise<SavedWorkflowVersion | undefined> {
    const result = await this.pool.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id = $1`,
      [workflowVersionId],
    )
    return result.rows[0] ? readImmutableWorkflowVersion(result.rows[0], { id: workflowVersionId }) : undefined
  }

  async getCurrentVersion(workspaceId: string, workflowId: string) {
    const version = await this.getCurrentSavedVersion(workspaceId, workflowId)
    return version
  }

  async getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<SavedWorkflowVersion | undefined> {
    const result = await this.pool.query<ImmutableWorkflowVersionRow>(
      `select version.id,version.workspace_id,version.workflow_id,version.version,version.entry_node_id,
         version.execution_semantics_version,version.record
       from workflows workflow
       join workflow_versions version on version.id = workflow.current_version_id
         and version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id
       where workflow.workspace_id = $1 and workflow.id = $2`,
      [workspaceId, workflowId],
    )
    return result.rows[0] ? readImmutableWorkflowVersion(result.rows[0], { workspaceId, workflowId }) : undefined
  }

  async getAgentConfiguration(configurationVersionId: string): Promise<AgentConfigurationVersion | undefined> {
    const result = await this.pool.query<ImmutableAgentConfigurationRow>(
      'select id,workspace_id,agent_id,version,record from agent_configuration_versions where id = $1',
      [configurationVersionId],
    )
    return result.rows[0] ? readImmutableAgentConfiguration(result.rows[0], { id: configurationVersionId }) : undefined
  }

  /** Composes one node's saved skill snapshots without consulting the mutable catalog. */
  async resolveNodeSkills(configuration: AgentConfigurationVersion, override: NodeSkillOverride,
    additions: readonly ResolvedSkill[] = []): Promise<AgentConfigurationVersion> {
    return configurationWithNodeSkills(configuration, override, additions)
  }

  /** References are valid only for records this same execution created. */
  async referencesCreatedByExecution(kind: OutputReferenceKind, values: readonly string[] | undefined,
    workspaceId: string, executionId: string): Promise<ReadonlySet<string>> {
    return referencesCreatedByExecution(this.pool, kind, values, workspaceId, executionId)
  }

  async assertCurrentConfigurations(version: SavedWorkflowVersion): Promise<void> {
    const result = await this.pool.query<{ id: string; current_configuration_version_id: string | null }>(
      'select id, current_configuration_version_id from agents where workspace_id = $1 and id = any($2::text[])',
      [version.workspaceId, Object.keys(version.agentConfigurationVersionIds)],
    )
    if (result.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
      || result.rows.some((row) => row.current_configuration_version_id !== version.agentConfigurationVersionIds[row.id])) {
      throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Agent settings changed. Save the workflow again before starting it.', 409)
    }
  }

}
