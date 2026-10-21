import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type pg from 'pg'
import { describe, it, expect, vi } from 'vitest'
import { FileWithRevisionSchema, MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { JobArtifactSchema } from '@foreman-code/contracts/jobs'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { FileStorageService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import type { FileMutationContext, AllocationSession } from '../src/modules/files/repository.js'
import { FileUploadRequestSchema } from '@foreman-code/contracts/files'
import { CiOutputByteStorage } from '../src/modules/files/jobs/byteStorage.js'
import { CanonicalJobArtifactPort, type JobPublicationLink, type JobPublicationLedger } from '../src/modules/files/jobs/port.js'
import { PostgresJobArtifactScopeAuthorization } from '../src/modules/files/jobs/factory.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import { MemoryFiles, MemoryBytes } from './support/fileTools.js'
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const execution=jobExecution(); execution.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true}
  execution.finishedAt=execution.createdAt; execution.acceptedSpec.outputs=[{path:'dist/index.html',mediaType:'text/html',required:true}]
  const principal=ManagementPrincipalSchema.parse({id:'job-owner',name:'Job owner',audience:'operator',
    grants:[{actions:['jobs:start','job_artifacts:read'],scope:{workspaceIds:[execution.workspaceId]}}],expiresAt:'2099-01-01T00:00:00Z',revokedAt:null})
  let revoked=false,now=new Date(execution.createdAt)
  const query=vi.fn(async(sql:string,params?:unknown[])=>{
    if(sql.startsWith('select coalesce(sum')) return {rows:[{total:String([...repository.allocations.values()].filter(a=>a.requestId!==params?.[2]&&a.state!=='canceled').reduce((sum,a)=>sum+a.stored.value.revision.byteSize,0))}]}
    if(sql.includes('management_principals')) return {rows:[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:revoked?new Date():null,delegated_from:null}]}
    if(sql.startsWith('select record,accepted_spec')) return {rows:[{record:structuredClone(execution),accepted_spec:structuredClone(execution.acceptedSpec)}]}
    if(sql.startsWith('select record from job_definition_versions')) return {rows:[{record:{schemaVersion:1,id:execution.acceptedSpec.definitionId,workspaceId:execution.workspaceId,name:'Original',revision:execution.acceptedSpec.definitionRevision,versionId:execution.acceptedSpec.definitionVersionId,spec:{...jobSpec(),outputs:execution.acceptedSpec.outputs},createdAt:execution.createdAt,updatedAt:execution.createdAt}}]}
    if(sql.startsWith('select accepted_by')) return {rows:[{accepted_by:principal.id}]}
    return {rows:[],rowCount:0}
  })
  const sql={query} as unknown as import('../src/modules/jobs/repository.js').JobSql
  const pool={query,connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool
  class GuardedFiles extends MemoryFiles {
    override withAllocation<T>(owner:string,request:string,operation:(session:AllocationSession)=>Promise<T>,mutation?:FileMutationContext):Promise<T> {
      return super.withAllocation(owner,request,session=>operation({...session,
        create:async value=>{await mutation?.authorize(sql);await session.create(value)},
        setState:async state=>{await mutation?.authorize(sql);return session.setState(state)},
      }))
    }
  }
  const repository=new GuardedFiles(),bytes=new MemoryBytes(),links=new Map<string,JobPublicationLink>()
  const ledger:JobPublicationLedger={
    async link(value){const old=links.get(value.requestId);if(old&&old.inputHash!==value.inputHash)throw new DomainError('FILE_REQUEST_CONFLICT','conflict',409)
      if([...links.values()].some(link=>link.binding===value.binding&&link.path===value.path&&link.requestId!==value.requestId))throw new DomainError('FILE_REQUEST_CONFLICT','conflict',409)
      links.set(value.requestId,structuredClone(value))},
    async list(_sql,workspace,id){return [...links.values()].filter(link=>link.workspaceId===workspace&&link.executionId===id
      &&repository.allocations.get(JSON.stringify([link.ownerPrincipalId,link.requestId]))?.state==='finalized')
      .map(link=>({link,value:repository.values.get(link.ref.fileId)!.value}))},
  }
  const runtime={require:vi.fn(async()=>{})},preparation={revalidateAccepted:vi.fn(async()=>{})}
  const authority=new JobPublicationAuthority(runtime,preparation as never)
  const files=new FileStorageService(repository,bytes as unknown as FileByteStorage,new PostgresJobArtifactScopeAuthorization(pool),undefined,()=>now)
  const reader={open:vi.fn(async()=>Readable.from([Buffer.from('<html>result</html>')]))}
  const port=new CanonicalJobArtifactPort(pool,files,ledger,authority,reader,()=>now)
  const input={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,owner:execution.owner,
    commandId:randomUUID(),path:'dist/index.html',mediaType:'text/html' as const,sha256:hash('<html>result</html>'),byteSize:19}
  return {execution,principal,query,sql,pool,repository,bytes,links,runtime,preparation,reader,port,input,
    revoke:()=>{revoked=true},advance:(milliseconds=3600_000)=>{now=new Date(now.getTime()+milliseconds)}}
}
describe('canonical job artifact publication and read port',()=>{
  it('reads the original persisted expiry across publication retry and current lifecycle changes',async()=>{
    const f=await fixture();const published=await f.port.publishAccepted(f.input)
    const stored=f.repository.values.get(published.artifact.fileId)!
    expect('expiresAt' in stored.value.file).toBe(true)
    if(!('expiresAt' in stored.value.file)) throw new Error('Expected canonical job retention expiry')
    const expiresAt=stored.value.file.expiresAt
    expect(published.artifact).toMatchObject({expiresAt,state:'available'})
    f.advance(1000)
    const replay=await f.port.publishAccepted(f.input,'mcp')
    expect(replay).toMatchObject({replayed:true,artifact:{expiresAt}})
    const read=await f.port.read(f.sql,f.principal,f.execution.workspaceId,f.execution.id,published.artifact.fileId,published.artifact.revisionId,'mcp')
    expect(JobArtifactSchema.parse(read.artifact)).toMatchObject({expiresAt,state:'available'})
    f.advance()
    const listed=await f.port.list(f.sql,f.principal,f.execution.workspaceId,f.execution.id)
    expect(JobArtifactSchema.parse(listed[0])).toMatchObject({expiresAt,state:'expired'})
    stored.value.file.state='removed'
    expect(await f.port.list(f.sql,f.principal,f.execution.workspaceId,f.execution.id)).toMatchObject([{expiresAt,state:'tombstoned'}])
  })
  it('publishes standalone explicit CI scope, persists one logical receipt and replays without worker bytes',async()=>{
    const f=await fixture(); const first=await f.port.publishAccepted(f.input)
    expect(first.artifact).toMatchObject({executionId:f.execution.id,mediaType:'text/html',state:'available'})
    const stored=f.repository.values.get(first.artifact.fileId)!
    expect(stored.value.file.scope).toEqual({kind:'job_execution',workspaceId:f.execution.workspaceId,jobExecutionId:f.execution.id})
    expect(stored.value.revision).toMatchObject({byteClass:'ci-output',origin:'job_output'})
    expect('chat' in stored.value.file.scope).toBe(false);expect(f.execution.workflow).toBe(null)
    f.reader.open.mockRejectedValue(new Error('worker offline'))
    const replay=await f.port.publishAccepted(f.input,'mcp')
    expect(replay).toMatchObject({replayed:true,artifact:{fileId:first.artifact.fileId,revisionId:first.artifact.revisionId}})
    expect(f.links.size).toBe(1);expect(f.repository.allocations.size).toBe(1);expect(f.reader.open).toHaveBeenCalledTimes(1)
    await f.port.verifyRequiredOutputs(f.sql,f.execution)
    const read=await f.port.read(f.sql,f.principal,f.execution.workspaceId,f.execution.id,first.artifact.fileId,first.artifact.revisionId)
    expect(read.bytes.toString()).toBe('<html>result</html>')
    f.advance();expect((await f.port.list(f.sql,f.principal,f.execution.workspaceId,f.execution.id))[0]!.state).toBe('expired')
    await expect(f.port.read(f.sql,f.principal,f.execution.workspaceId,f.execution.id,first.artifact.fileId,first.artifact.revisionId)).rejects.toMatchObject({code:'FILE_BYTES_UNAVAILABLE'})
  })
  it('denies unclosed, stale, undeclared, root-invalid and revoked publications before byte opening',async()=>{
    const f=await fixture();f.execution.process.processStopped=false
    await expect(f.port.publishAccepted(f.input)).rejects.toMatchObject({code:'JOB_OUTPUT_NOT_QUIESCENT'})
    f.execution.process.processStopped=true
    await expect(f.port.publishAccepted({...f.input,attemptId:'old'})).rejects.toMatchObject({code:'JOB_STALE_ATTEMPT'})
    await expect(f.port.publishAccepted({...f.input,path:'other.html'})).rejects.toMatchObject({code:'JOB_OUTPUT_SPEC_MISMATCH'})
    f.preparation.revalidateAccepted.mockRejectedValue(new DomainError('JOB_AUTHORITY_CHANGED','Accepted source or root authority is no longer valid.',409))
    await expect(f.port.publishAccepted(f.input)).rejects.toMatchObject({code:'JOB_AUTHORITY_CHANGED'})
    f.revoke();await expect(f.port.publishAccepted(f.input)).rejects.toMatchObject({code:'AUTH_REVOKED'})
    expect(f.reader.open).not.toHaveBeenCalled();expect(f.repository.allocations.size).toBe(0)
  })
  it('reauthorizes metadata commit after stream I/O and never makes denied bytes discoverable',async()=>{
    const f=await fixture();f.reader.open.mockImplementation(async()=>{
      return Readable.from((async function*(){yield Buffer.from('<html>result</html>');f.revoke()})())
    })
    await expect(f.port.publishAccepted(f.input)).rejects.toMatchObject({code:'AUTH_REVOKED'})
    expect([...f.repository.allocations.values()].map(value=>value.state)).toEqual(['allocated'])
    expect([...f.repository.values.values()].map(value=>value.value.file.state)).toEqual(['pending'])
    expect(f.bytes.objects.size).toBe(0)
  })
  it('enforces aggregate reservation budget and verifies required backing bytes before completion',async()=>{
    const f=await fixture();await f.port.publishAccepted(f.input)
    f.execution.acceptedSpec.policy.maxOutputBytes=30
    f.execution.acceptedSpec.outputs.push({path:'dist/second.html',mediaType:'text/html',required:true})
    await expect(f.port.publishAccepted({...f.input,path:'dist/second.html',commandId:randomUUID()})).rejects.toMatchObject({code:'JOB_OUTPUT_BUDGET_EXCEEDED'})
    f.execution.acceptedSpec.outputs.pop()
    f.bytes.objects.clear();f.bytes.download=async()=>{throw new DomainError('FILE_BYTES_UNAVAILABLE','missing',410)}
    await expect(f.port.verifyRequiredOutputs(f.sql,f.execution)).rejects.toMatchObject({code:'JOB_REQUIRED_OUTPUT_CORRUPT'})
  })
  it('rejects changed request, duplicate output keys and wrong exact revision',async()=>{
    const f=await fixture();const published=await f.port.publishAccepted(f.input)
    await expect(f.port.publishAccepted({...f.input,sha256:hash('changed')})).rejects.toMatchObject({code:'FILE_REQUEST_CONFLICT'})
    await expect(f.port.publishAccepted({...f.input,commandId:randomUUID()})).rejects.toMatchObject({code:'FILE_REQUEST_CONFLICT'})
    await expect(f.port.read(f.sql,f.principal,f.execution.workspaceId,f.execution.id,published.artifact.fileId,'latest')).rejects.toMatchObject({code:'JOB_ARTIFACT_NOT_FOUND'})
    f.principal.grants=[]
    await expect(f.port.list(f.sql,f.principal,f.execution.workspaceId,f.execution.id)).rejects.toMatchObject({code:'ACCESS_DENIED'})
  })
})
describe('explicit CI byte capability preserves document policy',()=>{
  it('validates JSON/HTML/plain/gzip/binary separately and documents reject CI MIME/class',async()=>{
    const root=await mkdtemp(join(process.cwd(),'.ci-output-bytes-'))
    const ci=new CiOutputByteStorage(root,MAX_FILE_BYTES),documents=new FileByteStorage(root,MAX_FILE_BYTES)
    try {
      for(const [mediaType,data] of [['text/plain',Buffer.from('ok\n')],['text/html',Buffer.from('<html>ok</html>')],['application/json',Buffer.from('{"ok":true}')],['application/gzip',gzipSync('output')],['application/octet-stream',Buffer.from([0,255,1])]] as const) {
        const expected={byteClass:'ci-output' as const,filename:'output.bin',mediaType,byteSize:data.length,sha256:hash(data)},id=randomUUID()
        const candidate=await ci.receive(id,Readable.from([data]),expected);await ci.stage(candidate,expected);await ci.discard(candidate);await ci.finalize(id,expected)
        const bytes=[];for await(const chunk of await ci.download(id,expected))bytes.push(chunk as Buffer)
        expect(Buffer.concat(bytes)).toEqual(data)
        await expect(documents.receive(randomUUID(),Readable.from([data]),expected)).rejects.toMatchObject({code:'FILE_BYTE_CLASS_DENIED'})
        expect(FileUploadRequestSchema.safeParse({requestId:'request',filename:'output.bin',mediaType,byteSize:data.length,sha256:hash(data)}).success).toBe(false)
      }
      const bomb=gzipSync('x'.repeat(32768)),bombExpected={byteClass:'ci-output' as const,filename:'bomb.gz',mediaType:'application/gzip' as const,byteSize:bomb.length,sha256:hash(bomb)}
      await expect(ci.receive(randomUUID(),Readable.from([bomb]),bombExpected)).rejects.toMatchObject({code:'JOB_ARTIFACT_TYPE_INVALID'})
      const invalid=Buffer.from('{broken'),id=randomUUID(),expected={byteClass:'ci-output' as const,filename:'bad.json',mediaType:'application/json' as const,byteSize:invalid.length,sha256:hash(invalid)}
      await expect(ci.receive(id,Readable.from([invalid]),expected)).rejects.toMatchObject({code:'JOB_ARTIFACT_TYPE_INVALID'})
      expect(await readdir(join(root,'staging',id))).toEqual([])
      await expect(ci.receive(randomUUID(),Readable.from([Buffer.from('ok')]),{filename:'ok.md',mediaType:'text/markdown',sha256:hash('ok'),byteSize:2})).rejects.toMatchObject({code:'FILE_BYTE_CLASS_DENIED'})
      expect(FileWithRevisionSchema.safeParse({file:{fileId:'f',currentRevisionId:'r',createdAt:'2026-10-01T00:00:00Z',scope:{kind:'workspace_reference',workspaceId:'w'},state:'ready'},revision:{byteClass:'ci-output',fileId:'f',revisionId:'r',createdAt:'2026-10-01T00:00:00Z',filename:'index.html',mediaType:'text/html' as const,sha256:hash('ok'),byteSize:2,origin:'job_output'}}).success).toBe(false)
    } finally {await rm(root,{recursive:true,force:true})}
  })
})
