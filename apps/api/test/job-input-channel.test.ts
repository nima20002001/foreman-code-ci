import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { AuthenticatedJobInputSource, type JobInputWorkerChannel } from '../src/modules/files/jobInputs/channel.js'
import { makeManifest, manifestBytes } from '../src/modules/files/jobInputs/manifest.js'
import { jobExecution } from './helpers/jobFixture.js'
import { outputTransferContext } from '../src/modules/files/jobs/outputAdmission.js'
import { JobInputAdmissionSchema } from '@foreman-code/contracts/job-inputs'
import { DeviceSessionBindingSchema } from '@foreman-code/contracts/device-connection'
it('uses genuine verified staging and reauthorizes retained bytes over the authenticated carrier',async()=>{
 const root=await mkdtemp(join(homedir(),'.job-input-transfer-test-')),execution=jobExecution()
 const binding=DeviceSessionBindingSchema.parse({mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionGeneration:1,connectionEpoch:randomUUID()})
 execution.id=randomUUID();execution.attemptId=randomUUID();const manifest=makeManifest(execution,[]),bytes=manifestBytes(manifest)
 const transferId=randomUUID(),context=outputTransferContext(binding),admission=JobInputAdmissionSchema.parse({version:1,manifest,principalId:'actor',principalGrantsDigest:'1'.repeat(64),issuedAt:new Date().toISOString(),transfers:[{relativePath:'manifest.json',intent:{version:1,...context,transferId,operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-worker',byteClass:'artifact',sha256:manifest.manifestSha256,byteSize:bytes.length,manifestDigest:manifest.manifestSha256,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:8192}}]})
 let revoked=false,authorizations=0
 const channel:JobInputWorkerChannel={currentBinding:()=>binding,request:async(_namespace,raw)=>{const request=raw as {method:string;offset:number;length:number};if(revoked)throw new Error('revoked');if(request.method==='bind')return {payload:admission};if(request.method==='authorize'){authorizations++;return {payload:{authorized:true,transferId,bindingId:manifest.bindingId}}}const chunk=bytes.subarray(request.offset,request.offset+request.length);return {payload:{transferId,offset:request.offset,byteSize:chunk.length,sha256:createHash('sha256').update(chunk).digest('hex')},bytes:chunk}}}
 const source=new AuthenticatedJobInputSource(channel,join(root,'staging'))
 try{const accepted=await source.admit(execution,new AbortController().signal);expect(Buffer.from(await source.read(execution,accepted,'manifest.json',0,bytes.length,new AbortController().signal))).toEqual(bytes);expect(authorizations).toBeGreaterThan(3);revoked=true;await expect(source.read(execution,accepted,'manifest.json',0,bytes.length,new AbortController().signal)).rejects.toThrow('revoked')}finally{await source.close();await rm(root,{recursive:true,force:true})}
})
