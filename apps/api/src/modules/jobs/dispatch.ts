import { readRunJobCleanup,requestRunJobCleanup } from './runCleanup.js'
import type { JobRunCleanup } from '@foreman-code/contracts/job-run-cleanup'
import type { RunOwnership } from '../runs/ownership.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  RemoteJobDispatchIntentSchema,
  RemoteJobOperationReceiptRecordSchema,
  type RemoteJobDispatchRecordPort,
  type RemoteJobOperationReceiptRecord,
  type RemoteJobOperationStatusRecord,
} from '@foreman-code/contracts/remote-job-execution'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { JobExecutionRecordSchema, type JobAcceptedSpecRecord, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { JobOwnership } from './ownership.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
import type { JobDispatchPort } from './ports.js'
import type { JobRuntimeAuthority } from './authority.js'
import type { JobWorkerFence } from './worker.js'

export interface JobDispatchHost {
  /** Actual W07 registration/boot/current connection and W09 source/root qualification. */
  revalidate(sql:JobSql,execution:JobExecutionRecord,principal:ManagementPrincipal,
    options?: { requireQualification: boolean }):Promise<void>
  authorizeControl(sql:JobSql,execution:JobExecutionRecord,principal:ManagementPrincipal):Promise<void>
  authorizeLaunch?(sql:JobSql,execution:JobExecutionRecord):Promise<void>
  observe(sql:JobSql,execution:JobExecutionRecord,receipt:RemoteJobOperationReceiptRecord):Promise<void>
  settleSource?(executionId: string): Promise<void>
  capacityChanged?(): void
  prepareWaiting?(executionId: string): Promise<void>
  refreshRuntime?(executionId: string): Promise<void>
}
/** Durable job intent is consumed by the same W08 carrier/journal, never a new scheduler. */
export class PostgresJobDispatch implements JobDispatchPort,JobRuntimeAuthority {
  private readonly repository=new JobRepository()
  private readonly owners=new Map<string,{owner:JobOwnership;abort:AbortController;pendingRequests:number;settlementRequested:boolean}>()
  constructor(private readonly pool: pg.Pool, private readonly remote: RemoteJobDispatchRecordPort,
    private readonly host: JobDispatchHost,
    private readonly workerExecution = new WorkerExecutionPolicy()) {}
  async accept(sql:JobSql,input:{workspaceId:string;executionId:string;attemptId:string;operationId:string;spec:JobAcceptedSpecRecord;workflow:JobExecutionRecord['workflow'];principal:ManagementPrincipal}) {
    this.workerExecution.requireEnabled(input.spec.target.hostRef)
    const intent=RemoteJobDispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:input.spec.target.mainId,
      subject:input.workflow?{kind:'workflow-node',workspaceId:input.workspaceId,...input.workflow}:{kind:'manual-job',workspaceId:input.workspaceId,jobExecutionId:input.executionId,definitionId:input.spec.definitionId},
      executionId:input.executionId,attemptId:input.attemptId,operationId:input.operationId,bindingHash:input.spec.bindingHash,inputDigest:`sha256:${input.spec.specDigest}`,owner:{grantId:randomUUID(),epoch:'1'},
      ...(input.spec.resourcePolicyRevision !== undefined ? { resourcePolicyRevision: input.spec.resourcePolicyRevision,
        resourcePolicyDigest: input.spec.resourcePolicyDigest, runtimeApprovalId: input.spec.runtimeApprovalId,
        runtimeApprovalRevision: input.spec.runtimeApprovalRevision } : {})})
    await sql.query('insert into job_dispatch_intents(execution_id,workspace_id,intent) values($1,$2,$3::jsonb)',[input.executionId,input.workspaceId,JSON.stringify(intent)])
    return {operationId:intent.operationId,attemptId:intent.attemptId,owner:intent.owner}
  }
  async cancel(sql:JobSql,execution:JobExecutionRecord,commandId:string,principal:ManagementPrincipal,action:'jobs:cancel'|'runs:stop'='jobs:cancel'):Promise<void> {
    await sql.query('update job_dispatch_intents set cancel_command_id=coalesce(cancel_command_id,$2),cancel_principal_id=coalesce(cancel_principal_id,$3),cancel_action=coalesce(cancel_action,$4) where execution_id=$1',[execution.id,commandId,principal.id,action])
  }
  cancelForRunCleanup(sql:GraphTransactionSql,execution:JobExecutionRecord,owner:RunOwnership,reason:JobRunCleanup['reason']) {return requestRunJobCleanup(sql,execution,owner,reason)}
  /** The accepted Run association is immutable. Acquire Run before Job, as workflow polling does. */
  private async readExecutionLocked(sql:JobSql,workspaceId:string,executionId:string):Promise<JobExecutionRecord> {
    const accepted=await this.repository.execution(sql,workspaceId,executionId)
    if(accepted.workflow)await sql.query('select id from runs where id=$1 for share',[accepted.workflow.runId])
    return this.repository.execution(sql,workspaceId,executionId,true)
  }
  private async requireOwner(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence):Promise<void> {
    const row=(await sql.query<{intent:unknown;owner_id:string|null;owner_fence:string|null}>('select intent,owner_id,owner_fence from job_dispatch_intents where execution_id=$1 for share',[execution.id])).rows[0]
    if(!row)throw new DomainError('JOB_DISPATCH_MISSING','The accepted W08 job dispatch intent is missing.',409)
    const intent=RemoteJobDispatchIntentSchema.parse(row.intent)
    if(intent.executionId!==execution.id||intent.operationId!==execution.operationId||intent.mainId!==execution.acceptedSpec.target.mainId||intent.subject.workspaceId!==execution.workspaceId||intent.inputDigest!==`sha256:${execution.acceptedSpec.specDigest}`||intent.attemptId!==fence.attemptId||intent.owner.grantId!==fence.owner.grantId||intent.owner.epoch!==fence.owner.epoch||intent.bindingHash!==execution.acceptedSpec.bindingHash||!row.owner_id||!row.owner_fence)throw new DomainError('JOB_OWNER_FENCE_INVALID','The accepted job owner/attempt binding is not live.',409)
    const live=(await sql.query(`select 1 from pg_stat_activity a where a.pid::text=$1 and (extract(epoch from a.backend_start)*1000000)::bigint::text=$2 and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=810038::oid and l.objid=(hashtext($3)::bigint & 4294967295)::oid and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)`,[row.owner_id,row.owner_fence,execution.id])).rows.length
    if(!live)throw new DomainError('JOB_OWNERSHIP_LOST','The original main job owner session is no longer live.',409)
  }
  /** Launch/publication never borrow committed cleanup stop authority. */
  async require(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence,
    options?: { requireQualification: boolean }):Promise<void> {
    await this.requireOwner(sql,execution,fence)
    if(await readRunJobCleanup(sql,execution))throw new DomainError('JOB_CLEANUP_ONLY','The original Run owner admitted stop/closure only, not launch or publication.',409)
    const accepted=(await sql.query<{accepted_by:string;cancel_principal_id:string|null;cancel_action:'jobs:cancel'|'runs:stop'|null}>(`select e.accepted_by,d.cancel_principal_id,d.cancel_action from job_executions e join job_dispatch_intents d on d.execution_id=e.id where e.id=$1`,[execution.id])).rows[0]!
    const principal=await readLiveManagementPrincipal(sql,accepted.cancel_principal_id??accepted.accepted_by)
    requireAuthorization(principal,accepted.cancel_principal_id?accepted.cancel_action!:execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
    if(accepted.cancel_principal_id)await this.host.authorizeControl(sql,execution,principal)
    else await this.host.revalidate(sql,execution,principal,options)
  }
  async requireControl(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence):Promise<void> {
    await this.requireOwner(sql,execution,fence)
    if(await readRunJobCleanup(sql,execution))return
    await this.require(sql,execution,fence)
  }
  async requireLaunch(sql: JobSql, execution: JobExecutionRecord, fence: JobWorkerFence): Promise<void> {
    await this.require(sql, execution, fence, { requireQualification: true })
    await this.host.authorizeLaunch?.(sql, execution)
  }
  /** Only trusted carrier receipt ingress uses this. No file write/read capability. */
  async requireEvidence(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence):Promise<void> {return this.requireControl(sql,execution,fence)}
  async wake(executionId:string):Promise<void> {
    if (this.host.prepareWaiting) {
      const waiting = (await this.pool.query(`select 1 from job_admission_queue q where execution_id=$1
        and q.record->>'state' in ('waiting','blocked','claimed')
        and not exists(select 1 from job_executions e where e.id=q.execution_id)`, [executionId])).rowCount
      if (waiting) {
        await this.host.prepareWaiting(executionId)
        return
      }
    }
    let active=this.owners.get(executionId)
    if(!active) {
      const abort=new AbortController(),owner=await JobOwnership.acquire(this.pool,executionId,()=>abort.abort())
      if(!owner)return
      active={owner,abort,pendingRequests:0,settlementRequested:false};this.owners.set(executionId,active)
    }
    const {owner,abort}=active
    active.pendingRequests++
    try {
      const closedBeforeDelivery = await this.closeUndelivered(owner, executionId)
      if (closedBeforeDelivery) {
        await this.settle(executionId)
        return
      }
      const launchable = (await this.pool.query(`select 1 from job_dispatch_intents
        where execution_id=$1 and not delivery_attempted and cancel_command_id is null`, [executionId])).rowCount
      if (launchable) await this.host.refreshRuntime?.(executionId)
      const prepared=await owner.connection.transaction(async sql=>{
        const scope=(await sql.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
        if(!scope)throw new DomainError('JOB_NOT_FOUND','The accepted job is missing.',404)
        const execution=await this.readExecutionLocked(sql,scope.workspace_id,executionId)
        const row=(await sql.query<{intent:unknown;delivery_attempted:boolean;cancel_command_id:string|null;cancel_principal_id:string|null;cancel_action:'jobs:cancel'|'runs:stop'|null}>('select intent,delivery_attempted,cancel_command_id,cancel_principal_id,cancel_action from job_dispatch_intents where execution_id=$1 for update',[executionId])).rows[0]!
        if (execution.process.phase === 'terminal' && execution.process.processStopped
          && !['pending', 'collecting'].includes(execution.publication)) {
          const fence = await owner.readFence(sql)
          await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1',
            [executionId, fence.ownerId, fence.fence])
          beforeGraphCommit(sql, () => this.requireOwner(sql, execution,
            { attemptId: execution.attemptId, owner: execution.owner }))
          return { execution, intent: RemoteJobDispatchIntentSchema.parse(row.intent),
            action: 'none' as const, cancelCommandId: row.cancel_command_id }
        }
        const accepted=(await sql.query<{accepted_by:string}>('select accepted_by from job_executions where id=$1',[executionId])).rows[0]!
        const cleanup=await readRunJobCleanup(sql,execution)
        if(!cleanup) {
          const principal=await readLiveManagementPrincipal(sql,row.cancel_command_id?row.cancel_principal_id!:accepted.accepted_by)
          requireAuthorization(principal,row.cancel_command_id?row.cancel_action!:execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
          if(row.cancel_command_id)await this.host.authorizeControl(sql,execution,principal)
          else await this.host.revalidate(sql,execution,principal,
            { requireQualification: !row.delivery_attempted })
        }
        const fence=await owner.readFence(sql)
        await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1',[executionId,fence.ownerId,fence.fence])
        beforeGraphCommit(sql,()=>cleanup?this.requireControl(sql,execution,{attemptId:execution.attemptId,owner:execution.owner}):this.require(sql,execution,{attemptId:execution.attemptId,owner:execution.owner},
          { requireQualification: !row.delivery_attempted && !row.cancel_command_id && execution.process.phase !== 'terminal' }))
        if(row.cancel_command_id&&!row.delivery_attempted) {
          execution.process={phase:'terminal',outcome:'cancelled',exitCode:null,signal:null,processStopped:true};execution.finishedAt=new Date().toISOString();execution.publication='complete';execution.updatedAt=execution.finishedAt
          await this.repository.putExecution(sql,execution)
          return {execution,intent:RemoteJobDispatchIntentSchema.parse(row.intent),action:'none' as const,cancelCommandId:row.cancel_command_id}
        }
        if (!row.delivery_attempted) {
          this.workerExecution.requireEnabled(execution.acceptedSpec.target.hostRef)
          try { await this.host.authorizeLaunch?.(sql, execution) } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'BUILD_COMPUTER_DISABLED') throw error
            execution.process = { phase: 'terminal', outcome: 'preparation_failed', exitCode: null,
              signal: null, processStopped: true }
            execution.finishedAt = new Date().toISOString()
            execution.updatedAt = execution.finishedAt
            execution.publication = 'complete'
            execution.launchIssue = 'build_disabled'
            await sql.query("update job_dispatch_intents set launch_blocked_reason='build_disabled' where execution_id=$1", [executionId])
            await this.repository.putExecution(sql, execution)
            return { execution, intent: RemoteJobDispatchIntentSchema.parse(row.intent),
              action: 'none' as const, cancelCommandId: row.cancel_command_id }
          }
        }
        await sql.query('update job_dispatch_intents set delivery_attempted=true where execution_id=$1',[executionId])
        return {execution,intent:RemoteJobDispatchIntentSchema.parse(row.intent),action:row.delivery_attempted?'reconcile' as const:'deliver' as const,cancelCommandId:row.cancel_command_id}
      })
      if(prepared.action==='none') {await this.settle(executionId);return}
      abort.signal.throwIfAborted();owner.assertOwned()
      let status: RemoteJobOperationStatusRecord
      if (prepared.cancelCommandId && prepared.execution.process.phase !== 'terminal') {
        status = await this.remote.control({ schemaVersion: 1, protocolVersion: 1,
          commandId: prepared.cancelCommandId, operationId: prepared.intent.operationId,
          attemptId: prepared.intent.attemptId, executionId, subject: prepared.intent.subject,
          bindingHash: prepared.intent.bindingHash, owner: prepared.intent.owner, action: { kind: 'stop' } })
      } else {
        status = prepared.action === 'deliver'
          ? await this.remote.deliver(prepared.intent, prepared.execution)
          : await this.remote.reconcile(prepared.intent)
      }
      owner.assertOwned()
      const finished=await owner.connection.transaction(async sql=>{
        const execution=await this.readExecutionLocked(sql,prepared.execution.workspaceId,executionId)
        await this.requireEvidence(sql,execution,{attemptId:execution.attemptId,owner:execution.owner})
        beforeGraphCommit(sql,()=>this.requireControl(sql,execution,{attemptId:execution.attemptId,owner:execution.owner}))
        if(status.status==='known'&&await this.acceptReceipt(sql,execution,status.receipt))await this.host.observe(sql,execution,status.receipt)
        else {execution.transport='unknown';execution.updatedAt=new Date().toISOString();await this.repository.putExecution(sql,execution)}
        const current=await this.repository.execution(sql,prepared.execution.workspaceId,executionId)
        return current.process.phase==='terminal'&&!['pending','collecting'].includes(current.publication)
      })
      if(finished)await this.settle(executionId)
      if(status.status==='unknown')throw new DomainError('JOB_DISPATCH_PENDING','The original Worker journal has not confirmed this Job. Read its persisted state and retry the original command; absence does not prove nonexecution or cancellation closure.',503,
        {retryable:true,executionId,attemptId:prepared.intent.attemptId,operationId:prepared.intent.operationId})
    } catch(error) {
      if(abort.signal.aborted)await this.release(executionId)
      throw error
    } finally {
      active.pendingRequests--
      if (active.pendingRequests === 0 && active.settlementRequested && this.owners.get(executionId) === active) {
        await this.settle(executionId)
      }
    }
  }
  private async closeUndelivered(owner: JobOwnership, executionId: string): Promise<boolean> {
    return owner.connection.transaction(async sql => {
      const scope = (await sql.query<{ workspace_id: string }>(
        'select workspace_id from job_executions where id=$1', [executionId])).rows[0]
      if (!scope) throw new DomainError('JOB_NOT_FOUND', 'The accepted Job is missing.', 404)
      const execution = await this.readExecutionLocked(sql, scope.workspace_id, executionId)
      const row = (await sql.query<{ delivery_attempted: boolean; cancel_command_id: string | null }>(
        'select delivery_attempted,cancel_command_id from job_dispatch_intents where execution_id=$1 for update',
        [executionId])).rows[0]!
      const fence = await owner.readFence(sql)
      await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1',
        [executionId, fence.ownerId, fence.fence])
      if (execution.process.phase === 'terminal') {
        return execution.process.processStopped && !['pending', 'collecting'].includes(execution.publication)
      }
      if (row.delivery_attempted) return false
      let outcome: 'cancelled' | 'preparation_failed' = 'cancelled'
      if (!row.cancel_command_id) {
        try {
          await this.host.authorizeLaunch?.(sql, execution)
          return false
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'BUILD_COMPUTER_DISABLED') throw error
          outcome = 'preparation_failed'
          execution.launchIssue = 'build_disabled'
          await sql.query("update job_dispatch_intents set launch_blocked_reason='build_disabled' where execution_id=$1",
            [executionId])
        }
      }
      if (row.cancel_command_id) await this.requireControl(sql, execution,
        { attemptId: execution.attemptId, owner: execution.owner })
      beforeGraphCommit(sql, () => this.requireOwner(sql, execution,
        { attemptId: execution.attemptId, owner: execution.owner }))
      execution.process = { phase: 'terminal', outcome, exitCode: null, signal: null, processStopped: true }
      execution.finishedAt = new Date().toISOString()
      execution.updatedAt = execution.finishedAt
      execution.publication = 'complete'
      await this.repository.putExecution(sql, execution)
      return true
    })
  }
  /** W07/W08 validated receipt ingress. Retains the original main owner across asynchronous work. */
  async observeReceipt(workspaceId:string,executionId:string,receipt:RemoteJobOperationReceiptRecord):Promise<void> {
    const active=this.owners.get(executionId)
    if(!active)throw new DomainError('JOB_RECONCILIATION_REQUIRED','Acquire the original job owner and reconcile its journal before accepting a receipt.',409)
    active.owner.assertOwned()
    const terminal=await active.owner.connection.transaction(async sql=>{
      const execution=await this.readExecutionLocked(sql,workspaceId,executionId)
      await this.requireEvidence(sql,execution,{attemptId:receipt.intent.attemptId,owner:receipt.intent.owner})
      beforeGraphCommit(sql,()=>this.requireEvidence(sql,execution,{attemptId:receipt.intent.attemptId,owner:receipt.intent.owner}))
      if(await this.acceptReceipt(sql,execution,receipt))await this.host.observe(sql,execution,receipt)
      const current=await this.repository.execution(sql,workspaceId,executionId)
      return current.process.phase==='terminal'&&!['pending','collecting'].includes(current.publication)
    })
    if(terminal)await this.settle(executionId)
  }
  async importCancellationClosure(workspaceId: string, executionId: string, receipt: RemoteJobOperationReceiptRecord,
    authorizeAndRelease: (sql: GraphTransactionSql, execution: JobExecutionRecord) => Promise<void>): Promise<void> {
    let active = this.owners.get(executionId)
    if (!active) {
      const abort = new AbortController()
      const owner = await JobOwnership.acquire(this.pool, executionId, () => abort.abort())
      if (!owner) throw new DomainError('JOB_RECOVERY_OWNER_BUSY', 'The original Job owner is still active.', 409)
      active = { owner, abort, pendingRequests: 0, settlementRequested: false }
      this.owners.set(executionId, active)
    }
    try {
      await active.owner.connection.transaction(async sql => {
        const execution = await this.readExecutionLocked(sql, workspaceId, executionId)
        const fence = await active!.owner.readFence(sql)
        await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1',
          [executionId, fence.ownerId, fence.fence])
        await this.requireOwner(sql, execution, { attemptId: execution.attemptId, owner: execution.owner })
        await authorizeAndRelease(sql, execution)
        if (await this.acceptReceipt(sql, execution, receipt)) {
          const transport = execution.transport
          await this.host.observe(sql, execution, receipt)
          execution.transport = transport
          await this.repository.putExecution(sql, execution)
        }
      })
    } finally {
      await this.release(executionId)
    }
  }
  private async acceptReceipt(sql:JobSql,execution:JobExecutionRecord,receipt:RemoteJobOperationReceiptRecord):Promise<boolean> {
    receipt=RemoteJobOperationReceiptRecordSchema.parse(receipt)
    const row=(await sql.query<{intent:unknown;receipt_sequence:string;last_receipt:unknown}>('select intent,receipt_sequence::text,last_receipt from job_dispatch_intents where execution_id=$1 for update',[execution.id])).rows[0]!
    if(canonicalJson(row.intent)!==canonicalJson(receipt.intent))throw new DomainError('JOB_RECEIPT_PIN_CONFLICT','Remote receipt does not match the accepted operation/attempt/subject.',409)
    if(row.last_receipt) {
      const previous=RemoteJobOperationReceiptRecordSchema.parse(row.last_receipt)
      if(canonicalJson(previous.connection)!==canonicalJson(receipt.connection)||previous.workerIncarnationId!==receipt.workerIncarnationId)throw new DomainError('JOB_RECEIPT_IDENTITY_CONFLICT','Original worker receipt identity cannot change during recovery.',409)
      if(previous.native && (!receipt.native||previous.native.containerId!==receipt.native.containerId||previous.native.supervisorIdentity!==receipt.native.supervisorIdentity||previous.native.processIdentityDigest!==receipt.native.processIdentityDigest||previous.native.startedAt!==receipt.native.startedAt))throw new DomainError('JOB_NATIVE_IDENTITY_CONFLICT','Original supervised container/process identity cannot change.',409)
      if(previous.terminal && (!receipt.terminal||previous.terminal.outcome!==receipt.terminal.outcome||previous.terminal.exitCode!==receipt.terminal.exitCode||previous.terminal.signal!==receipt.terminal.signal||previous.terminal.finishedAt!==receipt.terminal.finishedAt||previous.terminal.closureEvidenceDigest!==receipt.terminal.closureEvidenceDigest))throw new DomainError('JOB_TERMINAL_CONFLICT','Original observed process closure cannot change.',409)
    }
    if(receipt.sequence<=Number(row.receipt_sequence)) {
      if(receipt.sequence===Number(row.receipt_sequence)&&canonicalJson(receipt)===canonicalJson(row.last_receipt))return false
      throw new DomainError('JOB_RECEIPT_STALE','Remote receipt is stale or conflicts with an acknowledged sequence.',409)
    }
    await sql.query('update job_dispatch_intents set receipt_sequence=$2,last_receipt=$3::jsonb where execution_id=$1',[execution.id,receipt.sequence,JSON.stringify(receipt)])
    return true
  }
  /** SQL-only accepted closure evidence; never contacts a worker or acquires execution authority. */
  async readAcceptedNonEntryClosure(sql: JobSql, input: {
    workspaceId: string; executionId: string; attemptId: string; operationId: string;
    bindingHash: string; owner: JobExecutionRecord['owner']
  }): Promise<boolean> {
    const row = (await sql.query<{
      record: unknown; accepted_spec: unknown; intent: unknown; delivery_attempted: boolean;
      last_receipt: unknown; cancel_command_id: string | null; launch_blocked_reason: string | null;
    }>(`select e.record,e.accepted_spec,d.intent,d.delivery_attempted,d.last_receipt,
        d.cancel_command_id,d.launch_blocked_reason
      from job_executions e join job_dispatch_intents d
        on d.execution_id=e.id and d.workspace_id=e.workspace_id
      where e.workspace_id=$1 and e.id=$2 and e.attempt_id=$3 and e.operation_id=$4
      for share of e,d`,
    [input.workspaceId, input.executionId, input.attemptId, input.operationId])).rows[0]
    if (!row || row.delivery_attempted || row.last_receipt) return false
    const execution = JobExecutionRecordSchema.parse(row.record)
    const intent = RemoteJobDispatchIntentSchema.parse(row.intent)
    const subject = execution.workflow
      ? { kind: 'workflow-node', workspaceId: execution.workspaceId, ...execution.workflow }
      : { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id,
        definitionId: execution.acceptedSpec.definitionId }
    if (execution.id !== input.executionId || execution.workspaceId !== input.workspaceId
      || execution.attemptId !== input.attemptId || execution.operationId !== input.operationId
      || execution.acceptedSpec.bindingHash !== input.bindingHash || canonicalJson(execution.owner) !== canonicalJson(input.owner)
      || canonicalJson(execution.acceptedSpec) !== canonicalJson(row.accepted_spec)
      || intent.executionId !== execution.id || intent.attemptId !== execution.attemptId
      || intent.operationId !== execution.operationId || intent.bindingHash !== input.bindingHash
      || intent.inputDigest !== `sha256:${execution.acceptedSpec.specDigest}`
      || intent.mainId !== execution.acceptedSpec.target.mainId
      || canonicalJson(intent.subject) !== canonicalJson(subject) || canonicalJson(intent.owner) !== canonicalJson(execution.owner)) {
      throw new DomainError('JOB_CLOSURE_PIN_CONFLICT', 'Non-entry closure differs from the accepted Job attempt.', 409)
    }
    if (execution.process.phase !== 'terminal' || !execution.process.processStopped
      || execution.publication !== 'complete' || execution.startedAt !== null || !execution.finishedAt) return false
    // The Job lock and live owner fence commit terminal state before any carrier call.
    return (execution.process.outcome === 'cancelled' && row.cancel_command_id !== null)
      || (execution.process.outcome === 'preparation_failed' && row.launch_blocked_reason === 'build_disabled')
  }

  /** SQL-only accepted closure evidence; never contacts a worker or acquires execution authority. */
  async readAcceptedClosureReceipt(sql:JobSql,input:{workspaceId:string;executionId:string;attemptId:string;operationId:string;bindingHash:string;owner:JobExecutionRecord['owner']}):Promise<RemoteJobOperationReceiptRecord|null> {
    const row=(await sql.query<{record:unknown;accepted_spec:unknown;intent:unknown;last_receipt:unknown;receipt_sequence:string}>(`select e.record,e.accepted_spec,d.intent,d.last_receipt,d.receipt_sequence::text
      from job_executions e join job_dispatch_intents d on d.execution_id=e.id and d.workspace_id=e.workspace_id
      where e.workspace_id=$1 and e.id=$2 and e.attempt_id=$3 and e.operation_id=$4
        and d.intent->>'bindingHash'=$5 and d.intent #>> '{owner,grantId}'=$6 and d.intent #>> '{owner,epoch}'=$7
      for share of e,d`,[input.workspaceId,input.executionId,input.attemptId,input.operationId,input.bindingHash,input.owner.grantId,input.owner.epoch])).rows[0]
    if(!row||!row.last_receipt)return null
    const execution=JobExecutionRecordSchema.parse(row.record),intent=RemoteJobDispatchIntentSchema.parse(row.intent),receipt=RemoteJobOperationReceiptRecordSchema.parse(row.last_receipt)
    const subject=execution.workflow?{kind:'workflow-node',workspaceId:execution.workspaceId,...execution.workflow}
      :{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId}
    if(execution.workspaceId!==input.workspaceId||execution.id!==input.executionId||execution.attemptId!==input.attemptId||execution.operationId!==input.operationId
      ||execution.acceptedSpec.bindingHash!==input.bindingHash||canonicalJson(execution.owner)!==canonicalJson(input.owner)
      ||canonicalJson(execution.acceptedSpec)!==canonicalJson(row.accepted_spec)||canonicalJson(receipt.execution.acceptedSpec)!==canonicalJson(execution.acceptedSpec)
      ||intent.executionId!==execution.id||intent.attemptId!==execution.attemptId||intent.operationId!==execution.operationId
      ||intent.bindingHash!==execution.acceptedSpec.bindingHash||intent.inputDigest!==`sha256:${execution.acceptedSpec.specDigest}`
      ||intent.mainId!==execution.acceptedSpec.target.mainId||canonicalJson(intent.subject)!==canonicalJson(subject)||canonicalJson(intent.owner)!==canonicalJson(execution.owner)
      ||canonicalJson(receipt.intent)!==canonicalJson(intent)||receipt.sequence!==Number(row.receipt_sequence)) {
      throw new DomainError('JOB_CLOSURE_PIN_CONFLICT','Closure receipt does not match the exact accepted job intent and main projection.',409)
    }
    if(receipt.phase!=='confirmed_terminal'||!receipt.terminal?.processStopped||execution.process.phase!=='terminal'||!execution.process.processStopped)return null
    const terminal=receipt.terminal,target=execution.acceptedSpec.target,connection=receipt.connection
    if(execution.finishedAt!==terminal.finishedAt||execution.process.outcome!==terminal.outcome||execution.process.exitCode!==terminal.exitCode||execution.process.signal!==terminal.signal
      ||connection.mainId!==target.mainId||receipt.execution.id!==execution.id||receipt.execution.workspaceId!==execution.workspaceId
      ||receipt.execution.operationId!==execution.operationId||receipt.execution.attemptId!==execution.attemptId||canonicalJson(receipt.execution.owner)!==canonicalJson(execution.owner)
      ||(receipt.entryAttempted?!receipt.native:receipt.native!==undefined||!['cancelled','preparation_failed','spawn_failed'].includes(terminal.outcome))) {
      throw new DomainError('JOB_CLOSURE_EVIDENCE_CONFLICT','Original physical closure is inconsistent with the accepted main execution.',409)
    }
    if(target.hostRef.kind==='device') {
      if(!('deviceId' in connection)||connection.deviceId!==target.hostRef.deviceId||connection.workerInstallationId!==target.registration?.workerInstallationId
        ||connection.keyRevision!==target.registration.keyRevision||connection.authorizationRevision!==target.registration.authorizationRevision) {
        throw new DomainError('JOB_CLOSURE_HOST_CONFLICT','Closure belongs to a different accepted worker identity.',409)
      }
    } else if(!('kind' in connection)||connection.kind!=='main'||connection.mainInstallationId!==target.mainInstallationId) {
      throw new DomainError('JOB_CLOSURE_HOST_CONFLICT','Closure belongs to a different accepted main installation.',409)
    }
    return receipt
  }
  private async settle(executionId: string): Promise<void> {
    const active = this.owners.get(executionId)
    // Receipt ingress may complete while the original dispatch RPC is still returning.
    if (active && active.pendingRequests > 0) {
      active.settlementRequested = true
      return
    }
    await this.host.settleSource?.(executionId)
    await this.release(executionId)
    this.host.capacityChanged?.()
  }
  private async release(executionId:string) {const active=this.owners.get(executionId);if(!active)return;this.owners.delete(executionId);await active.owner.release()}
  async close():Promise<void> {await Promise.allSettled([...this.owners.keys()].map(id=>this.release(id)))}
}
