import { readJobComputerSelection } from './computerSelection.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { requireJobPreparationDeadline } from './preparationDeadline.js'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobDefinitionRecordSchema, isAutoJobSpecRecord, type ResolvedJobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { SourceRootRecordSchema, type SourceMaterializationRecord, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { SourceAttemptAuthority } from '../sources/executionHosts.js'
import type { MaterializationAttempt } from '../sources/ports.js'
import { sourceBindingHash } from '../sources/bindingHash.js'
import { DomainError } from '../errors.js'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
import { WorkflowJobPreparationSchema } from './workflowPreparation.js'
import { IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion, type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'

/** Genuine preparation identity is persisted before W09 source I/O. It confers no launch authority. */
export class JobSourceAttemptAuthority implements SourceAttemptAuthority {
  constructor(private readonly pool:pg.Pool,private readonly hostFence:(sql:JobSql,root:SourceRootRecord)=>Promise<void>) {}
  private async allocated(sql:JobSql,executionId:string,attemptId:string,operationId:string,principal?:ManagementPrincipal) {
    const manual=(await sql.query<{principal_id:string;workspace_id:string;definition:unknown;created_at:Date}>('select principal_id,workspace_id,definition,created_at from job_preparations where execution_id=$1 and attempt_id=$2 and operation_id=$3 for share',[executionId,attemptId,operationId])).rows[0]
    if(manual) {
      const actor=await readLiveManagementPrincipal(sql,manual.principal_id)
      if(principal&&principal.id!==actor.id)throw new DomainError('AUTH_INVALID','Source preparation belongs to another job principal.',403)
      requireAuthorization(actor,'jobs:start',{workspaceId:manual.workspace_id})
      const definition=JobDefinitionRecordSchema.parse(manual.definition)
      if(definition.workspaceId!==manual.workspace_id)throw new DomainError('JOB_PREPARATION_PIN_CONFLICT','The saved job preparation scope changed.',409)
      const queued = (await sql.query<{ record: unknown; owner_id: string | null; owner_fence: string | null }>(
        'select record,owner_id,owner_fence from job_admission_queue where execution_id=$1 for share',
        [executionId])).rows[0]
      if (queued) {
        const ticket = JobQueueTicketSchema.parse(queued.record)
        if (ticket.attemptId !== attemptId || ticket.operationId !== operationId
          || ticket.definition.versionId !== definition.versionId || ticket.principalId !== actor.id) {
          throw new DomainError('JOB_PREPARATION_PIN_CONFLICT', 'The queue belongs to another source attempt.', 409)
        }
        if (ticket.state !== 'accepted') {
          if (ticket.state !== 'claimed' || ticket.cancelRequestedAt) {
            throw new DomainError('JOB_PREPARATION_CLOSED', 'This queued source preparation is closed.', 409)
          }
          const owner = (await sql.query(`select 1 from pg_stat_activity a where a.pid::text=$1
            and (extract(epoch from a.backend_start)*1000000)::bigint::text=$2
            and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
              and l.classid=810038::oid and l.objid=(hashtext($3)::bigint & 4294967295)::oid
              and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)`,
          [queued.owner_id, queued.owner_fence, executionId])).rowCount
          if (!owner) throw new DomainError('JOB_OWNERSHIP_LOST', 'The queued source owner disconnected.', 409)
        }
      }
      const current=(await sql.query<{version_id:string}>('select version_id from job_definitions where workspace_id=$1 and id=$2 for share',[manual.workspace_id,definition.id])).rows[0]
      const accepted=(await sql.query('select 1 from job_executions where id=$1',[executionId])).rows.length>0
      if(!queued&&!accepted&&current?.version_id!==definition.versionId)throw new DomainError('REVISION_CONFLICT','The saved job changed before admission.',409)
      if(!accepted&&Date.now()-manual.created_at.getTime()>definition.spec.policy.preparationTimeoutMs)throw new DomainError('JOB_PREPARATION_TIMEOUT','The actual job preparation exceeded its accepted budget.',409)
      return {principal:actor,workspaceId:manual.workspace_id,spec:isAutoJobSpecRecord(definition.spec) ? await readJobComputerSelection(sql, definition, {executionId,attemptId,operationId}) : definition.spec}
    }
    const workflow=(await sql.query<{preparation:unknown}>('select preparation from workflow_job_preparations where preparation->>\'executionId\'=$1 and preparation->>\'attemptId\'=$2 and preparation->>\'operationId\'=$3 for share',[executionId,attemptId,operationId])).rows[0]
    if(!workflow)throw new DomainError('JOB_PREPARATION_MISSING','No actual manual job or Run slot allocated this source attempt.',409)
    const prep=WorkflowJobPreparationSchema.parse(workflow.preparation)
    const row=(await sql.query<{record:unknown;stopped:boolean;cleanup:boolean}>('select record,stop_requested_at is not null stopped,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) cleanup from runs r where id=$1 for share',[prep.runId])).rows[0]
    if(!row)throw new DomainError('RUN_NOT_FOUND','The allocating Run is missing.',404)
    const run=AcceptedWorkflowRunV3Schema.parse(row.record),actor=await readLiveManagementPrincipal(sql,run.authorizationPrincipalId)
    if(principal&&principal.id!==actor.id)throw new DomainError('AUTH_INVALID','Source preparation belongs to another accepted Run principal.',403)
    requireAuthorization(actor,'runs:start',{workspaceId:run.workspaceId,workflowId:run.workflowId,runId:run.id})
    if(!(await sql.query('select 1 from run_authority_principals where principal_id=$1 and run_id=$2 for share',[actor.id,run.id])).rows.length)throw new DomainError('AUTH_INVALID','The job source cannot borrow another Run principal.',403)
    if(run.workflowVersionId!==prep.workflowVersionId||run.workspaceId!==prep.workspaceId||row.stopped||row.cleanup||['completed','interrupted'].includes(run.executionState))throw new DomainError('GRAPH_STOP_CONFLICT','The allocating Run no longer admits this job source attempt.',409)
    const versionRow=(await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3 for share`,[prep.workflowVersionId,prep.workspaceId,prep.workflowId])).rows[0]
    if(!versionRow)throw new DomainError('WORKFLOW_VERSION_NOT_FOUND','The accepted immutable workflow version is missing.',404)
    const version=readImmutableWorkflowVersion(versionRow,{id:prep.workflowVersionId,workspaceId:prep.workspaceId,workflowId:prep.workflowId}),node=version.definition.nodes.find(node=>node.id===prep.nodeId)
    if(node?.kind!=='job')throw new DomainError('JOB_PREPARATION_PIN_CONFLICT','The accepted workflow node is not this job.',409)
    const definition=await new JobRepository().version(sql,run.workspaceId,node.jobDefinitionVersionId,node.jobDefinitionId)
    if(!(await sql.query('select 1 from job_executions where id=$1',[executionId])).rows.length)await requireJobPreparationDeadline(sql,'workflow',executionId,definition.spec.policy.preparationTimeoutMs)
    if(definition.revision!==node.jobDefinitionRevision)throw new DomainError('JOB_VERSION_PIN_CONFLICT','The saved job version differs from the accepted workflow.',409)
    return {principal:actor,workspaceId:run.workspaceId,spec:isAutoJobSpecRecord(definition.spec) ? await readJobComputerSelection(sql, definition, {executionId,attemptId,operationId}) : definition.spec}
  }
  private check(root:SourceRootRecord,spec:ResolvedJobDefinitionSpecRecord) {
    if(canonicalJson(root.source)!==canonicalJson({approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest})
      ||root.binding.accessMode!=='exclusive-write'||canonicalJson(root.selection.hostRef)!==canonicalJson(spec.target.hostRef)||canonicalJson(root.registration)!==canonicalJson(spec.target.registration)
      ||root.attestationId!==spec.target.destination.attestationId||root.attestationDigest!==spec.target.destination.attestationHash
      ||root.selection.rootPolicyId!==spec.target.destination.rootPolicyId||root.selection.rootPolicyRevision!==spec.target.destination.rootPolicyRevision||root.selection.locationRevision!==spec.target.destination.locationRevision)throw new DomainError('JOB_SOURCE_PIN_CONFLICT','Source authority differs from the exact saved job host/root/snapshot.',409)
  }
  async authorize(sql:JobSql,principal:ManagementPrincipal,input:{workspaceId:string;root:SourceRootRecord;attempt:MaterializationAttempt;operationId:string}) {
    const allocated=await this.allocated(sql,input.attempt.executionId,input.attempt.attemptId,input.operationId,principal)
    if(allocated.workspaceId!==input.workspaceId||input.root.binding.workspaceId!==input.workspaceId||sourceBindingHash(input.root,input.attempt,input.operationId)!==input.attempt.placementHash)throw new DomainError('JOB_PREPARATION_PIN_CONFLICT','Source preparation is bound to a different real attempt.',409)
    this.check(input.root,allocated.spec);await this.hostFence(sql,input.root)
  }
  async authorizeFinal(sql:JobSql,principal:ManagementPrincipal,record:SourceMaterializationRecord,hash:string) {
    const execution=await new JobRepository().execution(sql,record.receipt.binding.workspaceId,record.receipt.executionId)
    const intentRow=(await sql.query<{intent:unknown}>('select intent from job_dispatch_intents where execution_id=$1 for share',[execution.id])).rows[0]
    const intent=RemoteJobDispatchIntentSchema.parse(intentRow?.intent)
    if(execution.attemptId!==record.receipt.attemptId||execution.operationId!==record.operationId||execution.acceptedSpec.source.materializationId!==record.receipt.materializationId||execution.acceptedSpec.bindingHash!==hash
      ||intent.attemptId!==execution.attemptId||intent.operationId!==execution.operationId||intent.bindingHash!==hash||intent.owner.grantId!==execution.owner.grantId||intent.owner.epoch!==execution.owner.epoch)throw new DomainError('JOB_DISPATCH_PIN_CONFLICT','Only the original persisted job and W08 intent can adopt this prepared source.',409)
    const rootRow=(await sql.query<{record:unknown}>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',[record.receipt.binding.rootId,record.receipt.binding.bindingRevision])).rows[0]
    await this.authorize(sql,principal,{workspaceId:execution.workspaceId,root:SourceRootRecordSchema.parse(rootRow?.record),attempt:record.receipt,operationId:record.operationId})
  }
  private async read<T>(work:(sql:JobSql)=>Promise<T>) {
    return withTransaction(this.pool, work)
  }
  revalidate(root:SourceRootRecord,attempt:MaterializationAttempt) {
    return this.read(async sql=>{
      const operation=(await sql.query<{operation_id:string}>(`select operation_id from job_preparations where execution_id=$1 and attempt_id=$2 union all select preparation->>'operationId' from workflow_job_preparations where preparation->>'executionId'=$1 and preparation->>'attemptId'=$2`,[attempt.executionId,attempt.attemptId])).rows
      if(operation.length!==1)throw new DomainError('JOB_PREPARATION_MISSING','The original preparation operation is missing or ambiguous.',409)
      const allocated=await this.allocated(sql,attempt.executionId,attempt.attemptId,operation[0]!.operation_id)
      await this.authorize(sql,allocated.principal,{workspaceId:allocated.workspaceId,root,attempt,operationId:operation[0]!.operation_id})
    })
  }
  revalidateMaterialization(record:SourceMaterializationRecord) {
    return this.read(async sql=>{
      const allocated=await this.allocated(sql,record.receipt.executionId,record.receipt.attemptId,record.operationId)
      const row=(await sql.query<{record:unknown}>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',[record.receipt.binding.rootId,record.receipt.binding.bindingRevision])).rows[0]
        await this.authorize(sql,allocated.principal,{workspaceId:allocated.workspaceId,root:SourceRootRecordSchema.parse(row?.record),attempt:record.receipt,operationId:record.operationId})
      if(record.finalDispatchBindingHash)await this.authorizeFinal(sql,allocated.principal,record,record.finalDispatchBindingHash)
    })
  }
}
