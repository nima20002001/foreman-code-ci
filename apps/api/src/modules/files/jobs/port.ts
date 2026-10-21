import { jobLifecycleSignal } from '../../jobs/lifecycle.js'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type pg from 'pg'
import type { Readable } from 'node:stream'
import { JobArtifactSchema, type JobArtifact } from '@foreman-code/contracts/jobs'
import { JobVerificationReportSchema, JobVerificationPassSchema, type JobExecutionRecord }
  from '@foreman-code/contracts/job-verification'
import { isDeepStrictEqual } from 'node:util'
import { JobArtifactFileWithRevisionSchema, JobArtifactMediaTypeSchema, type JobExecutionFileScope } from '@foreman-code/contracts/job-artifacts'
import { fileStateAt, type FileWithRevision } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobArtifactPort } from '../../jobs/ports.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { JobRepository } from '../../jobs/repository.js'
import type { JobSql } from '../../jobs/repository.js'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { DomainError } from '../../errors.js'
import type { FileMutationSource } from '../repository.js'
import { JobOutputPublicationInputSchema, type JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
import type { FileStorageService } from '../service.js'
import { completedBytes } from '../tools/transfers.js'

export type { JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
export interface TrustedJobOutputReader {
  /** Main verifies receipt/exact ownership, or opens an immutable collected output after proven closure.
   * No caller path is opened by this adapter. The declared relative path is metadata, not a main disk path. */
  open(input: JobOutputPublicationInput, execution: JobExecutionRecord): Promise<Readable>
}
interface JobPublicationLink {
  kind: 'job_execution'; ownerPrincipalId: string; requestId: string; binding: string
  executionId: string; workspaceId: string; attemptId: string; owner: JobExecutionRecord['owner']
  outputSpecDigest: string; specDigest: string; path: string; inputHash: string
  ref: { fileId: string; revisionId: string }; createdAt: string
}
export interface JobPublicationLedger {
  link(value: JobPublicationLink): Promise<void>
  list(query: JobSql, workspaceId: string, executionId: string): Promise<{ link: JobPublicationLink; value: FileWithRevision }[]>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scope = (workspaceId: string, jobExecutionId: string): JobExecutionFileScope => ({ kind: 'job_execution', workspaceId, jobExecutionId })

/** Implements CI-B's actual port with canonical W09 objects and the existing publication ledger. */
export class CanonicalJobArtifactPort implements JobArtifactPort {
  constructor(private readonly pool: pg.Pool, private readonly files: FileStorageService<JobExecutionFileScope>, private readonly ledger: JobPublicationLedger,
    private readonly authority: Pick<JobPublicationAuthority, 'authorizePublication'>, private readonly reader: TrustedJobOutputReader,
    private readonly clock: () => Date = () => new Date()) {}
  private async transaction<T>(operation: (query: JobSql) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, operation)
  }
  private artifact(link: JobPublicationLink, value: FileWithRevision): JobArtifact {
    const job = JobArtifactFileWithRevisionSchema.parse(value)
    const state = fileStateAt(job.file, this.clock().toISOString())
    return JobArtifactSchema.parse({ executionId: link.executionId, publicationId: link.requestId, path: link.path,
      fileId: job.file.fileId, revisionId: job.revision.revisionId, sha256: job.revision.sha256, byteSize: job.revision.byteSize,
      mediaType: job.revision.mediaType, expiresAt: job.file.expiresAt, state: state === 'ready' ? 'available' : state === 'removed' ? 'tombstoned' : 'expired' })
  }
  private async authorizeRead(query: JobSql, principal: ManagementPrincipal, workspaceId: string,
    executionId: string) {
    const live = await readLiveManagementPrincipal(query, principal.id)
    const resource = await new JobRepository().executionScope(query, workspaceId, executionId)
    requireAuthorization(live, 'job_artifacts:read', { ...resource, workspaceId })
    return live
  }
  /** Main-only Run result projection, after its caller proves actual Run ownership. No bearer enters a build. */
  async listCanonicalOutputs(query: JobSql, execution: JobExecutionRecord): Promise<JobArtifact[]> {
    const current=await new JobRepository().execution(query,execution.workspaceId,execution.id)
    if (!current.workflow || current.process.phase!=='terminal' || !current.process.processStopped
      || current.attemptId!==execution.attemptId || current.acceptedSpec.specDigest!==execution.acceptedSpec.specDigest
      || current.owner.grantId!==execution.owner.grantId || current.owner.epoch!==execution.owner.epoch) {
      throw new DomainError('JOB_RESULT_PIN_CONFLICT','Only the actual accepted closed workflow job can project canonical outputs.',409)
    }
    const linked=await query.query(`select 1 from workflow_job_executions where job_execution_id=$1 and run_id=$2 and node_execution_id=$3 and accepted=true`,
      [current.id,current.workflow.runId,current.workflow.nodeExecutionId])
    if (linked.rows.length!==1) throw new DomainError('JOB_RESULT_PIN_CONFLICT','The real job is not accepted by this persisted Run node.',409)
    return (await this.ledger.list(query,current.workspaceId,current.id)).filter(({link})=>link.attemptId===current.attemptId
      && link.owner.grantId===current.owner.grantId && link.owner.epoch===current.owner.epoch
      && link.specDigest===current.acceptedSpec.specDigest && link.outputSpecDigest===current.acceptedSpec.outputSpecDigest)
      .map(({link,value})=>this.artifact(link,value))
  }
  async list(query: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string): Promise<JobArtifact[]> {
    await this.authorizeRead(query, principal, workspaceId, executionId)
    const records = await this.ledger.list(query, workspaceId, executionId)
    await this.authorizeRead(query, principal, workspaceId, executionId)
    return records.map(({link,value}) => this.artifact(link,value))
  }
  async read(query: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string, fileId: string, revisionId: string, source: 'http'|'mcp' = 'http') {
    await this.authorizeRead(query, principal, workspaceId, executionId)
    const records = await this.ledger.list(query,workspaceId,executionId)
    const found = records.find(({link})=>link.ref.fileId===fileId && link.ref.revisionId===revisionId)
    if (!found) throw new DomainError('JOB_ARTIFACT_NOT_FOUND','The exact job artifact was not found in this execution.',404)
    const artifact = this.artifact(found.link,found.value)
    if (artifact.state !== 'available') throw new DomainError('FILE_BYTES_UNAVAILABLE', `The pinned artifact is ${artifact.state}.`,410)
    const live = await this.authorizeRead(query,principal,workspaceId,executionId)
    const opened = await this.files.download(live,scope(workspaceId,executionId),{fileId,revisionId})
    const bytes = await completedBytes(opened.stream,Math.max(1,artifact.byteSize))
    if (bytes.length !== artifact.byteSize || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new DomainError('FILE_HASH_MISMATCH','The exact artifact bytes failed verification.',410)
    await this.authorizeRead(query,principal,workspaceId,executionId)
    const current = await this.files.repository.read(fileId,revisionId)
    if (!current || fileStateAt(current.value.file,this.clock().toISOString()) !== 'ready') throw new DomainError('FILE_BYTES_UNAVAILABLE','The job artifact expired during read.',410)
    await query.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values ($1,$2,'job_artifact.read',$3,'succeeded',$4::jsonb)`,[principal.id,source,`job:${executionId}`,JSON.stringify({fileId,revisionId,sha256:artifact.sha256})])
    return {artifact,bytes}
  }
  private outputLimit(execution: JobExecutionRecord, path: string): number {
    if (execution.schemaVersion === 1) return execution.acceptedSpec.policy.maxOutputBytes
    return execution.acceptedSpec.outputs.find(output => output.path === path)?.maxBytes ?? 0
  }
  private async reserve(input: JobOutputPublicationInput, source: FileMutationSource) {
    input = JobOutputPublicationInputSchema.parse(input)
    const initial = await this.transaction(sql=>this.authority.authorizePublication(sql,input))
    const execution = initial.execution
    const output = execution.acceptedSpec.outputs.find(value=>value.path===input.path)
    if (!output || output.mediaType !== JobArtifactMediaTypeSchema.parse(input.mediaType)
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > execution.acceptedSpec.policy.maxOutputBytes
      || input.byteSize > this.outputLimit(execution, output.path)) {
      throw new DomainError('JOB_OUTPUT_SPEC_MISMATCH','The output does not match its accepted declaration or byte budget.',422)
    }
    const requestId = `ci:publish:${digest(input.commandId)}`
    const inputHash = digest([execution.workspaceId,execution.id,execution.attemptId,execution.owner.grantId,execution.owner.epoch,
      execution.acceptedSpec.specDigest,execution.acceptedSpec.outputSpecDigest,input.path,input.mediaType,input.byteSize,input.sha256])
    const check = async (sql: JobSql) => {
      const current = await this.authority.authorizePublication(sql,input)
      if (execution.schemaVersion === 2
        && Date.parse(execution.acceptedSpec.lifecycle.publicationDeadlineAt) <= this.clock().getTime()) {
        const completed = await sql.query(`select 1 from file_allocations a join files f on f.file_id=a.file_id
          where a.owner_principal_id=$1 and a.request_id=$2 and a.state='finalized' and f.state='ready'`,
        [initial.principal.id, requestId])
        if (!completed.rowCount) throw new DomainError('JOB_PUBLICATION_DEADLINE_EXPIRED',
          'The original Job publication deadline expired.', 409)
      }
      const reserved = await sql.query<{total:string}>(`select coalesce(sum(r.byte_size),0)::text as total
        from files f join file_revisions r on r.file_id=f.file_id join file_allocations a on a.file_id=r.file_id and a.revision_id=r.revision_id
        where f.scope_kind='job_execution' and f.workspace_id=$1 and f.job_execution_id=$2 and a.request_id<>$3 and a.state<>'canceled'`,[input.workspaceId,input.executionId,requestId])
      if (Number(reserved.rows[0]?.total ?? '0') + input.byteSize > execution.acceptedSpec.policy.maxOutputBytes
      || input.byteSize > this.outputLimit(execution, output.path)) throw new DomainError('JOB_OUTPUT_BUDGET_EXCEEDED','All declared outputs exceed the accepted aggregate byte budget.',413)
      if (current.principal.id !== initial.principal.id || current.execution.acceptedSpec.specDigest !== execution.acceptedSpec.specDigest
        || current.execution.acceptedSpec.outputSpecDigest !== execution.acceptedSpec.outputSpecDigest) throw new DomainError('JOB_PUBLICATION_CONFLICT','Accepted job publication ownership changed.',409)
    }
    const guard = {source,authorize:check}
    const allocated = await this.files.allocateJobOutput(initial.principal,scope(input.workspaceId,input.executionId),{
      requestId,filename:basename(input.path),mediaType:input.mediaType,byteSize:input.byteSize,sha256:input.sha256,
    },inputHash,execution.acceptedSpec.policy.retentionSeconds,guard)
    return {input,initial,execution,requestId,inputHash,guard,allocated,check}
  }
  /** Before transfer issuance: stable canonical allocation is durable before any staging I/O. */
  async reserveAccepted(input: JobOutputPublicationInput, source: FileMutationSource = 'http'): Promise<FileWithRevision> {
    return (await this.reserve(input,source)).allocated.value
  }
  async publishAccepted(input: JobOutputPublicationInput, source: FileMutationSource = 'http') {
    const state=await this.reserve(input,source)
    const {initial,execution,requestId,inputHash,guard,allocated,check}=state
    input=state.input
    await this.ledger.link({kind:'job_execution',ownerPrincipalId:initial.principal.id,requestId,
      binding:digest(['job_execution',execution.id,execution.attemptId,execution.owner.grantId,execution.owner.epoch]),
      executionId:execution.id,workspaceId:execution.workspaceId,attemptId:execution.attemptId,owner:execution.owner,
      outputSpecDigest:execution.acceptedSpec.outputSpecDigest,specDigest:execution.acceptedSpec.specDigest,path:input.path,inputHash,
      ref:{fileId:allocated.value.file.fileId,revisionId:allocated.value.revision.revisionId},createdAt:allocated.value.file.createdAt})
    if (allocated.value.file.state !== 'ready') {
      const bytes = await this.reader.open(input,execution)
      try { await this.files.upload(initial.principal,scope(input.workspaceId,input.executionId),requestId,bytes,{commitAuthorization:guard,
        source,signal:jobLifecycleSignal(execution, 'publication'),reauthorize:async()=>{await this.transaction(check);return initial.principal}}) }
      finally {bytes.destroy()}
    }
    const finalized = await this.files.finalize(initial.principal,scope(input.workspaceId,input.executionId),requestId,source,guard)
    const records = await this.transaction(async sql=>{await check(sql);return this.ledger.list(sql,input.workspaceId,input.executionId)})
    const record = records.find(({link})=>link.requestId===requestId)
    if (!record) throw new DomainError('JOB_PUBLICATION_PENDING','The canonical finalized publication was not adopted.',409)
    return {artifact:this.artifact(record.link,finalized.value),replayed:allocated.replayed}
  }
  /** CI worker authority invokes this inside its complete-publication transaction. */
  async verifyRequiredOutputs(query: JobSql, execution: JobExecutionRecord): Promise<void> {
    if (execution.process.phase !== 'terminal' || !execution.process.processStopped) throw new DomainError('JOB_OUTPUT_NOT_QUIESCENT','Publication requires proven closure.',409)
    const rows = await this.ledger.list(query,execution.workspaceId,execution.id)
    for (const { link, value } of rows) {
      const declaration = execution.acceptedSpec.outputs.find(output => output.path === link.path)
      if (declaration && value.revision.byteSize > this.outputLimit(execution, declaration.path)) {
        throw new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT', 'Artifact exceeds its declared byte limit.', 410)
      }
    }
    let summary: unknown
    for (const output of execution.acceptedSpec.outputs.filter(value=>value.required)) {
      const selected = rows.find(({link,value})=>link.path===output.path && link.attemptId===execution.attemptId
        && link.owner.grantId===execution.owner.grantId && link.owner.epoch===execution.owner.epoch
        && link.specDigest===execution.acceptedSpec.specDigest && link.outputSpecDigest===execution.acceptedSpec.outputSpecDigest && value.revision.mediaType===output.mediaType
        && fileStateAt(value.file,this.clock().toISOString())==='ready')
      if (!selected) throw new DomainError('JOB_REQUIRED_OUTPUT_MISSING','Required exact canonical outputs are unavailable.',409)
      const stored = await this.files.repository.read(selected.link.ref.fileId,selected.link.ref.revisionId)
      if (!stored) throw new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT','Expected canonical artifact metadata is missing.',410)
      try {
        const stream = await this.files.bytes.download(stored.storageKey, stored.value.revision)
        try {
          if ('kind' in output && output.kind === 'suite-summary') {
            const bytes = await completedBytes(stream, Math.max(1, selected.value.revision.byteSize))
            if (bytes.length !== selected.value.revision.byteSize
              || createHash('sha256').update(bytes).digest('hex') !== selected.value.revision.sha256) {
              throw new DomainError('FILE_HASH_MISMATCH', 'Summary bytes changed.', 410)
            }
            summary = JSON.parse(bytes.toString('utf8'))
          }
        } finally { stream.destroy() }
      }
      catch (error) {
        if (error instanceof SyntaxError || error instanceof DomainError && ['FILE_BYTES_UNAVAILABLE','FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH','FILE_TYPE_INVALID'].includes(error.code)) {
          throw new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT','Expected canonical artifact bytes are missing or corrupt.',410, undefined, { cause: error })
        }
        throw error
      }
      const current=await this.files.repository.read(selected.link.ref.fileId,selected.link.ref.revisionId)
      if (!current || fileStateAt(current.value.file,this.clock().toISOString())!=='ready') throw new DomainError('JOB_REQUIRED_OUTPUT_MISSING','The required artifact expired during verification.',410)
    }
    if (execution.schemaVersion === 2) {
      const spec = execution.acceptedSpec
      const expected = { commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
        definitionVersionId: spec.definitionVersionId, suite: spec.verification.suite,
        executionId: execution.id, attemptId: execution.attemptId, target: spec.target,
        profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters }
      const parsed = JobVerificationReportSchema.safeParse(summary)
      if (!parsed.success || Object.entries(expected).some(([key, value]) =>
        !isDeepStrictEqual(Reflect.get(parsed.data, key), value))) {
        throw new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT', 'Verification report differs from the accepted attempt.', 410)
      }
      if (execution.process.outcome === 'succeeded' && !JobVerificationPassSchema.safeParse({
        report: parsed.data, expected, process: execution.process,
        publication: 'complete', requiredOutputsVerified: true,
      }).success) {
        throw new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT', 'Verification reports do not establish a complete pass.', 410)
      }
    }
  }
}
export type { JobPublicationLink }
