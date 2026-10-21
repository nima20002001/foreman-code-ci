import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { afterEach, describe, it, expect, vi } from 'vitest'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import { RemoteJobOperationReceiptSchema } from '@foreman-code/contracts/remote-job-execution'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { JobOutputPublicationInputSchema, type JobOutputAdmission, type JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { PostgresJobOutputAdmission, outputTransferContext } from '../src/modules/files/jobs/outputAdmission.js'
import { ResumableByteTransferService } from '../src/modules/byte-transfer/service.js'
import { ResumableByteTransferSender } from '../src/modules/byte-transfer/sender.js'
import { WorkerJobOutputApplication, WorkerJobOutputReceiver, jobOutputDeviceExtension } from '../src/modules/files/jobs/outputChannel.js'
import { DomainError } from '../src/modules/errors.js'
import { JobOutputCollectionError } from '../src/modules/jobs/executorOutputs.js'
import { CanonicalJobArtifactPort, type JobPublicationLedger } from '../src/modules/files/jobs/port.js'
import { PostgresJobArtifactScopeAuthorization } from '../src/modules/files/jobs/factory.js'
import { FileStorageService } from '../src/modules/files/service.js'
import type { FileByteStorage } from '../src/modules/files/storage.js'
import type { AllocationSession, FileMutationContext, FileMutationSource } from '../src/modules/files/repository.js'
import { MemoryFiles, MemoryBytes } from './support/fileTools.js'
import { VerifiedJobOutputReader } from '../src/modules/files/jobs/transferReader.js'
import { createWorkerJobOutputCollector } from '../src/modules/runs/remote/jobCanonicalOutputs.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
const digest=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
/** Modeled SQL/session authority unit boundary. Actual PostgreSQL pairing/ownership is in the root-only fixture. */
async function fixture() {
  const job=jobExecution();job.createdAt=new Date().toISOString();job.id=randomUUID();job.attemptId=randomUUID();job.operationId=randomUUID();job.owner={grantId:randomUUID(),epoch:'1'}
  const binding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1}
  job.acceptedSpec.target={...job.acceptedSpec.target,mainId:binding.mainId,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1}}
  job.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};job.finishedAt=job.createdAt
  job.acceptedSpec.outputs=[{path:'dist/result.json',mediaType:'application/json',required:true}]
  const rootBinding={version:1 as const,mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId:job.workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,canonicalPath:'/approved/owned-unit-root',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write' as const,snapshotId:job.acceptedSpec.source.snapshotId,manifestDigest:job.acceptedSpec.source.manifestDigest}
  const material:SourceMaterializationRecord={receipt:{version:1,materializationId:randomUUID(),binding:rootBinding,placementHash:digest('source-binding'),executionId:job.id,attemptId:job.attemptId,keyRevision:1,authorizationRevision:1,verifiedManifestDigest:rootBinding.manifestDigest,verifiedEntries:0,verifiedBytes:0,verifiedAt:job.createdAt,localTreeIdentity:{device:'1',inode:'4',mountId:'3'}},rootPolicyId:job.acceptedSpec.target.destination.rootPolicyId,rootPolicyRevision:'1',operationId:job.operationId,reservationId:randomUUID(),sourceBindingHash:digest('source-binding'),finalDispatchBindingHash:job.acceptedSpec.bindingHash,state:'prepared'}
  job.acceptedSpec.source.materializationId=material.receipt.materializationId;job.acceptedSpec.source.materializationDigest=sourceMaterializationDigest(material)
  const root={version:1,source:{approvedSourceId:job.acceptedSpec.source.approvedSourceId,snapshotId:rootBinding.snapshotId,manifestDigest:rootBinding.manifestDigest},selection:{hostRef:job.acceptedSpec.target.hostRef,rootPolicyId:material.rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},binding:rootBinding,ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:job.acceptedSpec.target.registration,attestationId:'attestation',attestationDigest:digest('attestation'),boundAt:job.createdAt}
  const source={version:1,workspaceId:job.workspaceId,ownerPrincipalId:'owner',approvedByPrincipalId:'owner',locationRevision:1,mainId:binding.mainId,originIdentityHash:`sha256:${digest('origin')}`,approvedAt:job.createdAt,availability:'retained',manifest:{version:1,snapshotId:rootBinding.snapshotId,approvedSourceId:job.acceptedSpec.source.approvedSourceId,capturePolicy:'git-tree-v1',executablePolicy:'strip',git:{commit:job.acceptedSpec.source.commit,tree:'2'.repeat(40),objectFormat:'sha1'},entries:[],deletions:[],totalEntries:0,totalBytes:0,manifestDigest:rootBinding.manifestDigest}}
  const intent={schemaVersion:1,protocolVersion:1,mainId:binding.mainId,subject:{kind:'manual-job',workspaceId:job.workspaceId,jobExecutionId:job.id,definitionId:job.acceptedSpec.definitionId},executionId:job.id,attemptId:job.attemptId,operationId:job.operationId,bindingHash:job.acceptedSpec.bindingHash,inputDigest:`sha256:${job.acceptedSpec.specDigest}`,owner:job.owner}
  const receipt={schemaVersion:1,kind:'job',intent,execution:job,connection:{mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,keyRevision:binding.keyRevision,authorizationRevision:binding.authorizationRevision,bootId:binding.bootId,connectionGeneration:binding.connectionGeneration},workerIncarnationId:randomUUID(),sequence:1,observedAt:job.createdAt,phase:'confirmed_terminal',entryAttempted:true,stopFence:false,native:{containerId:'unit-original-container',supervisorIdentity:'unit-original-supervisor',processIdentityDigest:digest('unit-process'),startedAt:job.createdAt},controls:[],terminal:{finishedAt:job.finishedAt,closureEvidenceDigest:digest('unit-closure'),outcome:'succeeded',exitCode:0,signal:null,processStopped:true,resultDigest:digest('result'),logGapPossible:false,logsTruncated:false,outputCollectionError:false,artifactDigests:[]},publication:'process_recorded'}
  const registration=DeviceRegistrationSchema.parse({mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1,publicKeyFingerprint:digest('unit-key'),status:'paired',scopes:['connect','heartbeat']})
  const records=new Map<string,JobOutputAdmission>();let now=new Date(job.createdAt),ready=true,revoked=false,liveOwner=true,liveGrant=true,rootRevision=1,rootRevoked=false,canonicalState='pending',allocationState='allocated'
  const fileId=randomUUID(),revisionId=randomUUID(),expires=new Date(now.getTime()+7200_000)
  const query=vi.fn(async(text:string,args:unknown[]=[])=>{
    if(text.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]}
    if(text.startsWith('select record,accepted_spec'))return {rows:[{record:job,accepted_spec:job.acceptedSpec}]}
    if(text.startsWith('select accepted_by'))return {rows:[{accepted_by:'owner'}]}
    if(text.includes('management_principals'))return {rows:[{id:'owner',name:'Owner',audience:'operator',grants:liveGrant?[{actions:['jobs:start'],scope:{workspaceIds:[job.workspaceId]}}]:[],expires_at:new Date('2099-01-01'),revoked_at:null,delegated_from:null}]}
    if(text.startsWith('select record from job_definition_versions'))return {rows:[{record:{schemaVersion:1,id:job.acceptedSpec.definitionId,workspaceId:job.workspaceId,name:'Original',revision:1,versionId:job.acceptedSpec.definitionVersionId,spec:{...jobSpec(),target:job.acceptedSpec.target,outputs:job.acceptedSpec.outputs},createdAt:job.createdAt,updatedAt:job.createdAt}}]}
    if(text.startsWith('select id from application_installation'))return {rows:[{id:binding.mainId}]}
    if(text.includes('from device_registrations'))return {rows:[{record:{...registration,status:revoked?'revoked':'paired'},credential_expires_at:new Date('2099-01-01')}]}
    if(text.includes('from job_dispatch_intents'))return {rows:[{intent,last_receipt:receipt,receipt_sequence:'1'}]}
    if(text.includes('from source_execution_materializations'))return {rows:[{record:material,state:'closed'}]}
    if(text.includes('from source_root_bindings'))return {rows:[{record:root,current_binding_revision:String(rootRevision),revoked_at:rootRevoked?now:null}]}
    if(text.includes('from source_snapshots'))return {rows:[{record:source,availability:'retained',workspace_id:source.workspaceId,main_id:source.mainId,snapshot_id:source.manifest.snapshotId,approved_source_id:source.manifest.approvedSourceId,manifest_digest:source.manifest.manifestDigest,commit:source.manifest.git.commit}]}
    if(text.includes('from file_allocations'))return {rows:[{state:canonicalState,allocation_state:allocationState,expires_at:expires}]}
    if(text.startsWith('insert into management_command_receipts')){records.set(String(args[2]),JSON.parse(String(args[5])));return {rows:[],rowCount:1}}
    if(text.includes("where principal_id = any($1::text[]) and operation = $2 and command_id = $3")){const old=records.get(String(args[2]));return {rows:old?[{principal_id:old.principalId,input_hash:commandInputHash(old.input),target_key:`job:${job.id}:output:${old.input.path}`,result:old}]:[]}}
    if(text.includes('where principal_id=$1 and operation=$2 and command_id=$3')){const old=records.get(String(args[2]));return {rows:old?[{result:old}]:[]}}
    if(text.includes("result #>> '{intent,transferId}'"))return {rows:[...records.values()].filter(r=>r.intent.transferId===args[1]).map(result=>({result}))}
    if(text.includes("result #>> '{input,executionId}'"))return {rows:[...records.values()].filter(r=>r.input.executionId===args[1]&&r.input.attemptId===args[2]&&r.input.path===args[3])}
    return {rows:[],rowCount:0}
  })
  const pool=new pg.Pool()
  vi.spyOn(pg.Pool.prototype,'query').mockImplementation(query as never)
  vi.spyOn(pg.Pool.prototype,'connect').mockResolvedValue({query,release:()=>{}} as never)
  const authority=new JobPublicationAuthority({require:async()=>{if(!liveOwner)throw new DomainError('JOB_OWNERSHIP_LOST','Modeled owner lost.',409)}},{revalidateAccepted:async()=>undefined} as never)
  const endpoint={currentBinding:()=>ready?Object.freeze({...binding}):undefined}
  const reserve=vi.fn<(input:JobOutputPublicationInput,source:FileMutationSource)=>Promise<FileWithRevision>>(async()=>({file:{fileId,currentRevisionId:revisionId,scope:{kind:'job_execution' as const,workspaceId:job.workspaceId,jobExecutionId:job.id},state:'pending' as const,createdAt:job.createdAt,retentionDurationSeconds:7200,expiresAt:expires.toISOString()},revision:{byteClass:'ci-output' as const,fileId,revisionId,filename:'result.json',mediaType:'application/json' as const,byteSize:11,sha256:digest('{"ok":true}'),origin:'job_output' as const,createdAt:job.createdAt}}))
  const admission=new PostgresJobOutputAdmission(pool,authority,endpoint,reserve,()=>now)
  const input=JobOutputPublicationInputSchema.parse({workspaceId:job.workspaceId,executionId:job.id,attemptId:job.attemptId,owner:job.owner,commandId:randomUUID(),path:'dist/result.json',mediaType:'application/json',sha256:digest('{"ok":true}'),byteSize:11})
  return {source,admission,input,binding,job,records,reserve,query,pool,authority,receipt,clock:()=>now,endpoint,loseGrant:()=>{liveGrant=false},revoked:()=>{revoked=true},loseOwner:()=>{liveOwner=false},rebind:()=>{binding.connectionEpoch=randomUUID()},offline:()=>{ready=false},expire:()=>{now=new Date(expires)},rootChange:()=>{rootRevision++},revokeRoot:()=>{rootRevoked=true},advance:()=>{now=new Date(now.getTime()+3600_001)},finalize:(state='ready',allocation='finalized')=>{canonicalState=state;allocationState=allocation}}
}
describe('main-owned job output admission and actual byte receiver',()=>{
  it('authorizes chunks without traversing the immutable manifest after admission', async () => {
    const f = await fixture()
    const intent = await f.admission.admit(f.input)
    const entries = f.source.manifest.entries
    let reads = 0
    Object.defineProperty(f.source.manifest, 'entries', { get() { reads++; return entries } })
    await f.admission.authorizeTransfer(intent, outputTransferContext(f.binding))
    await f.admission.authorizeTransfer(intent, outputTransferContext(f.binding))
    expect(reads).toBe(0)
  })
  it('still validates the complete manifest at output admission', async () => {
    const f = await fixture()
    f.source.manifest.totalBytes = -1
    await expect(f.admission.admit(f.input)).rejects.toThrow()
    expect(f.reserve).not.toHaveBeenCalled()
  })
  it('retries a failed canonical reservation and persists one original output admission',async()=>{
    const f=await fixture()
    f.reserve.mockRejectedValueOnce(new Error('Canonical reservation unavailable'))
    await expect(f.admission.admit(f.input)).rejects.toThrow('Canonical reservation unavailable')
    expect(f.records.size).toBe(0)
    const created=await f.admission.admit(f.input)
    await expect(f.admission.admit(f.input,'mcp')).resolves.toEqual(created)
    const stored=await f.admission.requireAdmission(f.input)
    expect(stored.intent).toEqual(created)
    expect(stored.input).toEqual(f.input)
    expect(f.records.size).toBe(1)
    expect(f.reserve).toHaveBeenCalledTimes(2)
  })
  it('issues original main IDs once, rejects caller IDs/changed payload and resolves current scoped context',async()=>{
    const f=await fixture(),first=await f.admission.onAuthenticatedChannel(f.binding,()=>f.admission.admit(f.input))
    const again=await f.admission.onAuthenticatedChannel(f.binding,()=>f.admission.admit(f.input,'mcp'))
    expect(again).toEqual(first);expect(f.records.size).toBe(1);expect(f.reserve).toHaveBeenCalledTimes(1)
    expect(first.rootBindingRevision).toBe(1);expect(first.transferId).not.toBe(f.input.commandId)
    expect(JobOutputPublicationInputSchema.safeParse({...f.input,transferId:randomUUID(),rootId:randomUUID()}).success).toBe(false)
    await expect(f.admission.admit({...f.input,sha256:digest('changed')})).rejects.toMatchObject({code:'JOB_OUTPUT_ADMISSION_CONFLICT'})
    expect(await f.admission.resolve(f.input,f.job)).toEqual({transferId:first.transferId,context:outputTransferContext(f.binding)})
    const old={...f.binding};f.rebind()
    await expect(f.admission.onAuthenticatedChannel(old,()=>f.admission.admit(f.input))).rejects.toMatchObject({code:'JOB_OUTPUT_CONNECTION_STALE'})
    expect((await f.admission.resolve(f.input,f.job)).transferId).toBe(first.transferId)
    f.expire();await expect(f.admission.resolve(f.input,f.job)).rejects.toMatchObject({code:'FILE_EXPIRED'})
  })
  it('reauthorizes real accepted scope and refuses revoked device/lost owner/changed root before issuing IDs',async()=>{
    for(const failure of ['revoked','loseOwner','revokeRoot','offline'] as const){const f=await fixture();f[failure]();await expect(f.admission.admit(f.input)).rejects.toBeInstanceOf(DomainError);expect(f.records.size).toBe(0)}
  })
  it('keeps the original accepted binding after the source selection head advances',async()=>{
    const f=await fixture(),first=await f.admission.admit(f.input)
    f.rootChange()
    expect(await f.admission.admit(f.input)).toEqual(first)
    expect((await f.admission.requireAdmission(f.input)).intent).toEqual(first)
    await expect(f.admission.authorizeTransfer(first,outputTransferContext(f.binding))).resolves.toBeUndefined()
    f.revokeRoot()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OUTPUT_ROOT_REVOKED'})
  })
  it('reconciles an expired admission only for an exact finalized retained canonical output',async()=>{
    const f=await fixture(),first=await f.admission.admit(f.input)
    f.advance()
    await expect(f.admission.admit(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
    f.finalize()
    expect(await f.admission.admit(f.input)).toEqual(first)
    expect((await f.admission.requireAdmission(f.input)).intent).toEqual(first)
    expect(f.reserve).toHaveBeenCalledTimes(1);expect(f.records.size).toBe(1)
    await expect(f.admission.authorizeTransfer(first,outputTransferContext(f.binding))).rejects.toMatchObject({code:'FILE_EXPIRED'})
    await expect(f.admission.admit({...f.input,sha256:digest('changed')})).rejects.toMatchObject({code:'JOB_OUTPUT_ADMISSION_CONFLICT'})
    f.revoked()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OUTPUT_DEVICE_REVOKED'})
  })
  it('requires both ready canonical bytes and finalized allocation to reconcile expired admission',async()=>{
    for(const [state,allocation] of [['ready','allocated'],['pending','finalized']]){
      const f=await fixture();await f.admission.admit(f.input);f.finalize(state,allocation);f.advance()
      await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
    }
    const f=await fixture();await f.admission.admit(f.input);f.finalize();f.advance();f.loseOwner()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OWNERSHIP_LOST'})
  })
  it('does not replay a finalized output past its independent retention',async()=>{
    const f=await fixture();await f.admission.admit(f.input);f.finalize();f.expire()
    await expect(f.admission.admit(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
  })
  it('uses the real resumable sender/receiver through the typed binary channel, never a substitute byte reader',async()=>{
    const f=await fixture(),root=await mkdtemp(join(process.env.GRAPHQL_HEAVY_BASE_TMPDIR ?? tmpdir(),'job-output-transfer-unit-'))
    const receiver=new ResumableByteTransferService(root,{authorize:(intent,context)=>f.admission.authorizeTransfer(intent,context)},()=>new Date(f.job.createdAt).getTime())
    const extension=jobOutputDeviceExtension(f.admission,{} as never,receiver)
    const channel={request:async(_namespace:string,payload:unknown,options?:{bytes?:Uint8Array})=>extension.handle!(payload,{binding:f.binding,signal:AbortSignal.timeout(10_000),...(options?.bytes?{bytes:options.bytes}:{})})}
    try{
      const intent=await new WorkerJobOutputApplication(channel).admit(f.input),data=Buffer.from('{"ok":true}')
      const sender=new ResumableByteTransferSender(new WorkerJobOutputReceiver(channel),{read:async(_intent,offset,length)=>data.subarray(offset,offset+length)},{current:async()=>outputTransferContext(f.binding),retryable:()=>false})
      const receipt=await sender.send(intent,AbortSignal.timeout(10_000));expect(receipt.sha256).toBe(f.input.sha256)
      const stream=await receiver.openVerified(receipt,outputTransferContext(f.binding)),chunks=[]
      for await(const chunk of stream)chunks.push(chunk as Buffer)
      expect(Buffer.concat(chunks)).toEqual(data)
      f.revoked();await expect(receiver.resolveVerifiedReceipt(intent.transferId,outputTransferContext(f.binding))).rejects.toMatchObject({code:'JOB_OUTPUT_DEVICE_REVOKED'})
    }finally{await receiver.close();await rm(root,{recursive:true,force:true})}
  })
})

/** Whole collector and real service composition, with modeled SQL and memory canonical storage. */
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
async function collectorFixture() {
  vi.useFakeTimers({toFake:['Date']})
  const f=await fixture(),root=await mkdtemp(join(process.env.GRAPHQL_HEAVY_BASE_TMPDIR ?? tmpdir(),'job-collector-replay-'))
  await mkdir(join(root,'dist'));await writeFile(join(root,f.input.path),'{"ok":true}')
  f.job.acceptedSpec.target.destination.canonicalProjectRoot=root
  f.job.acceptedSpec.policy.retentionSeconds=7200
  const sql={query:f.query} as unknown as import('../src/modules/jobs/repository.js').JobSql
  class GuardedFiles extends MemoryFiles {
    override withAllocation<T>(owner:string,request:string,operation:(session:AllocationSession)=>Promise<T>,mutation?:FileMutationContext):Promise<T> {
      return super.withAllocation(owner,request,session=>operation({...session,
        create:async value=>{await mutation?.authorize(sql);await session.create(value)},
        setState:async state=>{await mutation?.authorize(sql);return session.setState(state)},
      }))
    }
  }
  const repository=new GuardedFiles(),bytes=new MemoryBytes(),links=new Map<string,Parameters<JobPublicationLedger['link']>[0]>()
  const originalQuery=f.query.getMockImplementation()!
  f.query.mockImplementation(async(text,args=[])=>{
    if(text.includes('from file_allocations')){
      const allocation=repository.allocations.get(JSON.stringify([args[0],args[1]]))
      if(!allocation)return {rows:[]}
      const value=allocation.stored.value
      if(value.file.fileId!==args[2] || value.revision.revisionId!==args[3] || value.revision.sha256!==args[6] || value.revision.byteSize!==args[7])return {rows:[]}
      return {rows:[{state:value.file.state,allocation_state:allocation.state,expires_at:new Date('expiresAt' in value.file?value.file.expiresAt:0)}]}
    }
    return originalQuery(text,args)
  })
  const ledger:JobPublicationLedger={link:async value=>{
    const previous=links.get(value.requestId)
    if(previous && !isDeepStrictEqual(previous,value))throw new Error('Canonical publication changed')
    links.set(value.requestId,structuredClone(value))
  },list:async(_sql,workspace,execution)=>[...links.values()].filter(link=>link.workspaceId===workspace && link.executionId===execution
    && repository.allocations.get(JSON.stringify([link.ownerPrincipalId,link.requestId]))?.state==='finalized')
    .map(link=>({link,value:repository.values.get(link.ref.fileId)!.value}))}
  const receiver=new ResumableByteTransferService(join(root,'staging'),{authorize:(intent,context)=>f.admission.authorizeTransfer(intent,context)},()=>f.clock().getTime())
  const files=new FileStorageService(repository,bytes as unknown as FileByteStorage,new PostgresJobArtifactScopeAuthorization(f.pool),undefined,f.clock)
  const artifacts=new CanonicalJobArtifactPort(f.pool,files,ledger,{authorizePublication:async(query,input)=>{
    const authorized=await f.authority.authorizePublication(query,input);await f.admission.assertContext(query,input,authorized.execution);return authorized
  }},new VerifiedJobOutputReader(receiver,f.admission),f.clock)
  f.reserve.mockImplementation((input,source)=>artifacts.reserveAccepted(input,source))
  const extension=jobOutputDeviceExtension(f.admission,artifacts,receiver)
  let loseAck=true
  const transferred: string[]=[],published:unknown[]=[]
  const channel={request:async(namespace:string,payload:unknown,options?:{bytes?:Uint8Array})=>{
    expect(namespace).toBe('byte-transfer-v1')
    const method=(payload as {method:string}).method
    if(['start','append','status','finish','cancel'].includes(method))transferred.push(method)
    const result=await extension.handle!(payload,{binding:f.binding,signal:AbortSignal.timeout(10_000),...(options?.bytes?{bytes:options.bytes}:{})})
    if(method==='job-output-publish'){published.push(result.payload);if(loseAck){loseAck=false;throw new Error('Lost finalization ACK')}}
    return result
  }}
  const journal=await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true})
  const closure=RemoteJobOperationReceiptSchema.parse(f.receipt)
  await journal.jobAccept(closure.intent,f.job,closure.connection,randomUUID())
  await journal.jobTerminal(f.job.operationId,closure.terminal!)
  f.input.commandId=await journal.jobOutputCommand(f.job.operationId,{path:f.input.path,mediaType:f.input.mediaType,sha256:f.input.sha256,byteSize:f.input.byteSize})
  const collect=createWorkerJobOutputCollector(channel,{current:async()=>outputTransferContext(f.binding),retryable:()=>false},journal)
  return {...f,repository,bytes,links,transferred,published,collect,
    advanceTime:()=>{f.advance();vi.setSystemTime(f.clock())},
    close:async()=>{await journal.close();await receiver.close();await rm(root,{recursive:true,force:true})}}
}
describe('whole worker collector canonical lost-ACK recovery',()=>{
  it('replays the retained finalized artifact after one hour without invoking sender or creating another revision',async()=>{
    const f=await collectorFixture(),sender=vi.spyOn(ResumableByteTransferSender.prototype,'send')
    try{
      await expect(f.collect(f.job)).rejects.toThrow('Lost finalization ACK')
      expect(sender).toHaveBeenCalledTimes(1);sender.mockClear()
      const first=f.published[0],transfers=f.transferred.length
      expect([...f.repository.allocations.values()].map(value=>value.state)).toEqual(['finalized'])
      f.advanceTime()
      await expect(f.collect(f.job)).resolves.toBeUndefined()
      expect(f.published).toEqual([first,first]);expect(f.transferred).toHaveLength(transfers);expect(sender).not.toHaveBeenCalled()
      expect(f.repository.values.size).toBe(1);expect(f.repository.allocations.size).toBe(1);expect(f.links.size).toBe(1);expect(f.bytes.objects.size).toBe(1)
      expect(f.records.size).toBe(1)
    }finally{await f.close()}
  })
  it('denies expired partial output instead of reopening staging',async()=>{
    const f=await collectorFixture()
    try{
      await f.admission.admit(f.input);f.advanceTime()
      await expect(f.collect(f.job)).rejects.toBeInstanceOf(JobOutputCollectionError)
      await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
      expect(f.transferred).toEqual([]);expect(f.bytes.objects.size).toBe(0)
    }finally{await f.close()}
  })
  it('denies finalized collector replay at the original retention boundary',async()=>{
    const f=await collectorFixture()
    try{
      await expect(f.collect(f.job)).rejects.toThrow('Lost finalization ACK')
      const transfers=f.transferred.length
      f.expire();vi.setSystemTime(f.clock())
      await expect(f.collect(f.job)).rejects.toBeInstanceOf(JobOutputCollectionError)
      expect(f.transferred).toHaveLength(transfers);expect(f.published).toHaveLength(1);expect(f.repository.values.size).toBe(1)
    }finally{await f.close()}
  })
  it('denies foreign and grant-lost finalized retries before sender or canonical publication',async()=>{
    const f=await collectorFixture()
    try{
      await expect(f.collect(f.job)).rejects.toThrow('Lost finalization ACK');f.advanceTime()
      const count=f.transferred.length
      await expect(f.collect({...f.job,attemptId:'foreign-attempt'})).rejects.toThrow()
      f.loseGrant();await expect(f.collect(f.job)).rejects.toMatchObject({code:'ACCESS_DENIED'})
      expect(f.transferred).toHaveLength(count);expect(f.published).toHaveLength(1);expect(f.repository.values.size).toBe(1)
    }finally{await f.close()}
  })
})
