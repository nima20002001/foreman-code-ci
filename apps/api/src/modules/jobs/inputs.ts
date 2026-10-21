import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open,opendir,realpath,type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  JobBuildInputManifestSchema,
  JobInputDeliveryReceiptSchema,
  JOB_INPUT_DIRECTORY,
  type JobInputDeliveryReceipt,
} from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest } from '@foreman-code/contracts/job-inputs-node'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { identity } from '../sources/privateFilesystem.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { VerifiedJobGitMounts } from './privateGitMounts.js'
export type VerifiedJobSource={ privateRepositoryRoot: string; directoryIdentityHash: string; privateGit: true; diskQuotaBytes: number; gitMounts?:VerifiedJobGitMounts }
/** Supplied only by W09's canonical authorization/transfer/materialization adapter. */
export interface JobAcceptedInputPort {
  prepare(execution:JobExecutionRecord,source:VerifiedJobSource,signal:AbortSignal):Promise<JobInputDeliveryReceipt>
}
export const JOB_INPUT_MANIFEST_CONTAINER_PATH=`/workspace/${JOB_INPUT_DIRECTORY}/manifest.json` as const
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
function deny(message:string):never {throw new Error(`Accepted job inputs rejected: ${message}`)}
/** Pin checks before native claim. The concrete OCI supervisor also checks the
 * actual retained bytes with verifyJobInputDirectory immediately before create. */
