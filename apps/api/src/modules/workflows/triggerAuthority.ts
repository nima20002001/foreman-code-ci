import type pg from 'pg'
import { RunInputSchema, type RunInput } from '@foreman-code/contracts'
import { type ManagementPrincipal } from '@foreman-code/contracts/management'
import { z } from 'zod'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

export const TriggerJobPayloadSchema=z.object({
  mode:z.enum(['schedule','event']),workflowVersionId:z.string().min(1),
  executionSemanticsVersion:z.literal(2).optional(),
  expectedLocationRevision:z.number().int().nonnegative(),input:RunInputSchema,
}).strict()

/** Re-read every delegated ancestor. A saved schedule is not a durable privilege grant. */
export async function readTriggerAuthority(client:Pick<pg.ClientBase,'query'>,principalId:string,resource:{workspaceId:string;workflowId:string},mode:'schedule'|'event'):Promise<ManagementPrincipal> {
  const principal=await readLiveManagementPrincipal(client,principalId)
  requireAuthorization(principal,'runs:start',resource)
  requireAuthorization(principal,'workspace_locations:read',{workspaceId:resource.workspaceId})
  requireAuthorization(principal,mode==='schedule'?'workflow_triggers:update':'workflow_triggers:fire',resource)
  return principal
}

/** Called under Run admission's workspace lock, before a Run or receipt is created. */
export async function assertTriggerDispatch(client:pg.PoolClient,principal:ManagementPrincipal,input:{
  workspaceId:string;workflowId:string;workflowVersionId:string;executionSemanticsVersion?:2;
  expectedLocationRevision:number;input:RunInput;triggerJobId:string;
}):Promise<void> {
  const rows=await client.query<{workspace_id:string;workflow_id:string;principal_id:string;payload:unknown;trigger_revision:string;revision:string;enabled:boolean;status:string;lease_valid:boolean}>(
    `select j.workspace_id,j.workflow_id,j.principal_id,j.payload,j.trigger_revision,t.revision,t.enabled,j.status,
       j.lease_expires_at>now() as lease_valid from workflow_trigger_jobs j join workflow_triggers t on t.workflow_id=j.workflow_id
     where j.id=$1 for share of j,t`,[input.triggerJobId],
  )
  const row=rows.rows[0]
  if (!row || row.workspace_id!==input.workspaceId || row.workflow_id!==input.workflowId || row.principal_id!==principal.id
    || !row.enabled || row.trigger_revision!==row.revision || row.status!=='leased' || !row.lease_valid) {
    throw new DomainError('TRIGGER_CHANGED','The trigger was disabled, changed, or lost its dispatch lease.',409)
  }
  const payload=TriggerJobPayloadSchema.parse(row.payload)
  if (payload.workflowVersionId!==input.workflowVersionId
    || payload.executionSemanticsVersion!==input.executionSemanticsVersion
    || payload.expectedLocationRevision!==input.expectedLocationRevision
    || commandInputHash(payload.input)!==commandInputHash(input.input)) throw new DomainError('TRIGGER_JOB_MISMATCH','The dispatch differs from its accepted job.',409)
  await readTriggerAuthority(client,principal.id,{workspaceId:input.workspaceId,workflowId:input.workflowId},payload.mode)
}
