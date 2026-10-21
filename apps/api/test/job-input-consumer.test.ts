import { afterEach,describe,expect,it } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod,mkdir,mkdtemp,open,rm,symlink,unlink,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobBuildInputManifestSchema,JOB_INPUT_DIRECTORY,type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest } from '@foreman-code/contracts/job-inputs-node'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { identity } from '../src/modules/sources/privateFilesystem.js'
import { requireJobInputReceipt,verifyJobInputDirectory } from '../src/modules/jobs/inputs.js'
import { jobExecution } from './helpers/jobFixture.js'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
/** Filesystem integrity tests only; no container or runtime qualification occurs. */
async function fixture(workflow=false) {
  const root=await mkdtemp(join(tmpdir(),'ci-input-consumer-'));roots.push(root)
  const directory=join(root,JOB_INPUT_DIRECTORY);await mkdir(directory);await mkdir(join(directory,'files'))
  const bytes=Buffer.from('exact original bytes'),execution=jobExecution()
  execution.acceptedSpec.inputs=[{path:'original.txt',fileId:'pinned-file',revisionId:'pinned-revision',sha256:hash(bytes),byteSize:bytes.length}]
  if(workflow){execution.workflow={workflowId:'workflow',runId:'run',nodeId:'job-node',nodeExecutionId:execution.id};execution.acceptedSpec.workflowInput={nested:{Z:false,a:null},files:[]}}
  const rootHandle=await open(root,constants.O_RDONLY|constants.O_DIRECTORY),directoryHandle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY)
  let rootIdentity:Awaited<ReturnType<typeof identity>>,directoryIdentity:Awaited<ReturnType<typeof identity>>
  try{rootIdentity=await identity(rootHandle);directoryIdentity=await identity(directoryHandle)}finally{await rootHandle.close();await directoryHandle.close()}
  execution.acceptedSpec.target.destination.canonicalProjectRoot=root;execution.acceptedSpec.target.destination.canonicalCwd=root;execution.acceptedSpec.target.destination.directoryIdentityHash=hash(Buffer.from(JSON.stringify(rootIdentity)))
  Object.assign(execution.acceptedSpec,jobSpecDigests(execution.acceptedSpec,execution.acceptedSpec.workflowInput))
  const snapshot=jobInputSnapshotDigest(execution),pin=execution.acceptedSpec.inputs[0]!
  const manifest=Buffer.from(JSON.stringify(JobBuildInputManifestSchema.parse({version:1,inputSnapshotDigest:snapshot,workflowInput:execution.acceptedSpec.workflowInput,files:[{relativePath:'files/original.txt',fileId:pin.fileId,revisionId:pin.revisionId,sha256:pin.sha256,byteSize:pin.byteSize}]})))
  const workflowBytes=Buffer.from(JSON.stringify(execution.acceptedSpec.workflowInput)),retained=[{relativePath:'manifest.json',bytes:manifest},{relativePath:'workflow-input.json',bytes:workflowBytes},{relativePath:'files/original.txt',bytes}]
  for(const file of retained)await writeFile(join(directory,file.relativePath),file.bytes,{mode:0o444})
  const spec=execution.acceptedSpec,receipt:JobInputDeliveryReceipt={version:1,recipient:{workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,bindingHash:spec.bindingHash,specDigest:spec.specDigest,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest},bindingId:'9'.repeat(64),inputSnapshotDigest:snapshot,manifestSha256:hash(manifest),manifestByteSize:manifest.length,directory:{relativePath:JOB_INPUT_DIRECTORY,...directoryIdentity},files:retained.map(file=>({relativePath:file.relativePath,sha256:hash(file.bytes),byteSize:file.bytes.length})),readonlyMountRequired:true}
  const source={privateRepositoryRoot:root,directoryIdentityHash:spec.target.destination.directoryIdentityHash,privateGit:true as const,diskQuotaBytes:1024*1024}
  return {root,directory,execution,receipt,source}
}
describe('accepted immutable job input consumer',()=>{
  it.each([false,true])('verifies exact copied pins and mandatory workflow snapshot (workflow=%s)',async workflow=>{
    const f=await fixture(workflow)
    expect(await verifyJobInputDirectory(f.execution,f.source,f.receipt,new AbortController().signal)).toBe(f.directory)
  })
  it('refuses switched operation/source/input receipt before native claim',async()=>{
    const f=await fixture()
    expect(()=>requireJobInputReceipt(f.execution,f.source,{...f.receipt,recipient:{...f.receipt.recipient,attemptId:'other-attempt'}})).toThrow('original execution')
    expect(()=>requireJobInputReceipt(f.execution,f.source,{...f.receipt,inputSnapshotDigest:'2'.repeat(64)})).toThrow('input snapshot changed')
  })
  it('detects corrupt retained bytes even when the receipt metadata is unchanged',async()=>{
    const f=await fixture();await chmod(join(f.directory,'files/original.txt'),0o600);await writeFile(join(f.directory,'files/original.txt'),'wrong original bytes')
    await expect(verifyJobInputDirectory(f.execution,f.source,f.receipt,new AbortController().signal)).rejects.toThrow('retained bytes changed')
  })
  it('denies undeclared retained bytes from the read-only mount',async()=>{
    const f=await fixture();await writeFile(join(f.directory,'undeclared'),'not authorized by accepted pins')
    await expect(verifyJobInputDirectory(f.execution,f.source,f.receipt,new AbortController().signal)).rejects.toThrow('undeclared retained file')
  })
  it('rejects a symlink substituted for a delivered input file',async()=>{
    const f=await fixture();await writeFile(join(f.root,'other'),'not the declared bytes');await unlink(join(f.directory,'files/original.txt'));await symlink(join(f.root,'other'),join(f.directory,'files/original.txt'))
    await expect(verifyJobInputDirectory(f.execution,f.source,f.receipt,new AbortController().signal)).rejects.toThrow('symlink')
  })
  it('refuses missing explicit null workflow snapshot on a manual job',async()=>{
    const f=await fixture();f.receipt.files=f.receipt.files.filter(file=>file.relativePath!=='workflow-input.json')
    expect(()=>requireJobInputReceipt(f.execution,f.source,f.receipt)).toThrow('workflow snapshot are required')
  })
})
