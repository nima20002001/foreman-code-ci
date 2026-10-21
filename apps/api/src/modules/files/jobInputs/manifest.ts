import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JobInputRevisionSchema } from '@foreman-code/contracts/jobs'
import { type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobInputEntrySchema, JobInputManifestSchema, type JobInputEntry, type JobInputManifest } from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest, jobBuildInputManifestBytes } from '@foreman-code/contracts/job-inputs-node'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DomainError } from '../../errors.js'
export const inputHash=(value:unknown)=>commandInputHash(value).slice(7)
export function recipient(execution:JobExecutionRecord) { return {workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,
  owner:execution.owner,bindingHash:execution.acceptedSpec.bindingHash,specDigest:execution.acceptedSpec.specDigest,materializationId:execution.acceptedSpec.source.materializationId,materializationDigest:execution.acceptedSpec.source.materializationDigest} }
export const snapshotDigest=jobInputSnapshotDigest
export const manifestBytes=jobBuildInputManifestBytes
export function verificationContextBytes(manifest: Pick<JobInputManifest, 'verificationContext'>): Buffer | undefined {
  return manifest.verificationContext ? Buffer.from(JSON.stringify(manifest.verificationContext)) : undefined
}
export function verificationContextPin(manifest: Pick<JobInputManifest, 'verificationContext'>) {
  const bytes = verificationContextBytes(manifest)
  return bytes ? { relativePath: 'verification.json' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length } : undefined
}
export function makeManifest(execution:JobExecutionRecord,entries:JobInputEntry[],verificationContext?:JobInputManifest['verificationContext']):JobInputManifest {
  const systemBytes = verificationContextBytes({ verificationContext })
  const totalBytes=entries.reduce((sum,entry)=>sum+entry.pin.byteSize,systemBytes?.length??0)
  if(totalBytes>128*1024*1024)throw new DomainError('JOB_INPUT_TOO_LARGE','Immutable input bytes exceed the supported delivery budget.',413)
  const content={version:1 as const,bindingId:inputHash([recipient(execution),snapshotDigest(execution)]),recipient:recipient(execution),inputSnapshotDigest:snapshotDigest(execution),
    workflowInput:execution.acceptedSpec.workflowInput,entries,totalBytes,
    ...(verificationContext ? { verificationContext } : {})}
  const bytes=manifestBytes({...content,manifestSha256:'0'.repeat(64),manifestByteSize:0})
  return JobInputManifestSchema.parse({...content,manifestSha256:createHash('sha256').update(bytes).digest('hex'),manifestByteSize:bytes.length})
}
/** Workflow vectors remain exact accepted JSON. File pins must use the supported vector; unknown shapes fail closed. */
export function workflowPins(execution:JobExecutionRecord) {
  const raw=execution.acceptedSpec.workflowInput?.files
  if(raw===undefined)return []
  return z.array(JobInputRevisionSchema.omit({path:true})).max(128).parse(raw)
}
export function artifactPins(result:unknown) {
  const output=z.object({output:z.unknown()}).passthrough().parse(result).output
  const candidate=z.object({latestDeliverable:z.object({artifacts:z.array(JobInputRevisionSchema).max(128)}).passthrough()}).passthrough()
  const direct=candidate.safeParse(output)
  if(direct.success)return direct.data.latestDeliverable.artifacts
  const wrapped=z.object({data:candidate}).passthrough().safeParse(output)
  return wrapped.success?wrapped.data.data.latestDeliverable.artifacts:[]
}
export function ensureDistinct(entries:JobInputEntry[]) {
  for(const entry of entries)JobInputEntrySchema.parse(entry)
  if(new Set(entries.map(entry=>entry.relativePath)).size!==entries.length)throw new DomainError('JOB_INPUT_PATH_CONFLICT','Accepted immutable input paths collide.',409)
}
