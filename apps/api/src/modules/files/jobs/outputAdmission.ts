import { AsyncLocalStorage } from 'node:async_hooks'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import {
  JobOutputAdmissionSchema,
  JobOutputPublicationInputSchema,
  type JobOutputAdmission,
  type JobOutputPublicationInput,
} from '@foreman-code/contracts/job-output-transfer'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { authorizeDevice, DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RemoteJobDispatchIntentSchema, RemoteJobOperationReceiptRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { ApprovedSourceSchema, SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { fileStateAt, type FileWithRevision } from '@foreman-code/contracts/files'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import type { JobSql } from '../../jobs/repository.js'
import { commandInputHash, PostgresCommandCoordinator } from '../../commands/postgres.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { DomainError } from '../../errors.js'
import type { FileMutationSource } from '../repository.js'

import { JOB_OUTPUT_NAMESPACE, outputTransferContext } from './workerProtocol.js'
export { JOB_OUTPUT_NAMESPACE, outputTransferContext } from './workerProtocol.js'
const OPERATION = 'job.output.admit'
export class PostgresJobOutputAdmission {
  private readonly commands: PostgresCommandCoordinator
  private readonly frames = new AsyncLocalStorage<Readonly<DeviceSessionBinding>>()
  constructor(private readonly pool: pg.Pool, private readonly authority: JobPublicationAuthority,
    private readonly endpoint: Pick<DeviceEndpoint,'currentBinding'>,
    private readonly reserve: (input: JobOutputPublicationInput, source: FileMutationSource) => Promise<FileWithRevision>,
    private readonly clock: () => Date = () => new Date()) { this.commands = new PostgresCommandCoordinator(pool) }
  private async transaction<T>(perform: (sql: JobSql) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, perform)
  }
  private current(deviceId: string): Readonly<DeviceSessionBinding> {
    const binding = this.endpoint.currentBinding(deviceId,JOB_OUTPUT_NAMESPACE), frame = this.frames.getStore()
    if (!binding || (frame && !isDeepStrictEqual(binding,frame))) throw new DomainError('JOB_OUTPUT_CONNECTION_STALE','The authenticated output channel is not current and ready.',403)
    return binding
  }
  async onAuthenticatedChannel<T>(binding: Readonly<DeviceSessionBinding>, perform: () => Promise<T>): Promise<T> {
    const current = this.current(binding.deviceId)
    if (!isDeepStrictEqual(current,binding)) throw new DomainError('JOB_OUTPUT_CONNECTION_STALE','The caller is not this current authenticated W07 channel.',403)
    return this.frames.run(Object.freeze({...binding}),perform)
  }
  /** Called by the actual canonical allocation/finalization authority, on its SQL transaction. */
  async assertContext(sql: JobSql, input: Pick<JobOutputPublicationInput,'workspaceId'|'executionId'|'attemptId'|'owner'>, execution: JobExecutionRecord, sourceValidation: 'manifest' | 'identity' = 'manifest') {
    const target=execution.acceptedSpec.target
    if (target.hostRef.kind!=='device' || !target.registration) throw new DomainError('JOB_OUTPUT_DEVICE_REQUIRED','Remote output admission requires its actual accepted device.',403)
    const binding=this.current(target.hostRef.deviceId)
    const installed=(await sql.query<{id:string}>('select id from application_installation where singleton=true for share')).rows[0]
    if(installed?.id!==binding.mainId)throw new DomainError('JOB_OUTPUT_WRONG_MAIN','Output belongs to a different selected main installation.',403)
    if (binding.mainId!==target.mainId || binding.workerInstallationId!==target.registration.workerInstallationId
      || binding.keyRevision!==target.registration.keyRevision || binding.authorizationRevision!==target.registration.authorizationRevision) throw new DomainError('JOB_OUTPUT_DEVICE_CONFLICT','Current device identity differs from the accepted job.',403)
    const device=(await sql.query<{record:unknown;credential_expires_at:Date|null}>(`select record,credential_expires_at from device_registrations
      where id=$1 and main_id=$2 for share`,[binding.deviceId,binding.mainId])).rows[0]
    const registration=device && DeviceRegistrationSchema.parse(device.record)
    if (!device?.credential_expires_at || !registration || !authorizeDevice(registration,{audience:'graphql-worker',mainId:binding.mainId,deviceId:binding.deviceId,
      workerInstallationId:binding.workerInstallationId,keyRevision:binding.keyRevision,authorizationRevision:binding.authorizationRevision,
      expiresAt:device.credential_expires_at.toISOString()},'heartbeat',this.clock().getTime())) throw new DomainError('JOB_OUTPUT_DEVICE_REVOKED','Output device authority expired or was revoked.',403)
    const dispatch=(await sql.query<{intent:unknown;last_receipt:unknown;receipt_sequence:string}>(`select intent,last_receipt,receipt_sequence::text
      from job_dispatch_intents where execution_id=$1 for share`,[execution.id])).rows[0]
    if (!dispatch?.last_receipt) throw new DomainError('JOB_OUTPUT_CLOSURE_MISSING','The original main-projected native closure receipt is missing.',409)
    const intent=RemoteJobDispatchIntentSchema.parse(dispatch.intent),receipt=RemoteJobOperationReceiptRecordSchema.parse(dispatch.last_receipt)
    if (!isDeepStrictEqual(receipt.intent,intent) || intent.executionId!==execution.id || intent.attemptId!==input.attemptId
      || intent.operationId!==execution.operationId || intent.bindingHash!==execution.acceptedSpec.bindingHash || !isDeepStrictEqual(intent.owner,input.owner)
      || intent.subject.workspaceId!==execution.workspaceId
      || (execution.workflow ? !isDeepStrictEqual(intent.subject,{kind:'workflow-node',workspaceId:execution.workspaceId,...execution.workflow})
        : !isDeepStrictEqual(intent.subject,{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId}))
      || !isDeepStrictEqual(receipt.execution.acceptedSpec,execution.acceptedSpec)
      || receipt.phase!=='confirmed_terminal' || !receipt.entryAttempted || !receipt.native || !receipt.terminal?.processStopped
      || execution.process.phase!=='terminal' || !execution.process.processStopped || execution.finishedAt!==receipt.terminal.finishedAt
      || receipt.terminal.outcome!==execution.process.outcome || receipt.terminal.exitCode!==execution.process.exitCode || receipt.terminal.signal!==execution.process.signal
      || !('deviceId' in receipt.connection) || receipt.connection.deviceId!==binding.deviceId
      || receipt.connection.workerInstallationId!==binding.workerInstallationId || receipt.connection.keyRevision!==binding.keyRevision
      || receipt.connection.authorizationRevision!==binding.authorizationRevision || Number(dispatch.receipt_sequence)<receipt.sequence) throw new DomainError('JOB_OUTPUT_CLOSURE_CONFLICT','Output does not belong to the exact accepted physical closure and main projection.',409)
    const materialized=(await sql.query<{record:unknown;state:string}>(`select record,state from source_execution_materializations
      where materialization_id=$1 and workspace_id=$2 and execution_id=$3 and attempt_id=$4 for share`,
    [execution.acceptedSpec.source.materializationId,execution.workspaceId,execution.id,execution.attemptId])).rows[0]
    if (!materialized || materialized.state==='uncertain') throw new DomainError('JOB_OUTPUT_SOURCE_UNAVAILABLE','The accepted source materialization is unavailable.',410)
    const source=SourceMaterializationRecordSchema.parse(materialized.record),root=source.receipt.binding
    if (source.operationId!==execution.operationId || source.receipt.keyRevision!==binding.keyRevision || source.receipt.authorizationRevision!==binding.authorizationRevision
      || sourceMaterializationDigest(source)!==execution.acceptedSpec.source.materializationDigest || source.finalDispatchBindingHash!==execution.acceptedSpec.bindingHash
      || source.receipt.executionId!==execution.id || source.receipt.attemptId!==execution.attemptId
      || root.mainId!==binding.mainId || root.deviceId!==binding.deviceId || root.workerInstallationId!==binding.workerInstallationId
      || root.snapshotId!==execution.acceptedSpec.source.snapshotId || root.manifestDigest!==execution.acceptedSpec.source.manifestDigest
      || root.workspaceId!==execution.workspaceId || root.locationRevision!==Number(target.destination.locationRevision)
      || source.rootPolicyId!==target.destination.rootPolicyId || source.rootPolicyRevision!==target.destination.rootPolicyRevision) throw new DomainError('JOB_OUTPUT_SOURCE_CONFLICT','The exact source/root/attempt binding differs from admission.',409)
    // A newer source selection does not revoke this accepted immutable binding.
    // The original policy must remain explicitly unrevoked; publication authority
    // separately rechecks the live caller, host and accepted source/root scope.
    const bound=(await sql.query<{record:unknown;revoked_at:Date|null}>(`select b.record,p.revoked_at
      from source_root_bindings b join workspace_root_policies p on p.workspace_id=b.workspace_id
        and p.root_policy_id=$4 and p.root_policy_revision=$5
      where b.root_id=$1 and b.binding_revision=$2 and b.workspace_id=$3 for share of b,p`,
    [root.rootId,root.bindingRevision,execution.workspaceId,source.rootPolicyId,source.rootPolicyRevision])).rows[0]
    const acceptedRoot=bound && SourceRootRecordSchema.parse(bound.record)
    if (!bound || bound.revoked_at || !acceptedRoot || !isDeepStrictEqual(acceptedRoot.binding,root)
      || acceptedRoot.selection.rootPolicyId!==source.rootPolicyId || acceptedRoot.selection.rootPolicyRevision!==source.rootPolicyRevision)
      throw new DomainError('JOB_OUTPUT_ROOT_REVOKED','The exact approved root binding is missing, changed or revoked.',403)
    const snapshot = (await sql.query<{
      record?: unknown; availability: string; workspace_id: string; main_id: string;
      snapshot_id: string; approved_source_id: string; manifest_digest: string; commit: string | null;
    }>(`select availability,record->>'workspaceId' as workspace_id,record->>'mainId' as main_id,
        record->'manifest'->>'snapshotId' as snapshot_id,record->'manifest'->>'approvedSourceId' as approved_source_id,
        record->'manifest'->>'manifestDigest' as manifest_digest,record->'manifest'->'git'->>'commit' as commit
        ${sourceValidation === 'manifest' ? ',record' : ''} from source_snapshots
      where workspace_id=$1 and snapshot_id=$2 and approved_source_id=$3 and manifest_digest=$4 for share`,
    [execution.workspaceId,root.snapshotId,execution.acceptedSpec.source.approvedSourceId,root.manifestDigest])).rows[0]
    if (!snapshot || snapshot.availability !== 'retained') {
      throw new DomainError('JOB_OUTPUT_SOURCE_UNAVAILABLE', 'The original approved source is unavailable.', 410)
    }
    if (sourceValidation === 'manifest') ApprovedSourceSchema.parse(snapshot.record)
    if (snapshot.workspace_id !== execution.workspaceId || snapshot.main_id !== binding.mainId
      || snapshot.snapshot_id !== root.snapshotId || snapshot.approved_source_id !== execution.acceptedSpec.source.approvedSourceId
      || snapshot.manifest_digest !== root.manifestDigest || snapshot.commit !== execution.acceptedSpec.source.commit) {
      throw new DomainError('JOB_OUTPUT_SOURCE_CONFLICT', 'The original approved source identity does not match.', 409)
    }
    // Resample after every lock wait. A stored credential/session snapshot never grants access.
    if (device.credential_expires_at.getTime()<=this.clock().getTime() || !isDeepStrictEqual(this.current(binding.deviceId),binding)) throw new DomainError('JOB_OUTPUT_DEVICE_REVOKED','Device authority changed while waiting.',403)
    return {binding,root,receipt,credentialExpiresAt:device.credential_expires_at,source}
  }
  private async lookup(sql: JobSql, input: JobOutputPublicationInput, principalId: string): Promise<JobOutputAdmission|undefined> {
    const result=await sql.query<{result:unknown}>(`select result from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3`,[principalId,OPERATION,input.commandId])
    return result.rows[0]?JobOutputAdmissionSchema.parse(result.rows[0].result):undefined
  }
  private async match(sql: JobSql, record: JobOutputAdmission, input: JobOutputPublicationInput, execution: JobExecutionRecord, facts: Awaited<ReturnType<PostgresJobOutputAdmission['assertContext']>>, allowFinalizedReplay = true) {
    if (!isDeepStrictEqual(record.input,input) || record.inputHash!==commandInputHash(input) || record.specDigest!==execution.acceptedSpec.specDigest
      || record.materializationId!==execution.acceptedSpec.source.materializationId || record.materializationDigest!==execution.acceptedSpec.source.materializationDigest
      || record.nativeIdentityDigest!==commandInputHash(facts.receipt.native).slice(7) || record.closureEvidenceDigest!==facts.receipt.terminal!.closureEvidenceDigest
      || !isDeepStrictEqual(record.originalConnection,facts.receipt.connection) || facts.receipt.sequence<record.receiptSequence) throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','Output retry differs from its original accepted receipt.',409)
    const canonical=(await sql.query<{state:string;allocation_state:string;expires_at:Date}>(`select f.state,a.state as allocation_state,f.expires_at
      from file_allocations a join files f on f.file_id=a.file_id join file_revisions r on r.file_id=a.file_id and r.revision_id=a.revision_id
      where a.owner_principal_id=$1 and a.request_id=$2 and f.file_id=$3 and r.revision_id=$4
        and f.scope_kind='job_execution' and f.workspace_id=$5 and f.job_execution_id=$6 and r.sha256=$7 and r.byte_size=$8 for share of f`,
    [record.principalId,`ci:publish:${commandInputHash(input.commandId).slice(7)}`,record.fileId,record.revisionId,input.workspaceId,input.executionId,input.sha256,input.byteSize])).rows[0]
    if (!canonical || canonical.allocation_state==='canceled' || !['pending','ready'].includes(canonical.state) || canonical.expires_at.getTime()<=this.clock().getTime()) throw new DomainError('FILE_EXPIRED','The original output allocation is expired, removed or unavailable.',410)
    const finalizedReplay=allowFinalizedReplay && canonical.state==='ready' && canonical.allocation_state==='finalized'
    if ((!finalizedReplay && Date.parse(record.intent.expiresAt)<=this.clock().getTime()) || Date.parse(record.allocationExpiresAt)<=this.clock().getTime()) throw new DomainError('FILE_EXPIRED','The original output admission expired.',410)
  }
  async admit(raw: unknown, source: FileMutationSource = 'device'): Promise<TransferIntent> {
    const input=JobOutputPublicationInputSchema.parse(raw)
    const initial=await this.transaction(async sql=>{const admitted=await this.authority.authorizePublication(sql,input);await this.assertContext(sql,input,admitted.execution);return admitted})
    const result=await this.commands.execute({principal:initial.principal,source,operation:OPERATION,commandId:input.commandId,
      targetKey:`job:${input.executionId}:output:${input.path}`,payload:input,dedicatedConnection:true,
      authorize:async sql=>{const current=await this.authority.authorizePublication(sql,input);const facts=await this.assertContext(sql,input,current.execution)
        if(current.principal.id!==initial.principal.id)throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','Accepted sender changed.',409)
        const old=await this.lookup(sql,input,current.principal.id);if(old)await this.match(sql,old,input,current.execution,facts)},
      replayResult:raw=>JobOutputAdmissionSchema.parse(raw),
      perform:async()=>{
        // Canonical allocation is committed before the transfer identity can be issued or bytes can arrive.
        const allocated=await this.reserve(input,source)
        if (!('expiresAt' in allocated.file) || ['expired','removed'].includes(fileStateAt(allocated.file,this.clock().toISOString()))) throw new DomainError('FILE_EXPIRED','The original canonical allocation expired.',410)
        const allocationExpiresAt=allocated.file.expiresAt
        return this.transaction(async sql=>{
          const current=await this.authority.authorizePublication(sql,input),facts=await this.assertContext(sql,input,current.execution)
          const slot=(await sql.query(`select 1 from management_command_receipts where operation=$1 and result #>> '{input,executionId}'=$2
            and result #>> '{input,attemptId}'=$3 and result #>> '{input,path}'=$4`,[OPERATION,input.executionId,input.attemptId,input.path])).rows
          if(slot.length)throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','This output already has an original admission command.',409)
          const publicationDeadline = current.execution.schemaVersion === 2
            ? Date.parse(current.execution.acceptedSpec.lifecycle.publicationDeadlineAt) : Infinity
          const expiry=Math.min(Date.parse(allocationExpiresAt),facts.credentialExpiresAt.getTime(),
            this.clock().getTime()+BYTE_TRANSFER_POLICY.maxLifetimeMs, publicationDeadline)
          if (expiry <= this.clock().getTime()) throw new DomainError('JOB_PUBLICATION_DEADLINE_EXPIRED',
            'The original Job publication deadline expired.', 409)
          const context=outputTransferContext(facts.binding)
          return JobOutputAdmissionSchema.parse({version:1,input,principalId:current.principal.id,inputHash:commandInputHash(input),
            specDigest:current.execution.acceptedSpec.specDigest,materializationId:current.execution.acceptedSpec.source.materializationId,
            materializationDigest:current.execution.acceptedSpec.source.materializationDigest,fileId:allocated.file.fileId,revisionId:allocated.revision.revisionId,
            allocationExpiresAt,originalConnection:facts.receipt.connection,
            nativeIdentityDigest:commandInputHash(facts.receipt.native).slice(7),closureEvidenceDigest:facts.receipt.terminal!.closureEvidenceDigest,
            receiptSequence:facts.receipt.sequence,intent:TransferIntentSchema.parse({version:1,...context,transferId:randomUUID(),operationId:randomUUID(),
              executionId:input.executionId,attemptId:input.attemptId,placementHash:current.execution.acceptedSpec.bindingHash,
              rootId:facts.root.rootId,rootBindingRevision:facts.root.bindingRevision,direction:'to-main',byteClass:'artifact',
              sha256:input.sha256,byteSize:input.byteSize,manifestDigest:current.execution.acceptedSpec.outputSpecDigest,
              expiresAt:new Date(expiry).toISOString(),chunkBytes:8192}),admittedAt:this.clock().toISOString()})
        })
      }})
    return JobOutputAdmissionSchema.parse(result.value).intent
  }
  async requireAdmission(raw: JobOutputPublicationInput): Promise<JobOutputAdmission> {
    const input=JobOutputPublicationInputSchema.parse(raw)
    return this.transaction(async sql=>{
      const current=await this.authority.authorizePublication(sql,input),facts=await this.assertContext(sql,input,current.execution)
      const record=await this.lookup(sql,input,current.principal.id)
      if(!record)throw new DomainError('JOB_OUTPUT_ADMISSION_MISSING','Main has not admitted these output bytes.',403)
      await this.match(sql,record,input,current.execution,facts)
      return record
    })
  }
  async resolve(input: JobOutputPublicationInput, execution: JobExecutionRecord) {
    const record=await this.requireAdmission(input)
    if(record.input.executionId!==execution.id || record.specDigest!==execution.acceptedSpec.specDigest)throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','Resolver execution differs from canonical admission.',409)
    return {transferId:record.intent.transferId,context:outputTransferContext(this.current(record.intent.deviceId))}
  }
  async authorizeTransfer(intent: TransferIntent, context: TransferContext): Promise<void> {
    await this.transaction(async sql=>{
      const result=await sql.query<{result:unknown}>(`select result from management_command_receipts where operation=$1 and result #>> '{intent,transferId}'=$2`,[OPERATION,intent.transferId])
      if(result.rows.length!==1)throw new DomainError('JOB_OUTPUT_ADMISSION_MISSING','This transfer identity was not issued by main.',403)
      const record=JobOutputAdmissionSchema.parse(result.rows[0]!.result),current=await this.authority.authorizePublication(sql,record.input),facts=await this.assertContext(sql,record.input,current.execution,'identity')
      await this.match(sql,record,record.input,current.execution,facts,false)
      if(!isDeepStrictEqual(record.intent,intent) || !isDeepStrictEqual(outputTransferContext(facts.binding),context))throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Transfer identity or current connection differs from main admission.',403)
    })
  }
  async admissionForTransfer(transferId:string):Promise<JobOutputAdmission> {
    const result=await this.pool.query<{result:unknown}>(`select result from management_command_receipts where operation=$1 and result #>> '{intent,transferId}'=$2`,[OPERATION,transferId])
    if(result.rows.length!==1)throw new DomainError('JOB_OUTPUT_ADMISSION_MISSING','Exactly one original output admission is required.',403)
    const original=JobOutputAdmissionSchema.parse(result.rows[0]!.result)
    const current=await this.requireAdmission(original.input)
    if(!isDeepStrictEqual(current,original))throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','Original output admission changed.',409)
    return current
  }
  async intentForTransfer(transferId: string): Promise<TransferIntent> {
    const result=await this.pool.query<{result:unknown}>(`select result from management_command_receipts where operation=$1 and result #>> '{intent,transferId}'=$2`,[OPERATION,transferId])
    if(result.rows.length!==1)throw new DomainError('JOB_OUTPUT_ADMISSION_MISSING','This transfer identity was not issued by main.',403)
    return JobOutputAdmissionSchema.parse(result.rows[0]!.result).intent
  }
}
