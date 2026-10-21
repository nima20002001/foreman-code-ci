import type pg from 'pg'
import { withTransaction } from '../../../infrastructure/transaction.js'
import {
  JobInputAdmissionSchema,
  JobInputDeliveryReceiptSchema,
  type JobInputDeliveryReceipt,
  type JobInputAdmission,
} from '@foreman-code/contracts/job-inputs'
import { TransferIntentSchema, type TransferIntent, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import { type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { JobRepository, type JobSql } from '../../jobs/repository.js'
import type { FileByteStorage, FileReadSnapshot } from '../storage.js'
import { byteRange } from '../tools/transfers.js'
import { DeviceRegistrationSchema, authorizeDevice } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../../errors.js'
import type { JobInputAuthority } from './authority.js'
import { inputHash, makeManifest, manifestBytes, recipient, snapshotDigest, verificationContextBytes, verificationContextPin } from './manifest.js'
import { outputTransferContext } from '../jobs/outputAdmission.js'
import { JOB_INPUT_NAMESPACE } from './protocol.js'
export { JOB_INPUT_NAMESPACE } from './protocol.js'
/** Main canonical pin/grant authority. Neither callers nor workers supply paths or bytes. */
export class CanonicalJobInputs {
  private readonly commands:PostgresCommandCoordinator
  constructor(private readonly pool:pg.Pool,private readonly authority:JobInputAuthority,private readonly bytes:FileByteStorage,
    private readonly connection:Pick<DeviceEndpoint,'currentBinding'>,
    private readonly clock:()=>Date=()=>new Date()){this.commands=new PostgresCommandCoordinator(pool)}
  private async transaction<T>(work:(sql:JobSql)=>Promise<T>):Promise<T>{return withTransaction(this.pool,work)}
  private binding(execution:JobExecutionRecord) {
    const target=execution.acceptedSpec.target
    if(target.hostRef.kind!=='device'||!target.registration)throw new DomainError('JOB_INPUT_REMOTE_DEVICE_REQUIRED','Remote delivery requires its actual accepted device.',403)
    const binding=this.connection.currentBinding(target.hostRef.deviceId,JOB_INPUT_NAMESPACE)
    if(!binding||binding.mainId!==target.mainId||binding.workerInstallationId!==target.registration.workerInstallationId||binding.keyRevision!==target.registration.keyRevision||binding.authorizationRevision!==target.registration.authorizationRevision)throw new DomainError('JOB_INPUT_DEVICE_CONFLICT','Current authenticated recipient differs from acceptance.',403)
    return binding
  }
  assertChannel(execution:JobExecutionRecord,binding:Readonly<DeviceSessionBinding>):void {
    if(!isDeepStrictEqual(this.binding(execution),binding))throw new DomainError('JOB_INPUT_CONNECTION_STALE','The incoming opaque recipient channel is not current.',403)
  }
  async bind(execution:JobExecutionRecord,verificationContext?:JobInputAdmission['manifest']['verificationContext']):Promise<JobInputAdmission> {
    if (execution.schemaVersion === 2) {
      const spec = execution.acceptedSpec
      if (!verificationContext || verificationContext.identity.executionId !== execution.id
        || verificationContext.identity.attemptId !== execution.attemptId
        || verificationContext.identity.commit !== spec.source.commit
        || verificationContext.identity.manifestDigest !== spec.source.manifestDigest
        || verificationContext.identity.suite !== spec.verification.suite
        || verificationContext.identity.definitionVersionId !== spec.definitionVersionId
        || verificationContext.privateGit.sourceCommit !== spec.source.commit
        || verificationContext.executionTimeoutMs !== spec.policy.executionTimeoutMs
        || verificationContext.cancellationTimeoutMs !== spec.policy.cancellationGraceMs
        || !isDeepStrictEqual(verificationContext.identity.target,spec.target)
        || !isDeepStrictEqual(verificationContext.identity.profile,spec.profile)
        || !isDeepStrictEqual(verificationContext.identity.resources,spec.verification.resources)
        || !isDeepStrictEqual(verificationContext.identity.parameters,spec.verification.parameters)) {
        throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Verification context differs from its accepted execution.',409)
      }
    } else if (verificationContext) throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Build inputs cannot accept verification context.',409)
    const initial=await this.transaction(sql=>this.authority.recipient(sql,execution))
    const commandId=`job-input:${inputHash(recipient(execution))}`
    const prepared=await this.commands.execute({principal:initial.principal,source:'device',commandId,operation:'job.inputs.bind',targetKey:`job:${execution.id}:inputs`,payload:{recipient:recipient(execution),inputSnapshotDigest:snapshotDigest(execution),...(verificationContext?{verificationContext}:{})},
      authorize:async sql=>{const current=await this.authority.recipient(sql,execution);if(current.principal.id!==initial.principal.id)throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Original accepted input actor changed.',403)},
      replayResult:value=>JobInputAdmissionSchema.parse(value),perform:async sql=>{
        const current=await this.authority.recipient(sql,execution),entries=await this.authority.entries(sql,execution,current.principal),manifest=makeManifest(execution,entries,verificationContext)
        await this.device(sql,execution)
        const binding=execution.acceptedSpec.target.hostRef.kind==='device'?this.binding(execution):null
        const source=(await sql.query<{root_id:string;binding_revision:string}>('select root_id,binding_revision::text from source_execution_materializations where materialization_id=$1 and execution_id=$2 and attempt_id=$3 for share',[execution.acceptedSpec.source.materializationId,execution.id,execution.attemptId])).rows[0]
        if(!source)throw new DomainError('JOB_INPUT_ROOT_MISSING','The actual accepted input destination is not materialized.',409)
        const descriptors=[{relativePath:'manifest.json',sha256:manifest.manifestSha256,byteSize:manifest.manifestByteSize},
          {relativePath:'workflow-input.json',sha256:createHash('sha256').update(JSON.stringify(manifest.workflowInput)).digest('hex'),byteSize:Buffer.byteLength(JSON.stringify(manifest.workflowInput))},
          ...entries.map(entry=>({relativePath:entry.relativePath,sha256:entry.pin.sha256,byteSize:entry.pin.byteSize})),
          ...(verificationContextPin(manifest) ? [verificationContextPin(manifest)!] : [])]
        return JobInputAdmissionSchema.parse({version:1,manifest,principalId:current.principal.id,principalGrantsDigest:inputHash(current.principal.grants),issuedAt:this.clock().toISOString(),
          transfers:binding?descriptors.map(value=>({relativePath:value.relativePath,intent:TransferIntentSchema.parse({version:1,...outputTransferContext(binding),transferId:randomUUID(),operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:source.root_id,rootBindingRevision:Number(source.binding_revision),direction:'to-worker',byteClass:'artifact',sha256:value.sha256,byteSize:value.byteSize,manifestDigest:manifest.manifestSha256,expiresAt:new Date(this.clock().getTime()+3600_000).toISOString(),chunkBytes:8192})})):[]})
      }})
    await this.recheck(execution,prepared.value)
    return prepared.value
  }
  async recheck(execution:JobExecutionRecord,admission:JobInputAdmission) {
    return this.transaction(async sql=>{
      const current=await this.authority.recipient(sql,execution)
      if(current.principal.id!==admission.principalId||inputHash(current.principal.grants)!==admission.principalGrantsDigest||inputHash(recipient(execution))!==inputHash(admission.manifest.recipient)||snapshotDigest(execution)!==admission.manifest.inputSnapshotDigest)throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Accepted input snapshot or actor grant changed.',403)
      await this.authority.recheckEntries(sql,execution,current.principal,admission.manifest.entries)
      await this.device(sql,execution)
    })
  }
  private async device(sql:JobSql,execution:JobExecutionRecord) {
      if(execution.acceptedSpec.target.hostRef.kind==='device'){
        const installation=(await sql.query<{id:string}>('select id from application_installation where singleton=true for share')).rows[0]
        if(installation?.id!==execution.acceptedSpec.target.mainId)throw new DomainError('JOB_INPUT_WRONG_MAIN','Accepted input belongs to a different main installation.',403)
        const currentBinding=this.binding(execution),row=(await sql.query<{record:unknown;credential_expires_at:Date|null}>('select record,credential_expires_at from device_registrations where id=$1 and main_id=$2 for share',[currentBinding.deviceId,currentBinding.mainId])).rows[0]
        if(!row?.credential_expires_at||!authorizeDevice(DeviceRegistrationSchema.parse(row.record),{audience:'graphql-worker',mainId:currentBinding.mainId,deviceId:currentBinding.deviceId,workerInstallationId:currentBinding.workerInstallationId,keyRevision:currentBinding.keyRevision,authorizationRevision:currentBinding.authorizationRevision,expiresAt:row.credential_expires_at.toISOString()},'heartbeat',this.clock().getTime()))throw new DomainError('JOB_INPUT_DEVICE_REVOKED','Recipient device authority expired or was revoked.',403)
        this.binding(execution)
      }
  }
  /** Local delivery owns and closes this descriptor; every range retains live authority checks. */
  async openRead(execution: JobExecutionRecord, admission: JobInputAdmission,
    relativePath: string, signal: AbortSignal): Promise<FileReadSnapshot> {
    signal.throwIfAborted()
    await this.recheck(execution, admission)
    const entry = admission.manifest.entries.find(value => value.relativePath === relativePath)
    if (!entry) {
      return { read: (offset, length) => {
        signal.throwIfAborted()
        return this.readRange(execution, admission, relativePath, offset, length, { signal })
      }, close: async () => {} }
    }
    const stored = await this.authority.files.read(entry.pin.fileId, entry.pin.revisionId)
    if (!stored) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The canonical input is unavailable.', 410)
    const reader = await this.bytes.openRead(stored.storageKey, { ...stored.value.revision, ...entry.pin })
    try {
      signal.throwIfAborted()
      await this.recheck(execution, admission)
      return { read: (offset, length) => this.readRange(execution, admission, relativePath, offset, length, { reader, signal }),
        close: () => reader.close() }
    } catch (error) { await reader.close(); throw error }
  }
  async read(execution: JobExecutionRecord, admission: JobInputAdmission,
    relativePath: string, offset: number, length: number): Promise<Buffer> {
    return this.readRange(execution, admission, relativePath, offset, length)
  }
  private async readRange(execution: JobExecutionRecord, admission: JobInputAdmission,
    relativePath: string, offset: number, length: number,
    options: { reader?: FileReadSnapshot; signal?: AbortSignal } = {}): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8192) {
      throw new DomainError('JOB_INPUT_RANGE_INVALID', 'Input delivery ranges are bounded.', 416)
    }
    options.signal?.throwIfAborted()
    await this.recheck(execution, admission)
    let data: Buffer
    if (relativePath === 'manifest.json') data = manifestBytes(admission.manifest).subarray(offset, offset + length)
    else if (relativePath === 'verification.json' && admission.manifest.verificationContext) {
      data = verificationContextBytes(admission.manifest)!.subarray(offset, offset + length)
    } else if (relativePath === 'workflow-input.json') {
      data = Buffer.from(JSON.stringify(admission.manifest.workflowInput)).subarray(offset, offset + length)
    } else {
      const entry = admission.manifest.entries.find(value => value.relativePath === relativePath)
      if (!entry) throw new DomainError('JOB_INPUT_NOT_ADMITTED', 'Only declared immutable input entries may be read.', 403)
      if (options.reader) data = await options.reader.read(offset, length)
      else {
        const stored = await this.authority.files.read(entry.pin.fileId, entry.pin.revisionId)
        if (!stored) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The canonical input is unavailable.', 410)
        data = await byteRange(await this.bytes.download(stored.storageKey, stored.value.revision), offset, length)
      }
    }
    options.signal?.throwIfAborted()
    await this.recheck(execution, admission)
    await this.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'device','job.input.read',$2,'succeeded',$3::jsonb)`, [admission.principalId, `job:${execution.id}`,
      JSON.stringify({ bindingId: admission.manifest.bindingId, relativePath, offset, length,
        executionId: execution.id, attemptId: execution.attemptId })])
    return data
  }
  async execution(executionId:string):Promise<JobExecutionRecord>{
    const row=(await this.pool.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
    if(!row)throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Actual recipient is unavailable.',404)
    return new JobRepository().execution(this.pool,row.workspace_id,executionId)
  }
  async accepted(executionId:string):Promise<{execution:JobExecutionRecord;admission:JobInputAdmission}> {
    return this.transaction(async sql=>{
      const row=(await sql.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
      if(!row)throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Actual recipient is unavailable.',404)
      const execution=await new JobRepository().execution(sql,row.workspace_id,executionId)
      const record=(await sql.query<{result:unknown}>(`select result from management_command_receipts
        where operation='job.inputs.bind' and result #>> '{manifest,recipient,executionId}'=$1
          and result #>> '{manifest,recipient,attemptId}'=$2 and command_id=$3`,
      [execution.id,execution.attemptId,`job-input:${inputHash(recipient(execution))}`])).rows
      if(record.length!==1)throw new DomainError('JOB_INPUT_NOT_ADMITTED','The original input binding has not been persisted.',403)
      return {execution,admission:JobInputAdmissionSchema.parse(record[0]!.result)}
    })
  }
  /** Resolve exactly one original bind receipt, never a caller execution/path hint. */
  async acceptedTransfer(transferId:string) {
    const rows=(await this.pool.query<{result:unknown;command_id:string}>(`select result,command_id
      from management_command_receipts where operation='job.inputs.bind' and result->'transfers' @> $1::jsonb`,
    [JSON.stringify([{intent:{transferId}}])])).rows
    if(rows.length!==1)throw new DomainError('JOB_INPUT_NOT_ADMITTED','Exactly one original input binding is required.',403)
    const original=JobInputAdmissionSchema.parse(rows[0]!.result)
    const matches=original.transfers.filter(value=>value.intent.transferId===transferId)
    if(matches.length!==1)throw new DomainError('JOB_INPUT_NOT_ADMITTED','Exactly one original input transfer is required.',403)
    const execution=await this.execution(original.manifest.recipient.executionId)
    if(rows[0]!.command_id!==`job-input:${inputHash(recipient(execution))}`) {
      throw new DomainError('JOB_INPUT_NOT_ADMITTED','The original input binding has not been persisted.',403)
    }
    await this.recheck(execution,original)
    return {execution,admission:original,transfer:matches[0]!}
  }
  private deliveryReceipt(execution:JobExecutionRecord,admission:JobInputAdmission,raw:unknown):JobInputDeliveryReceipt {
    const receipt=JobInputDeliveryReceiptSchema.parse(raw)
    const files=[{relativePath:'manifest.json',sha256:admission.manifest.manifestSha256,byteSize:admission.manifest.manifestByteSize},
      {relativePath:'workflow-input.json',sha256:createHash('sha256').update(JSON.stringify(admission.manifest.workflowInput)).digest('hex'),byteSize:Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))},
      ...admission.manifest.entries.map(entry=>({relativePath:entry.relativePath,sha256:entry.pin.sha256,byteSize:entry.pin.byteSize}))]
    if(!isDeepStrictEqual(receipt.recipient,recipient(execution))||receipt.bindingId!==admission.manifest.bindingId
      ||receipt.inputSnapshotDigest!==admission.manifest.inputSnapshotDigest||receipt.manifestSha256!==admission.manifest.manifestSha256
      ||receipt.manifestByteSize!==admission.manifest.manifestByteSize||!isDeepStrictEqual(receipt.files,files)
      ||!isDeepStrictEqual(receipt.verificationContext,verificationContextPin(admission.manifest)))
      throw new DomainError('JOB_INPUT_RECEIPT_CONFLICT','Detached delivery does not describe the complete original input binding.',409)
    return receipt
  }
  /** Only the authenticated original worker calls after durable detached-file verification. */
  async acknowledgeDelivery(transferId:string,raw:JobInputDeliveryReceipt,binding:Readonly<DeviceSessionBinding>):Promise<JobInputDeliveryReceipt> {
    const {execution,admission}=await this.acceptedTransfer(transferId)
    this.assertChannel(execution,binding)
    const receipt=this.deliveryReceipt(execution,admission,raw)
    const initial=await this.transaction(sql=>this.authority.recipient(sql,execution))
    if(initial.principal.id!==admission.principalId)throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Original input recipient changed.',403)
    const result=await this.commands.execute({principal:initial.principal,source:'device',operation:'job.inputs.delivery.ack',
      commandId:`job-input-delivery:${admission.manifest.bindingId}`,targetKey:`job:${execution.id}:inputs`,payload:receipt,
      authorize:async sql=>{
        this.assertChannel(execution,binding)
        const current=await this.authority.recipient(sql,execution)
        if(current.principal.id!==admission.principalId||inputHash(current.principal.grants)!==admission.principalGrantsDigest)
          throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Original input actor or grants changed.',403)
        for(const entry of admission.manifest.entries)await this.authority.recheck(sql,execution,entry)
        await this.device(sql,execution);this.assertChannel(execution,binding)
      },replayResult:value=>this.deliveryReceipt(execution,admission,value),perform:async()=>receipt})
    await this.recheck(execution,admission);this.assertChannel(execution,binding)
    return result.value
  }
  async acknowledged(transferId:string,binding:Readonly<DeviceSessionBinding>):Promise<JobInputDeliveryReceipt> {
    const {execution,admission}=await this.acceptedTransfer(transferId)
    this.assertChannel(execution,binding)
    const rows=(await this.pool.query<{result:unknown}>(`select result from management_command_receipts
      where operation='job.inputs.delivery.ack' and principal_id=$1 and command_id=$2`,
    [admission.principalId,`job-input-delivery:${admission.manifest.bindingId}`])).rows
    if(rows.length!==1)throw new DomainError('JOB_INPUT_DELIVERY_PENDING','Original worker detached delivery has not been acknowledged.',409)
    const receipt=this.deliveryReceipt(execution,admission,rows[0]!.result)
    await this.recheck(execution,admission);this.assertChannel(execution,binding)
    return receipt
  }
  async authorizedTransfer(transferId: string, context: TransferContext): Promise<TransferIntent> {
    const { execution, transfer } = await this.acceptedTransfer(transferId)
    if (!isDeepStrictEqual(outputTransferContext(this.binding(execution)), context)
      || Date.parse(transfer.intent.expiresAt) <= this.clock().getTime()) {
      throw new DomainError('JOB_INPUT_TRANSFER_DENIED', 'The input transfer or current recipient is not authorized.', 403)
    }
    return transfer.intent
  }
  async authorizeTransfer(intent:TransferIntent,context:TransferContext) {
    const original = await this.authorizedTransfer(intent.transferId, context)
    if (!isDeepStrictEqual(original, intent)) {
      throw new DomainError('JOB_INPUT_TRANSFER_DENIED', 'The input transfer differs from its accepted binding.', 403)
    }
  }
}
