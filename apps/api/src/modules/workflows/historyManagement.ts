import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { readImmutableWorkflowVersion, readImmutableAgentConfiguration, IMMUTABLE_WORKFLOW_VERSION_COLUMNS, type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow } from './immutableRead.js'

export function versionCursor(cursor?: string): number | null {
  if (cursor === undefined) return null
  if (!/^[1-9][0-9]*$/.test(cursor) || Number(cursor) > 2_147_483_647) throw new DomainError('CURSOR_INVALID', 'Version cursors must be positive database version numbers.', 400)
  return Number(cursor)
}

export class VersionHistoryService {
  constructor(private readonly pool: pg.Pool) {}

  private async agentRead(principal: ManagementPrincipal, workspaceId: string, agentId: string) {
    if (!hasAction(principal,'agents:read')) throw new DomainError('ACCESS_DENIED','Agent read permission is required.',403)
    if (isAuthorized(principal,'agents:read',{workspaceId})) return
    const rows = await this.pool.query<{id:string}>(`select id from workflows where workspace_id=$1 and exists(
      select 1 from jsonb_array_elements(record->'nodes') node where node->>'agentId'=$2)`,[workspaceId,agentId])
    if (!rows.rows.some((row) => isAuthorized(principal,'agents:read',{workspaceId,workflowId:row.id}))) {
      throw new DomainError('AGENT_NOT_FOUND','The Agent is not visible in this scope.',404)
    }
  }

  async workflows(principal: ManagementPrincipal, input: {workspaceId:string;workflowId:string;cursor?:string|undefined;limit:number}) {
    requireAuthorization(principal,'workflows:read',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    const rows = await this.pool.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where workspace_id=$1 and workflow_id=$2 and ($3::integer is null or version>$3)
       order by version limit $4`,[input.workspaceId,input.workflowId,versionCursor(input.cursor),input.limit+1],
    )
    const items = rows.rows.slice(0,input.limit).map((row) => readImmutableWorkflowVersion(row, { workspaceId: input.workspaceId, workflowId: input.workflowId }))
    return {items,pageInfo:{nextCursor:rows.rows.length>input.limit ? String(items.at(-1)!.version):null}}
  }
  async workflow(principal: ManagementPrincipal, input: {workspaceId:string;workflowId:string;versionId:string}) {
    requireAuthorization(principal,'workflows:read',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    const rows = await this.pool.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3`,[input.workspaceId,input.workflowId,input.versionId])
    if (!rows.rows[0]) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND','The workflow version was not found.',404)
    return {version:readImmutableWorkflowVersion(rows.rows[0], { id: input.versionId, workspaceId: input.workspaceId, workflowId: input.workflowId })}
  }
  async agents(principal: ManagementPrincipal, input: {workspaceId:string;agentId:string;cursor?:string|undefined;limit:number}) {
    await this.agentRead(principal,input.workspaceId,input.agentId)
    const rows = await this.pool.query<ImmutableAgentConfigurationRow>(
      `select id,workspace_id,agent_id,version,record from agent_configuration_versions where workspace_id=$1 and agent_id=$2 and ($3::integer is null or version>$3)
       order by version limit $4`,[input.workspaceId,input.agentId,versionCursor(input.cursor),input.limit+1],
    )
    const items = rows.rows.slice(0,input.limit).map((row) => readImmutableAgentConfiguration(row, { workspaceId: input.workspaceId, agentId: input.agentId }))
    if (items.some((item) => item.resolvedSkills?.length)) requireAuthorization(principal,'skills:read',{workspaceId:input.workspaceId})
    return {items,pageInfo:{nextCursor:rows.rows.length>input.limit ? String(items.at(-1)!.version):null}}
  }
  async agent(principal: ManagementPrincipal, input: {workspaceId:string;agentId:string;versionId:string}) {
    await this.agentRead(principal,input.workspaceId,input.agentId)
    const rows = await this.pool.query<ImmutableAgentConfigurationRow>('select id,workspace_id,agent_id,version,record from agent_configuration_versions where workspace_id=$1 and agent_id=$2 and id=$3',[input.workspaceId,input.agentId,input.versionId])
    if (!rows.rows[0]) throw new DomainError('AGENT_VERSION_NOT_FOUND','The Agent version was not found.',404)
    const version = readImmutableAgentConfiguration(rows.rows[0], { id: input.versionId, workspaceId: input.workspaceId, agentId: input.agentId })
    if (version.resolvedSkills?.length) requireAuthorization(principal,'skills:read',{workspaceId:input.workspaceId})
    return {version}
  }
}
