import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from './admission.js'
import { lockAgentConfigurations } from './agentConfiguration.js'
import { assertAgentIdle } from './operatorAgents.js'

type Input = {workspaceId:string;expectedRevision:number;commandId:string}
export class OperatorLifecycleService {
  constructor(private readonly commands: PostgresCommandCoordinator) {}

  restoreWorkspace(principal: ManagementPrincipal, input: Input) {
    requireAuthorization(principal,'workspaces:restore',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:'workspace.restore',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}`,payload:input,perform:async(client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))',[`admission:workspace:${input.workspaceId}`])
        const rows = await client.query<{revision:string;archived_at:Date|null}>('select revision,archived_at from workspaces where id=$1 for update',[input.workspaceId])
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (!current.archived_at) return {id:input.workspaceId,revision:input.expectedRevision,archived:false}
        await client.query('update workspaces set archived_at=null,revision=revision+1 where id=$1',[input.workspaceId])
        return {id:input.workspaceId,revision:input.expectedRevision+1,archived:false}
      }})
  }
  restoreWorkflow(principal: ManagementPrincipal, input: Input & {workflowId:string}) {
    requireAuthorization(principal,'workflows:restore',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    return this.commands.execute({principal,source:'mcp',operation:'workflow.restore',commandId:input.commandId,
      targetKey:`workflow:${input.workflowId}`,payload:input,perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        const rows = await client.query<{revision:string;archived_at:Date|null}>('select revision,archived_at from workflows where workspace_id=$1 and id=$2 for update',[input.workspaceId,input.workflowId])
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (!current.archived_at) return {id:input.workflowId,revision:input.expectedRevision,archived:false}
        await client.query('update workflows set archived_at=null,revision=revision+1 where workspace_id=$1 and id=$2',[input.workspaceId,input.workflowId])
        return {id:input.workflowId,revision:input.expectedRevision+1,archived:false}
      }})
  }
  agent(principal: ManagementPrincipal, input: Input & {agentId:string}, archived: boolean) {
    requireAuthorization(principal,archived?'agents:archive':'agents:restore',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:archived?'agent.archive':'agent.restore',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        await lockAgentConfigurations(client,[input.agentId])
        const rows = await client.query<{revision:string;archived_at:Date|null}>(
          'select metadata_revision as revision,archived_at from agents where workspace_id=$1 and id=$2 for update',[input.workspaceId,input.agentId],
        )
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (Boolean(current.archived_at) === archived) return {id:input.agentId,revision:input.expectedRevision,archived}
        await assertAgentIdle(client,input.workspaceId,input.agentId)
        if (archived) {
          const referenced = await client.query(
            `select id from workflows where workspace_id=$1 and (exists(select 1 from jsonb_array_elements(record->'nodes') n where n->>'agentId'=$2)
               or exists(select 1 from workflow_versions v where v.id=workflows.current_version_id and v.record->'agentConfigurationVersionIds' ? $2))
             union all select id from graph_drafts where workspace_id=$1 and discarded_at is null and
               exists(select 1 from jsonb_array_elements(record->'graph'->'nodes') n where n->>'agentId'=$2)
             limit 1`,[input.workspaceId,input.agentId],
          )
          if (referenced.rows.length) throw new DomainError('AGENT_STILL_REFERENCED','Remove the Agent from saved workflows and active drafts before archiving it. Historical versions are retained.',409)
        }
        await client.query('update agents set archived_at=case when $3 then now() else null end,metadata_revision=metadata_revision+1 where workspace_id=$1 and id=$2',[input.workspaceId,input.agentId,archived])
        return {id:input.agentId,revision:input.expectedRevision+1,archived}
      }})
  }
  private check(row:{revision:string;archived_at:Date|null}|undefined,revision:number) {
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND','The resource was not found.',404)
    if (Number(row.revision)!==revision) throw new DomainError('REVISION_CONFLICT','The resource changed since it was read.',409)
    return row
  }
}
