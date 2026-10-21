import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { JobArtifactSchema, type JobArtifact } from '@foreman-code/contracts/jobs'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { fileStateAt } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { PostgresJobOutputAdmission } from './outputAdmission.js'
import type { JobPublicationLedger } from './port.js'
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Publication ACK is a finalized canonical readback, never byte finish or a caller flag. */
export class JobOutputRsyncLifecycle {
  constructor(private readonly pool:pg.Pool,private readonly admission:Pick<PostgresJobOutputAdmission,'admissionForTransfer'>,
    private readonly ledger:Pick<JobPublicationLedger,'list'>,private readonly clock:()=>Date=()=>new Date()) {}
  async intentForTransfer(transferId:string):Promise<TransferIntent> {
    return (await this.admission.admissionForTransfer(transferId)).intent
  }
  async acknowledged(intent:TransferIntent):Promise<JobArtifact> {
    const accepted=await this.admission.admissionForTransfer(intent.transferId),input=accepted.input
    if(!isDeepStrictEqual(accepted.intent,intent))throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','ACK cannot replace the original output transfer.',403)
    const requestId=`ci:publish:${digest(input.commandId)}`
    const rows=await this.ledger.list(this.pool,input.workspaceId,input.executionId)
    const matches=rows.filter(({link,value})=>link.ownerPrincipalId===accepted.principalId&&link.requestId===requestId
      &&link.workspaceId===input.workspaceId&&link.executionId===input.executionId&&link.attemptId===input.attemptId
      &&isDeepStrictEqual(link.owner,input.owner)&&link.path===input.path&&link.specDigest===accepted.specDigest
      &&link.outputSpecDigest===intent.manifestDigest
      &&link.binding===digest(['job_execution',input.executionId,input.attemptId,input.owner.grantId,input.owner.epoch])
      &&link.inputHash===digest([input.workspaceId,input.executionId,input.attemptId,input.owner.grantId,input.owner.epoch,
        accepted.specDigest,intent.manifestDigest,input.path,input.mediaType,input.byteSize,input.sha256])&&link.ref.fileId===accepted.fileId&&link.ref.revisionId===accepted.revisionId
      &&value.file.fileId===accepted.fileId&&value.revision.revisionId===accepted.revisionId
      &&value.revision.sha256===input.sha256&&value.revision.byteSize===input.byteSize&&value.revision.mediaType===input.mediaType
      &&fileStateAt(value.file,this.clock().toISOString())==='ready')
    if(matches.length!==1)throw new DomainError('JOB_PUBLICATION_PENDING','Exact finalized canonical output has not been adopted.',409)
    const {link,value}=matches[0]!
    const finalized=await this.pool.query(`select 1 from file_allocations where owner_principal_id=$1 and request_id=$2
      and file_id=$3 and revision_id=$4 and state='finalized'`,[accepted.principalId,requestId,accepted.fileId,accepted.revisionId])
    if(finalized.rows.length!==1)throw new DomainError('JOB_PUBLICATION_PENDING','Original canonical output allocation is not finalized.',409)
    if(!isDeepStrictEqual(await this.admission.admissionForTransfer(intent.transferId),accepted))throw new DomainError('JOB_OUTPUT_ADMISSION_CONFLICT','Output authority changed during ACK.',403)
    return JobArtifactSchema.parse({executionId:input.executionId,publicationId:link.requestId,path:input.path,
      fileId:accepted.fileId,revisionId:accepted.revisionId,sha256:input.sha256,byteSize:input.byteSize,mediaType:input.mediaType,
      expiresAt:'expiresAt' in value.file?value.file.expiresAt:undefined,state:'available'})
  }
}
