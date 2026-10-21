import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { preparePrivateJobRepositoryMounts, verifyPrivateJobRepositoryMounts } from './repository.js'
// Original Git's qualified HEAD readback is a unit boundary; all file/receipt and inode checks are real.
vi.mock('./capture.js',()=>({qualifiedGit:vi.fn(async()=>Buffer.from('4'.repeat(40)+'\n'))}))
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture() {
  const root=await mkdtemp('/tmp/job-git-source-');roots.push(root)
  const execution=jobExecution(),bytes=Buffer.from('original source'),manifest=createSourceManifest({version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),capturePolicy:'git-tree-v1',executablePolicy:'strip',git:{commit:execution.acceptedSpec.source.commit,tree:'3'.repeat(40),objectFormat:'sha1'},entries:[{path:'source.txt',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}],deletions:[]})
  const parent=await openPrivateRoot(root),filesystem=await identity(parent);await parent.close()
  const binding:RootBinding={version:1,mainId:execution.acceptedSpec.target.mainId,deviceId:null,workerInstallationId:null,workspaceId:execution.workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,canonicalPath:root,filesystem,accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest}
  const attempt={placementHash:'a'.repeat(64),executionId:execution.id,attemptId:execution.attemptId,keyRevision:null,authorizationRevision:null}
  const reauthorize=vi.fn(async()=>{}),materializer=new PrivateSourceMaterializer({read:async()=>bytes},reauthorize)
  const receipt=await materializer.prepare({manifest,binding,attempt}),directory=join(root,receipt.materializationId),git=join(directory,'repository')
  await mkdir(git,{mode:0o700})
  await writeFile(join(git,'config'),'original config',{mode:0o644});await writeFile(join(git,'index'),'original index',{mode:0o644});await writeFile(join(git,'HEAD'),'4'.repeat(40)+'\n',{mode:0o644})
  await writeFile(join(directory,'repository-receipt.json'),JSON.stringify({materializationId:receipt.materializationId,manifestDigest:manifest.manifestDigest,receiptDigest:sourceSha256(Buffer.from(JSON.stringify(receipt))),generatedCommit:'4'.repeat(40),configDigest:sourceSha256(Buffer.from('original config'))}),{mode:0o600})
  const record:SourceMaterializationRecord={receipt,operationId:execution.operationId,reservationId:randomUUID(),sourceBindingHash:attempt.placementHash,finalDispatchBindingHash:execution.acceptedSpec.bindingHash,rootPolicyId:execution.acceptedSpec.target.destination.rootPolicyId,rootPolicyRevision:'1',state:'prepared'}
  execution.acceptedSpec.source={...execution.acceptedSpec.source,materializationId:receipt.materializationId,materializationDigest:sourceMaterializationDigest(record)}
  execution.acceptedSpec.target.destination.canonicalProjectRoot=join(directory,'tree');execution.acceptedSpec.target.destination.canonicalCwd=join(directory,'tree')
  return {root,directory,git,execution,record,attempt,materializer,reauthorize,input:{record,execution,attempt,materializer,reauthorize}}
}
describe('original Job Git scheduler reservation (filesystem only, no native Job)',()=>{
  it('reserves once, pins original owner and keeps Git/source bytes unchanged through scheduler writes',async()=>{
    const f=await fixture(),config=await readFile(join(f.git,'config')),index=await readFile(join(f.git,'index')),head=await readFile(join(f.git,'HEAD'))
    const mounts=await preparePrivateJobRepositoryMounts(f.input)
    expect(await preparePrivateJobRepositoryMounts(f.input)).toEqual(mounts)
    await writeFile(join(mounts.scheduler.directory,'held-state'),'original scheduler queue',{mode:0o600})
    await expect(verifyPrivateJobRepositoryMounts(f.execution,mounts)).resolves.toBeUndefined()
    expect(await readFile(join(f.git,'config'))).toEqual(config);expect(await readFile(join(f.git,'index'))).toEqual(index);expect(await readFile(join(f.git,'HEAD'))).toEqual(head)
    expect(await readdir(join(f.git,'graphql-heavy-jobs'))).toEqual([])
    expect(await readdir(f.execution.acceptedSpec.target.destination.canonicalProjectRoot)).toEqual(['source.txt'])
  })
  it('denies another owner/spec and a substituted scheduler inode without reopening or cleanup',async()=>{
    const f=await fixture(),mounts=await preparePrivateJobRepositoryMounts(f.input)
    await expect(preparePrivateJobRepositoryMounts({...f.input,execution:{...f.execution,owner:{grantId:'changed',epoch:'2'}}})).rejects.toMatchObject({code:'SOURCE_REPOSITORY_CONFLICT'})
    await expect(verifyPrivateJobRepositoryMounts({...f.execution,acceptedSpec:{...f.execution.acceptedSpec,specDigest:'0'.repeat(64)}},mounts)).rejects.toThrow('another original')
    await rename(mounts.scheduler.directory,mounts.scheduler.directory+'.original');await mkdir(mounts.scheduler.directory,{mode:0o700})
    await expect(verifyPrivateJobRepositoryMounts(f.execution,mounts)).rejects.toThrow('identity changed')
    expect(await readFile(join(f.directory,'job-heavy-jobs-claim.json'),'utf8')).toContain(f.execution.id)
  })
  it('denies symlink mountpoints and retains the write-ahead claim on interrupted initialization',async()=>{
    const f=await fixture();await symlink(f.directory,join(f.git,'graphql-heavy-jobs'))
    await expect(preparePrivateJobRepositoryMounts(f.input)).rejects.toThrow()
    expect(await readFile(join(f.directory,'job-heavy-jobs-claim.json'),'utf8')).toContain(f.execution.id)
    await expect(preparePrivateJobRepositoryMounts(f.input)).rejects.toThrow()
    expect(await readdir(f.directory)).toContain('job-heavy-jobs-claim.json')
  })
  it('denies changed config/index/HEAD and missing owner receipt while preserving held files',async()=>{
    for(const name of ['config','index','HEAD']) {
      const f=await fixture(),mounts=await preparePrivateJobRepositoryMounts(f.input)
      await writeFile(join(f.git,name),'changed')
      await expect(verifyPrivateJobRepositoryMounts(f.execution,mounts)).rejects.toThrow()
      expect(await readdir(f.directory)).toContain('job-heavy-jobs')
    }
    const f=await fixture(),mounts=await preparePrivateJobRepositoryMounts(f.input)
    await rm(join(f.directory,'job-heavy-jobs-receipt.json'))
    await expect(verifyPrivateJobRepositoryMounts(f.execution,mounts)).rejects.toThrow()
    await expect(preparePrivateJobRepositoryMounts(f.input)).rejects.toThrow()
  })
  it('checks current original authority before any scheduler reservation',async()=>{
    const f=await fixture();f.reauthorize.mockRejectedValue(new Error('revoked original authority'))
    await expect(preparePrivateJobRepositoryMounts(f.input)).rejects.toThrow('revoked original authority')
    expect(await readdir(f.directory)).not.toContain('job-heavy-jobs-claim.json')
  })
})
