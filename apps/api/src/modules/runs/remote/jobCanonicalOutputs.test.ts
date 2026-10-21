import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { JobOutputDeviceRequestSchema } from '@foreman-code/contracts/job-output-transfer'
import type { ByteTransferPort, TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { createWorkerJobOutputCollector } from './jobCanonicalOutputs.js'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
describe('sealed job output collector with transfer doubles, no live publication claim',()=>{
 it('reads declared actual bytes and verifies transfer and canonical readback identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'w08-output-'));roots.push(root);await writeFile(join(root,'result.txt'),'fresh output')
  const execution=jobExecution();execution.id=randomUUID();execution.attemptId=randomUUID();execution.operationId=randomUUID();execution.acceptedSpec.target.destination.canonicalProjectRoot=root;execution.acceptedSpec.outputs=[{path:'result.txt',required:true,mediaType:'text/plain'}]
  execution.acceptedSpec.target.hostRef={kind:'device',mainId:execution.acceptedSpec.target.mainId,deviceId:randomUUID()};execution.acceptedSpec.target.registration={workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1}
  const ctx={mainId:execution.acceptedSpec.target.mainId,deviceId:execution.acceptedSpec.target.hostRef.deviceId,workerInstallationId:execution.acceptedSpec.target.registration.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID()}
  let intent:TransferIntent,offset=0;const received:Uint8Array[]=[]
  const progress=()=>({version:1 as const,transferId:intent.transferId,state:'transferring' as const,receivedInMemoryBytes:offset,durableOffset:offset,verifiedBytes:0,updatedAt:new Date().toISOString()})
  const receiver:ByteTransferPort={start:async i=>{intent=i;return progress()},status:async()=>progress(),append:async(_id,_ctx,chunk)=>{expect(chunk.offset).toBe(offset);received.push(chunk.bytes);offset+=chunk.bytes.length;return progress()},finish:async()=>({version:1,receiptId:randomUUID(),transferId:intent.transferId,intent,sha256:intent.sha256,byteSize:offset,verifiedAt:new Date().toISOString()}),cancel:async()=>({...progress(),state:'cancelled'})}
  const journal=await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true})
  await journal.jobAccept({schemaVersion:1,protocolVersion:1,mainId:ctx.mainId,subject:{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner},execution,{mainId:ctx.mainId,deviceId:ctx.deviceId,workerInstallationId:ctx.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:ctx.bootId,connectionGeneration:1},randomUUID())
  await journal.jobTerminal(execution.operationId,{finishedAt:new Date().toISOString(),closureEvidenceDigest:'a'.repeat(64),outcome:'preparation_failed',exitCode:null,signal:null,processStopped:true,resultDigest:'b'.repeat(64),logGapPossible:false,logsTruncated:false,outputCollectionError:false,artifactDigests:[]})
  let published=false
  const application={admit:async (input:import('../../files/jobs/port.js').JobOutputPublicationInput):Promise<TransferIntent>=>({version:1,...ctx,transferId:randomUUID(),operationId:execution.operationId,executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-main',byteClass:'artifact',sha256:input.sha256,byteSize:input.byteSize,manifestDigest:execution.acceptedSpec.outputSpecDigest,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:4}),publish:async (input:import('../../files/jobs/port.js').JobOutputPublicationInput):Promise<import('@foreman-code/contracts/jobs').JobArtifact>=>{const bytes=Buffer.concat(received);expect(bytes.toString()).toBe('fresh output');expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256);published=true;return{executionId:execution.id,publicationId:input.commandId,path:input.path,fileId:randomUUID(),revisionId:randomUUID(),sha256:input.sha256,byteSize:input.byteSize,mediaType:input.mediaType,state:'available',expiresAt:'2026-10-01T01:00:00Z'}}}
  const collect=createWorkerJobOutputCollector({request:async(namespace,raw,options)=>{
   expect(namespace).toBe('byte-transfer-v1')
   const request=JobOutputDeviceRequestSchema.parse(raw)
   if(request.method==='job-output-admit'){intent=await application.admit(request.input);return{payload:intent}}
   if(request.method==='job-output-publish')return{payload:await application.publish(request.input)}
   if(request.method==='start')return{payload:await receiver.start(intent,ctx)}
   if(request.method==='status')return{payload:await receiver.status(request.transferId,ctx)}
   if(request.method==='finish')return{payload:await receiver.finish(request.transferId,ctx)}
   if(request.method==='cancel')return{payload:await receiver.cancel(request.transferId,ctx)}
   if(request.method!=='append')throw new Error('Unexpected output request')
   if(!options?.bytes)throw new Error('Missing signed carrier binary chunk')
   expect(options.bytes.length).toBe(request.byteLength)
   return{payload:await receiver.append(request.transferId,ctx,{offset:request.offset,sha256:request.sha256,bytes:options.bytes})}
  }},{current:async()=>ctx,retryable:()=>false},journal)
  await collect(execution);expect(published).toBe(true)
  const metadata={path:'result.txt',mediaType:'text/plain',sha256:createHash('sha256').update('fresh output').digest('hex'),byteSize:12}
  const command=await journal.jobOutputCommand(execution.operationId,metadata);await journal.close()
  const reopened=await RemoteOperationJournal.open(join(root,'journal'));expect(await reopened.jobOutputCommand(execution.operationId,metadata)).toBe(command)
  await expect(reopened.jobOutputCommand(execution.operationId,{...metadata,sha256:'f'.repeat(64)})).rejects.toThrow('changed');await reopened.close()
 })
})