export function requireJobInputReceipt(execution:JobExecutionRecord,source:VerifiedJobSource,raw:unknown):JobInputDeliveryReceipt {
  const receipt=JobInputDeliveryReceiptSchema.parse(raw),spec=execution.acceptedSpec
  const recipient={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,bindingHash:spec.bindingHash,specDigest:spec.specDigest,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest}
  if(canonicalJson(receipt.recipient)!==canonicalJson(recipient)||receipt.inputSnapshotDigest!==jobInputSnapshotDigest(execution))deny('original execution, source, owner or input snapshot changed')
  if(!source.privateGit||source.privateRepositoryRoot!==spec.target.destination.canonicalProjectRoot||source.directoryIdentityHash!==spec.target.destination.directoryIdentityHash)deny('private source changed')
  if(!Number.isFinite(source.diskQuotaBytes)||source.diskQuotaBytes<=0)deny('qualified input filesystem budget missing')
  if(receipt.manifestByteSize>4*1024*1024||receipt.files.reduce((sum,file)=>sum+file.byteSize,receipt.verificationContext?.byteSize??0)>Math.min(source.diskQuotaBytes,136*1024*1024))deny('accepted input byte budget exceeded')
  if (receipt.verificationContext && execution.schemaVersion !== 2) deny('build inputs cannot carry verification context')
  const names=receipt.files.map(file=>file.relativePath)
  if(new Set(names).size!==names.length)deny('duplicate or inconsistent retained file receipts')
  const manifest=receipt.files.find(file=>file.relativePath==='manifest.json')
  if(!manifest||manifest.sha256!==receipt.manifestSha256||manifest.byteSize!==receipt.manifestByteSize||!names.includes('workflow-input.json'))deny('exact manifest and workflow snapshot are required')
  return receipt
}
async function readRetainedFile(directory:FileHandle,path:string,expected:{sha256:string;byteSize:number},signal:AbortSignal,capture=false):Promise<Buffer|undefined> {
  const parents:FileHandle[]=[];let file:FileHandle|undefined
  try {
    let parent=directory;const parts=path.split('/')
    for(const part of parts.slice(0,-1)){parent=await open(`/proc/self/fd/${parent.fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);parents.push(parent)}
    file=await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    const before=await file.stat(),digest=createHash('sha256'),chunks:Buffer[]=[],buffer=Buffer.alloc(65536)
    if(!before.isFile()||before.nlink!==1||before.size!==expected.byteSize||(capture&&before.size>4*1024*1024))deny('retained file type or exact size changed')
    let offset=0
    while(offset<before.size){signal.throwIfAborted();const read=await file.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!read.bytesRead)deny('retained file changed during read');const bytes=buffer.subarray(0,read.bytesRead);digest.update(bytes);if(capture)chunks.push(Buffer.from(bytes));offset+=read.bytesRead}
    const after=await file.stat()
    if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||digest.digest('hex')!==expected.sha256)deny('retained bytes changed')
    return capture?Buffer.concat(chunks):undefined
  }finally{await file?.close();await Promise.all(parents.map(parent=>parent.close()))}
}
async function requireExactInputTree(directory:FileHandle,files:JobInputDeliveryReceipt['files'],signal:AbortSignal) {
  const expectedFiles=new Set(files.map(file=>file.relativePath)),expectedDirectories=new Set<string>()
  for(const file of files){const parts=file.relativePath.split('/');for(let count=1;count<parts.length;count++)expectedDirectories.add(parts.slice(0,count).join('/'))}
  const rootIdentity=await identity(directory)
  const walk=async(parent:FileHandle,prefix:string):Promise<void>=>{
    const entries=await opendir(`/proc/self/fd/${parent.fd}`)
    for await(const entry of entries){
      signal.throwIfAborted();const path=prefix?`${prefix}/${entry.name}`:entry.name
      if(entry.isFile()&&expectedFiles.has(path))continue
      if(!entry.isDirectory()||!expectedDirectories.has(path))deny('undeclared retained file, directory or symlink')
      const child=await open(`/proc/self/fd/${parent.fd}/${entry.name}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
      try{const observed=await identity(child);if(observed.device!==rootIdentity.device||observed.mountId!==rootIdentity.mountId)deny('input subtree escapes the bounded filesystem');await walk(child,path)}finally{await child.close()}
    }
  }
  await walk(directory,'')
}
/** Actual OCI entry verifier; it neither downloads bytes nor creates another store. */
export async function verifyJobInputDirectory(execution:JobExecutionRecord,source:VerifiedJobSource,raw:JobInputDeliveryReceipt,signal:AbortSignal):Promise<string> {
  const receipt=requireJobInputReceipt(execution,source,raw),path=join(source.privateRepositoryRoot,JOB_INPUT_DIRECTORY)
  if(await realpath(source.privateRepositoryRoot)!==source.privateRepositoryRoot)deny('canonical private source required')
  const root=await open(source.privateRepositoryRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  let directory:FileHandle|undefined
  try {
    const rootIdentity=await identity(root)
    if(hash(Buffer.from(JSON.stringify(rootIdentity)))!==source.directoryIdentityHash)deny('actual private source identity changed')
    directory=await open(`/proc/self/fd/${root.fd}/${JOB_INPUT_DIRECTORY}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    const observed=await identity(directory)
    if(canonicalJson(observed)!==canonicalJson({device:receipt.directory.device,inode:receipt.directory.inode,mountId:receipt.directory.mountId})||observed.device!==rootIdentity.device||observed.mountId!==rootIdentity.mountId)deny('actual input directory identity or bounded filesystem changed')
    const physicalFiles = receipt.verificationContext ? [...receipt.files, receipt.verificationContext] : receipt.files
    await requireExactInputTree(directory,physicalFiles,signal)
    if (receipt.verificationContext) await readRetainedFile(directory,receipt.verificationContext.relativePath,
      receipt.verificationContext,signal)
    let manifestBytes:Buffer|undefined,workflowBytes:Buffer|undefined
    for(const file of receipt.files){const bytes=await readRetainedFile(directory,file.relativePath,file,signal,file.relativePath==='manifest.json'||file.relativePath==='workflow-input.json');if(file.relativePath==='manifest.json')manifestBytes=bytes;if(file.relativePath==='workflow-input.json')workflowBytes=bytes}
    const manifest=JobBuildInputManifestSchema.parse(JSON.parse(manifestBytes!.toString('utf8')))
    if (canonicalJson(manifest.verificationContext ?? null) !== canonicalJson(receipt.verificationContext ?? null)) {
      deny('verification context pin differs from the retained manifest')
    }
    if(manifest.inputSnapshotDigest!==receipt.inputSnapshotDigest||canonicalJson(manifest.workflowInput)!==canonicalJson(execution.acceptedSpec.workflowInput)||canonicalJson(JSON.parse(workflowBytes!.toString('utf8')))!==canonicalJson(execution.acceptedSpec.workflowInput))deny('actual accepted workflow JSON changed')
    const declared=new Map(receipt.files.map(file=>[file.relativePath,file])),paths=manifest.files.map(file=>file.relativePath)
    if(new Set(paths).size!==paths.length||paths.includes('manifest.json')||paths.includes('workflow-input.json')||paths.length+2!==receipt.files.length)deny('manifest file set differs from retained receipt')
    for(const file of manifest.files){const retained=declared.get(file.relativePath);if(!retained||retained.sha256!==file.sha256||retained.byteSize!==file.byteSize)deny('manifest pin differs from exact retained bytes')}
    for(const input of execution.acceptedSpec.inputs){const file=manifest.files.find(file=>file.relativePath===`files/${input.path}`);if(!file||canonicalJson({fileId:file.fileId,revisionId:file.revisionId,sha256:file.sha256,byteSize:file.byteSize})!==canonicalJson({fileId:input.fileId,revisionId:input.revisionId,sha256:input.sha256,byteSize:input.byteSize}))deny('declared manual input pin missing or changed')}
    if(execution.workflow===null&&manifest.files.length!==execution.acceptedSpec.inputs.length)deny('manual job cannot borrow undeclared workflow files')
    signal.throwIfAborted();return path
  }finally{await directory?.close();await root.close()}
}
