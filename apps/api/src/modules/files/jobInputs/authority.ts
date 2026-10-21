import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { FileScopeSchema, fileStateAt, type FileWithRevision } from '@foreman-code/contracts/files'
import { JobInputEntrySchema, type JobInputEntry } from '@foreman-code/contracts/job-inputs'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresJobDispatch } from '../../jobs/dispatch.js'
import { JobRepository, type JobSql } from '../../jobs/repository.js'
import { PostgresFileReferenceAuthorization } from '../references/authorization.js'
import { PostgresFileRepository } from '../postgres.js'
import type { StoredFile } from '../repository.js'
import { DomainError } from '../../errors.js'
import { repeatDigest } from '../../runs/repeatResolution.js'
import { artifactPins, ensureDistinct, inputHash, workflowPins } from './manifest.js'
export class JobInputAuthority {
  private readonly jobs=new JobRepository()
  readonly files:PostgresFileRepository
  constructor(private readonly pool:pg.Pool,private readonly runtime:Pick<PostgresJobDispatch, 'require'>,
    private readonly clock:()=>Date=()=>new Date()){this.files=new PostgresFileRepository(pool)}
  async recipient(sql: JobSql, expected: JobExecutionRecord) {
    const current = await this.jobs.execution(sql, expected.workspaceId, expected.id, true)
    const changed = current.attemptId !== expected.attemptId || !isDeepStrictEqual(current.owner, expected.owner)
      || !isDeepStrictEqual(current.acceptedSpec, expected.acceptedSpec)
    if (changed || current.process.phase === 'terminal' || current.cancelRequestedAt) {
      throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT', 'The accepted job changed or is stopping.', 409)
    }
    const row = (await sql.query<{ accepted_by: string }>(
      'select accepted_by from job_executions where id=$1 and workspace_id=$2 for share',
      [current.id, current.workspaceId])).rows[0]
    if (!row) throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT', 'Accepted input principal is missing.', 409)
    const principal = await readLiveManagementPrincipal(sql, row.accepted_by)
    requireAuthorization(principal, current.workflow ? 'runs:start' : 'jobs:start', {
      workspaceId: current.workspaceId,
      ...(current.workflow ? { workflowId: current.workflow.workflowId, runId: current.workflow.runId } : {}),
    })
    await this.runtime.require(sql, current, { attemptId: current.attemptId, owner: current.owner })
    return { execution: JobExecutionRecordSchema.parse(current), principal }
  }
  private async pin(sql: JobSql, execution: JobExecutionRecord | null, principal: ManagementPrincipal,
    pin: JobInputEntry['pin'], relativePath: string, delegation: JobInputEntry['delegation'],
    snapshot?: StoredFile): Promise<JobInputEntry> {
    const stored = snapshot ?? await this.files.read(pin.fileId, pin.revisionId, sql)
    if(!stored||stored.value.revision.sha256!==pin.sha256||stored.value.revision.byteSize!==pin.byteSize)throw new DomainError('JOB_INPUT_PIN_CONFLICT','The exact accepted input revision is missing or differs.',409)
    const scope=FileScopeSchema.parse(stored.value.file.scope)
    if(fileStateAt(stored.value.file,this.clock().toISOString())!=='ready')throw new DomainError('FILE_BYTES_UNAVAILABLE','The exact input is expired, removed or pending.',410)
    if(execution&&!delegation&&((scope.kind!=='temporary'&&scope.workspaceId!==execution.workspaceId)||(scope.kind==='temporary'&&scope.chat.kind==='agent'&&scope.chat.workspaceId!==execution.workspaceId)))throw new DomainError('JOB_INPUT_SCOPE_DENIED','Accepted input is outside the recipient workspace.',403)
    if(delegation){
      if(!execution?.workflow||delegation.runId!==execution.workflow.runId||scope.kind!=='job_execution')throw new DomainError('JOB_INPUT_EDGE_DENIED','A job edge cannot grant unrelated file scope.',403)
      const bound=(await sql.query<{record:unknown;source_result_digest:string;ordinal:number}>(`select record,source_result_digest,ordinal from run_repeat_bindings
        where binding_id=$1 and run_id=$2 and recipient_execution_id=$3 and source_execution_id=$4 for share`,[delegation.bindingId,delegation.runId,execution.workflow.nodeExecutionId,delegation.sourceExecutionId])).rows[0]
      const bindingRecord=bound?.record as {source?:{execution?:{kind?:string;executionId?:string};acceptedResultDigest?:string;acceptedResult?:unknown}}|undefined
      if(!bound||bound.ordinal!==delegation.ordinal||bound.source_result_digest!==delegation.sourceResultDigest||bindingRecord?.source?.execution?.kind!=='job'
        ||bindingRecord.source.execution.executionId!==delegation.sourceExecutionId||bindingRecord.source.acceptedResultDigest!==delegation.sourceResultDigest
        ||repeatDigest(bindingRecord.source.acceptedResult,64*1024)!==delegation.sourceResultDigest
        ||!artifactPins(bindingRecord.source.acceptedResult).some(value=>value.fileId===pin.fileId&&value.revisionId===pin.revisionId&&value.sha256===pin.sha256&&value.byteSize===pin.byteSize))throw new DomainError('JOB_INPUT_EDGE_DENIED','The exact current Run binding does not delegate these source bytes.',403)
      const source=await this.jobs.execution(sql,execution.workspaceId,scope.jobExecutionId)
      if(!source.workflow||source.workflow.runId!==execution.workflow.runId||source.id!==delegation.sourceExecutionId||source.process.phase!=='terminal'||!source.process.processStopped||source.publication!=='complete')throw new DomainError('JOB_INPUT_EDGE_DENIED','Source is not the exact same-Run completed job.',403)
      const actor=(await sql.query<{accepted_by:string}>('select accepted_by from job_executions where id=$1 for share',[source.id])).rows[0]
      if(!actor)throw new DomainError('JOB_INPUT_EDGE_DENIED','Accepted source actor is missing.',403)
      principal=await readLiveManagementPrincipal(sql,actor.accepted_by)
      requireAuthorization(principal,'runs:start',{workspaceId:source.workspaceId,workflowId:source.workflow.workflowId,runId:source.workflow.runId})
    }else if(scope.kind==='job_execution')requireAuthorization(principal,'job_artifacts:read',{workspaceId:scope.workspaceId})
    else if(scope.kind==='temporary'){
      const chat=scope.chat
      const found=(await sql.query<{id:string}>(`select id from operator_conversations where id=$1 and kind=$2 and deleted_at is null
        and ($3::text is null or owner_principal_id=$3) and workspace_id is not distinct from $4::text
        and workflow_id is not distinct from $5::text and agent_id is not distinct from $6::text
        and origin_run_id is not distinct from $7::text and origin_execution_id is not distinct from $8::text for share`,
      [chat.conversationId,chat.kind,chat.kind==='operator'?chat.ownerPrincipalId:null,chat.kind==='agent'?chat.workspaceId:null,
        chat.kind==='agent'?chat.workflowId:null,chat.kind==='agent'?chat.agentId:null,chat.kind==='agent'?chat.runId??null:null,chat.kind==='agent'?chat.executionId??null:null])).rows
      if(found.length!==1||(chat.kind==='operator'&&chat.ownerPrincipalId!==principal.id))throw new DomainError('JOB_INPUT_SCOPE_DENIED','The original conversation scope changed.',403)
      requireAuthorization(principal,chat.kind==='operator'?'operator_chat:read':'agent_chat:read',chat.kind==='agent'?{workspaceId:chat.workspaceId,workflowId:chat.workflowId,...(chat.runId?{runId:chat.runId}:{})}:{})
    }else await new PostgresFileReferenceAuthorization(this.pool).resolve(principal,scope,'read',sql)
    return JobInputEntrySchema.parse({relativePath,pin,scope,senderPrincipalId:principal.id,senderGrantsDigest:inputHash(principal.grants),delegation})
  }
  /** Definition Save/validate/Start admission: SQL-only, no made-up execution or byte probe. */
  async validateDeclaredJobInputs(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,inputs:JobExecutionRecord['acceptedSpec']['inputs']):Promise<void>{
    const live=await readLiveManagementPrincipal(sql,principal.id)
    for(const input of inputs){const stored=await this.files.read(input.fileId,input.revisionId,sql);if(!stored)throw new DomainError('JOB_INPUT_PIN_CONFLICT','Declared input revision is missing.',409)
      const scope=stored.value.file.scope
      if(scope.kind!=='temporary'&&scope.workspaceId!==workspaceId)throw new DomainError('JOB_INPUT_SCOPE_DENIED','Declared file is outside this job workspace.',403)
      if(scope.kind==='temporary'&&scope.chat.kind==='agent'&&scope.chat.workspaceId!==workspaceId)throw new DomainError('JOB_INPUT_SCOPE_DENIED','Declared conversation file is outside this job workspace.',403)
      const {path,...pin}=input;await this.pin(sql,null,live,pin,`files/${path}`,null)
    }
  }
  async entries(sql:JobSql,execution:JobExecutionRecord,principal:ManagementPrincipal):Promise<JobInputEntry[]> {
    const entries:JobInputEntry[]=[]
    for(const input of execution.acceptedSpec.inputs){const {path,...pin}=input;entries.push(await this.pin(sql,execution,principal,pin,`files/${path}`,null))}
    const workflow=workflowPins(execution)
    for(let ordinal=0;ordinal<workflow.length;ordinal++){const pin=workflow[ordinal]!;entries.push(await this.pin(sql,execution,principal,pin,`files/workflow/${ordinal}`,null))}
    if(execution.workflow){
      const rows=await sql.query<{binding_id:string;run_id:string;source_execution_id:string;source_result_digest:string;ordinal:number;record:unknown}>(`select binding_id,run_id,source_execution_id,source_result_digest,ordinal,record from run_repeat_bindings where run_id=$1 and recipient_execution_id=$2 order by ordinal for share`,[execution.workflow.runId,execution.workflow.nodeExecutionId])
      for(const row of rows.rows){
        const record=row.record as {source?:{execution?:{kind?:string;executionId?:string};acceptedResultDigest?:string;acceptedResult?:unknown}}
        if(record.source?.execution?.kind!=='job')continue
        if(record.source.execution.executionId!==row.source_execution_id||record.source.acceptedResultDigest!==row.source_result_digest||repeatDigest(record.source.acceptedResult,64*1024)!==row.source_result_digest)throw new DomainError('JOB_INPUT_EDGE_PIN_CONFLICT','Persisted source result differs from its exact Run input binding.',409)
        const pins=artifactPins(record.source.acceptedResult)
        for(let index=0;index<pins.length;index++){
          const item=pins[index]!;const pin={fileId:item.fileId,revisionId:item.revisionId,sha256:item.sha256,byteSize:item.byteSize}
          entries.push(await this.pin(sql,execution,principal,pin,`upstream/${row.binding_id}/${index}`,{kind:'run-edge',bindingId:row.binding_id,runId:row.run_id,sourceExecutionId:row.source_execution_id,sourceResultDigest:row.source_result_digest,ordinal:row.ordinal}))
        }
      }
    }
    ensureDistinct(entries);return entries
  }
  async recheck(sql:JobSql,execution:JobExecutionRecord,entry:JobInputEntry):Promise<FileWithRevision> {
    const recipient=await this.recipient(sql,execution)
    return (await this.recheckEntries(sql,execution,recipient.principal,[entry]))[0]!
  }
  async recheckEntries(sql: JobSql, execution: JobExecutionRecord, principal: ManagementPrincipal,
    entries: JobInputEntry[]): Promise<FileWithRevision[]> {
    const pins = entries.map(entry => entry.pin)
    const snapshots = new Map((await this.files.readMany(pins, sql)).map(value =>
      [inputHash([value.value.file.fileId, value.value.revision.revisionId]), value]))
    // These authorization reads hold row locks and can be shared until this recheck ends.
    const queries = new Map<string, Promise<pg.QueryResult>>()
    const authorizationSql: JobSql = {
      query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> => {
        const key = inputHash([text, values ?? []])
        let result = queries.get(key)
        if (!result) {
          result = sql.query(text, values)
          queries.set(key, result)
        }
        return await result as pg.QueryResult<R>
      },
    }
    for (const entry of entries) {
      const snapshot = snapshots.get(inputHash([entry.pin.fileId, entry.pin.revisionId]))
      if (!snapshot) throw new DomainError('JOB_INPUT_PIN_CONFLICT', 'The accepted input revision is missing.', 409)
      const current = await this.pin(authorizationSql, execution, principal, entry.pin,
        entry.relativePath, entry.delegation, snapshot)
      if (!isDeepStrictEqual(current, entry)) {
        throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED', 'Original input authority changed or was revoked.', 403)
      }
    }
    // Refresh file state after waiting for authorization locks, without using the shared reads.
    const refreshed = new Map((await this.files.readMany(pins, sql)).map(value =>
      [inputHash([value.value.file.fileId, value.value.revision.revisionId]), value.value]))
    return entries.map(entry => {
      const value = refreshed.get(inputHash([entry.pin.fileId, entry.pin.revisionId]))
      if (!value || fileStateAt(value.file, this.clock().toISOString()) !== 'ready') {
        throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The input expired while authority locks waited.', 410)
      }
      return value
    })
  }
}
