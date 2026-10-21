import type pg from 'pg'
import type { z } from 'zod'
import type { HarnessMcpDetectionInputSchema, ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { McpDetectionService } from '../harnesses/mcpDetection.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from './admission.js'
import type { WorkspaceLocationService } from './location.js'
import { provisionWorkspaceDirectory } from './provisioning.js'
import { withFilesystemDeadline } from './filesystem.js'

export class OperatorWorkspaceControls {
  constructor(private readonly pool:pg.Pool,private readonly commands:PostgresCommandCoordinator,
    private readonly locations:WorkspaceLocationService,private readonly detection:McpDetectionService,
    private readonly provisioningRoot?:string) {}
  get provisioningEnabled(): boolean { return Boolean(this.provisioningRoot) }

  async runners(principal:ManagementPrincipal,workspaceId:string) {
    requireAuthorization(principal,'workspace_locations:read',{workspaceId})
    const result = await this.pool.query('select id from workspaces where id=$1',[workspaceId])
    if (!result.rows.length) throw new DomainError('WORKSPACE_NOT_FOUND','The workspace was not found.',404)
    return {items:[{id:this.locations.runnerId,kind:'local' as const,available:true as const,
      supportsRemoteDispatch:false as const,supportsProvisioning:this.provisioningEnabled}]}
  }
  async diagnostics(principal:ManagementPrincipal,input:z.infer<typeof HarnessMcpDetectionInputSchema>) {
    requireAuthorization(principal,'harnesses:read',{workspaceId:input.workspaceId})
    requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    if (input.harness === 'claude') throw new DomainError('CLAUDE_PROFILE_SELECTION_REQUIRED',
      'Workspace MCP diagnostics require an exact Claude host profile selection; this diagnostics request does not carry one.',409)
    const signal=AbortSignal.timeout(60_000)
    const snapshot = await this.locations.inspectionSnapshot(input.workspaceId, signal)
    return this.detection.inspect({harness:input.harness,runnerId:snapshot.runnerId,workingDirectory:snapshot.rootPath,signal})
  }
  clear(principal:ManagementPrincipal,input:{workspaceId:string;commandId:string;expectedLocationRevision:number}) {
    requireAuthorization(principal,'workspace_locations:update',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:'workspace.location.clear',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:location`,payload:input,perform:async(client)=>{
        await lockActiveWorkspace(client,input.workspaceId)
        const rows=await client.query<{location_revision:string}>('select location_revision from workspaces where id=$1 for update',[input.workspaceId])
        if (!rows.rows[0] || Number(rows.rows[0].location_revision)!==input.expectedLocationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT','The workspace location changed.',409)
        await client.query('update workspaces set execution_location=null,execution_location_identity=null,location_revision=location_revision+1 where id=$1',[input.workspaceId])
        return {workspaceId:input.workspaceId,executionLocation:null,locationRevision:input.expectedLocationRevision+1}
      }})
  }
  provision(principal:ManagementPrincipal,input:{workspaceId:string;commandId:string;expectedLocationRevision:number}) {
    requireAuthorization(principal,'workspace_locations:provision',{workspaceId:input.workspaceId})
    requireAuthorization(principal,'workspace_locations:update',{workspaceId:input.workspaceId})
    requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    const root=this.provisioningRoot
    if (!root) throw new DomainError('WORKSPACE_PROVISIONING_DISABLED','The server owner has not configured a provisioning root.',503)
    return this.commands.execute({principal,source:'mcp',operation:'workspace.location.provision',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:location`,payload:input,perform:async(client)=>{
        await lockActiveWorkspace(client,input.workspaceId)
        const rows=await client.query<{location_revision:string;execution_location:unknown}>('select location_revision,execution_location from workspaces where id=$1 for update',[input.workspaceId])
        if (!rows.rows[0] || Number(rows.rows[0].location_revision)!==input.expectedLocationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT','The workspace location changed.',409)
        if (rows.rows[0].execution_location) throw new DomainError('LOCATION_ALREADY_CONFIGURED','Provisioning never replaces an existing workspace location. Clear it explicitly first.',409)
        const rootPath=await withFilesystemDeadline((check)=>check(()=>provisionWorkspaceDirectory(root,input.workspaceId)))
        return this.locations.assignProvisioned(client,principal,{...input,runnerId:this.locations.runnerId,rootPath})
      }})
  }
}
