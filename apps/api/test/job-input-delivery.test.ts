import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, stat, readFile, writeFile, symlink, rm, chmod, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { jobExecution } from './helpers/jobFixture.js'
import { ReadonlyJobInputDelivery, type JobInputDeliverySource } from '../src/modules/files/jobInputs/delivery.js'
import { makeManifest, manifestBytes, snapshotDigest } from '../src/modules/files/jobInputs/manifest.js'
import { JobBuildInputManifestSchema, JobInputAdmissionSchema } from '@foreman-code/contracts/job-inputs'
import { AcceptedVerificationJobSpecSchema, VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { JobVerificationRepositoryContextSchema } from '@foreman-code/contracts/job-verification-runtime'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)){await chmod(join(root,'project/.graphql-job-inputs'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true})}})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'job-input-'));roots.push(root);const project=join(root,'project');await mkdir(project)
 const statValue=await stat(project);const fdInfo=await readFile('/proc/self/mountinfo','utf8');const mount=fdInfo.split('\n').filter(line=>{const path=line.split(' ')[4]!;return project===path||project.startsWith(path==='/'?'/':`${path}/`)}).sort((a,b)=>b.split(' ')[4]!.length-a.split(' ')[4]!.length)[0]!.split(' ')[0]!
 const execution=jobExecution();execution.acceptedSpec.target.destination.canonicalProjectRoot=project
 execution.acceptedSpec.target.destination.directoryIdentityHash=digest(Buffer.from(JSON.stringify({device:String(statValue.dev),inode:String(statValue.ino),mountId:mount})))
 const manifest=makeManifest(execution,[]),admission=JobInputAdmissionSchema.parse({version:1,manifest,principalId:'actor',principalGrantsDigest:'1'.repeat(64),issuedAt:'2026-10-01T00:00:00.000Z',transfers:[]})
 let denied=false
 const source:JobInputDeliverySource={admit:async()=>admission,accepted:async()=>admission,recheck:async()=>{if(denied)throw new Error('revoked')},read:async(_execution,_admission,path,offset,length)=>{const bytes=path==='manifest.json'?manifestBytes(manifest):Buffer.from('null');return bytes.subarray(offset,offset+length)}}
 const verified={privateRepositoryRoot:project,directoryIdentityHash:execution.acceptedSpec.target.destination.directoryIdentityHash,privateGit:true as const,diskQuotaBytes:1024*1024}
 return {root,project,execution,manifest,verified,source,deny:()=>{denied=true},delivery:new ReadonlyJobInputDelivery(source,join(root,'receipts'))}
}
describe('immutable job input copies',()=>{
 it('delivers protected verification context before sealing inputs and detects retained tampering',async()=>{
  const f = await fixture()
  const facts = verificationFixture()
  const acceptedSpec = AcceptedVerificationJobSpecSchema.parse({ ...facts.acceptedBuild, ...facts.spec,
    source: facts.acceptedBuild.source, target: f.execution.acceptedSpec.target, schemaVersion: 2,
    profile: facts.profile, reservationId: '11111111-1111-4111-8111-111111111111', lifecycle: facts.lifecycle,
    resourcePolicyRevision: 1, resourcePolicyDigest: 'a'.repeat(64),
    runtimeApprovalId: '11111111-1111-4111-8111-111111111111', runtimeApprovalRevision: 1 })
  const execution = VerificationJobExecutionSchema.parse({ ...f.execution, schemaVersion: 2, acceptedSpec })
  const context = JobVerificationRepositoryContextSchema.parse({
    requiredPortions: [{ key: 'root:install', kind: 'command' }],
    identity: { commit: acceptedSpec.source.commit, manifestDigest: acceptedSpec.source.manifestDigest,
      definitionVersionId: acceptedSpec.definitionVersionId, suite: acceptedSpec.verification.suite,
      executionId: execution.id, attemptId: execution.attemptId, target: acceptedSpec.target,
      profile: acceptedSpec.profile, resources: acceptedSpec.verification.resources,
      parameters: acceptedSpec.verification.parameters },
    privateGit: { sourceCommit: acceptedSpec.source.commit, generatedCommit: 'c'.repeat(40),
      repositoryReceiptDigest: 'a'.repeat(64), configDigest: 'a'.repeat(64), indexDigest: 'a'.repeat(64) },
    executionTimeoutMs: acceptedSpec.policy.executionTimeoutMs,
    cancellationTimeoutMs: acceptedSpec.policy.cancellationGraceMs, qualifiedUnitWorkers: 1,
    limits: { summaryBytes: 1024, junitBytes: 1024, vitestBytes: 1024, logsArchiveBytes: 1024, logBytes: 1024 },
    mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
    preseedReceipt: { lockfileSha256: 'a'.repeat(64), pnpmVersion: '11.27.0', platform: 'linux',
      architecture: 'x64', provenanceDigest: 'a'.repeat(64), minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true },
  })
  const manifest = makeManifest(execution, [], context)
  const admission = JobInputAdmissionSchema.parse({ version: 1, manifest, principalId: 'actor',
    principalGrantsDigest: '1'.repeat(64), issuedAt: '2026-10-01T00:00:00.000Z', transfers: [] })
  const admit = vi.fn<JobInputDeliverySource['admit']>(async (_execution, _signal, received) => {
    expect(received).toEqual(context)
    return admission
  })
  const source: JobInputDeliverySource = { ...f.source, admit, accepted: async () => admission,
    read: async (_execution, _admission, path, offset, length) => {
      const bytes = path === 'manifest.json' ? manifestBytes(manifest)
        : Buffer.from(path === 'verification.json' ? JSON.stringify(context) : 'null')
      return bytes.subarray(offset, offset + length)
    } }
  const delivery = new ReadonlyJobInputDelivery(source, join(f.root, 'receipts'), async () => context)
  const signal = new AbortController().signal
  const receipt = await delivery.prepare(execution, f.verified, signal)
  const path = join(f.project, '.graphql-job-inputs/verification.json')
  expect(receipt.verificationContext?.sha256).toBe(digest(Buffer.from(JSON.stringify(context))))
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(context)
  expect((await stat(join(f.project, '.graphql-job-inputs'))).mode & 0o777).toBe(0o500)
  expect(await delivery.verifyPrepared(execution, f.verified, receipt, signal)).toEqual(receipt)
  await chmod(path, 0o600)
  await writeFile(path, Buffer.alloc(receipt.verificationContext!.byteSize))
  await expect(delivery.verifyPrepared(execution, f.verified, receipt, signal)).rejects.toThrow('hash differs')
 })
 it('delivers empty/manual-null supported inputs with a private receipt and required readonly mount',async()=>{
  const f=await fixture(),receipt=await f.delivery.prepare(f.execution,f.verified,new AbortController().signal)
  expect(receipt.files.map(file=>file.relativePath)).toEqual(['manifest.json','workflow-input.json']);expect(receipt.readonlyMountRequired).toBe(true)
  const build=JobBuildInputManifestSchema.parse(JSON.parse(await readFile(join(f.project,'.graphql-job-inputs/manifest.json'),'utf8')))
  expect(build.inputSnapshotDigest).toBe(snapshotDigest(f.execution));expect(JSON.stringify(build)).not.toContain('grant-fixture')
  expect(await f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).toEqual(receipt)
 })
 it('rejects changed retained bytes on original receipt retry',async()=>{const f=await fixture();await f.delivery.prepare(f.execution,f.verified,new AbortController().signal);await chmod(join(f.project,'.graphql-job-inputs/workflow-input.json'),0o600);await writeFile(join(f.project,'.graphql-job-inputs/workflow-input.json'),'evil');await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('hash differs')})
 it('does not recreate a missing detached directory when the original receipt remains',async()=>{
  const f=await fixture(),signal=new AbortController().signal;await f.delivery.prepare(f.execution,f.verified,signal)
  const path=join(f.project,'.graphql-job-inputs');await chmod(path,0o700);await rm(path,{recursive:true});const read=vi.spyOn(f.source,'read')
  await expect(f.delivery.prepare(f.execution,f.verified,signal)).rejects.toMatchObject({code:'ENOENT'});await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});expect(read).not.toHaveBeenCalled()
 })
 it('reauthorizes original copies after revocation',async()=>{const f=await fixture();await f.delivery.prepare(f.execution,f.verified,new AbortController().signal);f.deny();await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('revoked')})
 it('rejects a source supplied reserved symlink',async()=>{const f=await fixture();await symlink(f.root,join(f.project,'.graphql-job-inputs'));await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('reserved input directory')})
 it('rejects a symlinked host-private receipt',async()=>{const f=await fixture();await mkdir(join(f.root,'receipts'),{mode:0o700});const destination=join(f.root,'external');await writeFile(destination,'{}');await symlink(destination,join(f.root,'receipts',`${f.manifest.bindingId}.json`));await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow()})
 it('rejects accepted directory identity changes',async()=>{const f=await fixture();f.verified.directoryIdentityHash='0'.repeat(64);await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('previously verified')})
})
describe('read-only prepared job input verification',()=>{
 it('returns the original receipt without changing retained files or reading transfer bytes',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal)
  const paths=[f.project,join(f.project,'.graphql-job-inputs'),join(f.project,'.graphql-job-inputs/manifest.json'),join(f.project,'.graphql-job-inputs/workflow-input.json'),join(f.root,'receipts'),join(f.root,'receipts',`${f.manifest.bindingId}.json`)]
  const attributes=async()=>Promise.all(paths.map(async path=>{const value=await stat(path);return {ino:value.ino,mode:value.mode,size:value.size,mtime:value.mtimeMs}}))
  const before=await attributes(),read=vi.spyOn(f.source,'read'),admit=vi.spyOn(f.source,'admit'),recheck=vi.spyOn(f.source,'recheck')
  expect(await f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).toEqual(receipt)
  expect(await attributes()).toEqual(before);expect(read).not.toHaveBeenCalled();expect(admit).not.toHaveBeenCalled();expect(recheck).toHaveBeenCalledTimes(2)
 })
 it.each(['receipts','receipt','directory','file'] as const)('rejects missing %s without repairing it',async missing=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal)
  const path=missing==='receipts'?join(f.root,'receipts'):missing==='receipt'?join(f.root,'receipts',`${f.manifest.bindingId}.json`):missing==='directory'?join(f.project,'.graphql-job-inputs'):join(f.project,'.graphql-job-inputs/workflow-input.json')
  await chmod(join(f.project,'.graphql-job-inputs'),0o700);await rm(path,{recursive:true})
  const read=vi.spyOn(f.source,'read');await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow()
  await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});expect(read).not.toHaveBeenCalled()
 })
 it('rejects tampered retained bytes',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),path=join(f.project,'.graphql-job-inputs/workflow-input.json')
  await chmod(path,0o600);await writeFile(path,'evil')
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow('hash differs')
 })
 it.each(['caller','persisted'] as const)('rejects a substituted %s receipt',async replacement=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),changed={...receipt,manifestByteSize:receipt.manifestByteSize+1}
  if(replacement==='persisted'){const path=join(f.root,'receipts',`${f.manifest.bindingId}.json`);await chmod(path,0o600);await writeFile(path,JSON.stringify(changed))}
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,replacement==='caller'?changed:receipt,signal)).rejects.toThrow('differs from the original')
 })
 it('rejects a receipt that consistently substitutes manifest facts in memory and on disk',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),changed={...receipt,manifestByteSize:receipt.manifestByteSize+1},path=join(f.root,'receipts',`${f.manifest.bindingId}.json`)
  await chmod(path,0o600);await writeFile(path,JSON.stringify(changed))
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,changed,signal)).rejects.toThrow('different accepted data')
 })
 it.each(['source','inputs'] as const)('rejects a substituted %s directory',async replacement=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),path=replacement==='source'?f.project:join(f.project,'.graphql-job-inputs')
  await chmod(join(f.project,'.graphql-job-inputs'),0o700);await rename(path,`${path}-original`);await mkdir(path)
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow(replacement==='source'?'Actual private source identity':'Original input directory identity')
 })
 it.each(['receipt','receipts','file','inputs'] as const)('rejects a substituted %s symlink',async replacement=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal)
  const path=replacement==='receipt'?join(f.root,'receipts',`${f.manifest.bindingId}.json`):replacement==='receipts'?join(f.root,'receipts'):replacement==='file'?join(f.project,'.graphql-job-inputs/workflow-input.json'):join(f.project,'.graphql-job-inputs')
  await chmod(join(f.project,'.graphql-job-inputs'),0o700);await rename(path,`${path}-original`);await symlink(`${path}-original`,path)
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow()
 })
 it('rejects a substituted accepted execution',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),changed=structuredClone(f.execution)
  changed.attemptId='different-attempt'
  await expect(f.delivery.verifyPrepared(changed,f.verified,receipt,signal)).rejects.toThrow('replace accepted job input')
 })
 it('rejects revoked authority before and after retained file verification',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal)
  vi.spyOn(f.source,'recheck').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'))
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow('revoked')
  f.deny();await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow('revoked')
 })
 it('rejects cancellation before and during verification',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),controller=new AbortController()
  controller.abort();const admit=vi.spyOn(f.source,'admit')
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,controller.signal)).rejects.toThrow();expect(admit).not.toHaveBeenCalled()
  const during=new AbortController();vi.spyOn(f.source,'recheck').mockImplementation(async()=>{during.abort()})
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,during.signal)).rejects.toThrow()
 })
 it('fails closed when the read-only admission accessor is unavailable',async()=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),admit=vi.spyOn(f.source,'admit')
  delete f.source.accepted
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,receipt,signal)).rejects.toThrow('Read-only original input admission is unavailable');expect(admit).not.toHaveBeenCalled()
 })
 it.each(['device','mountId'] as const)('rejects substituted retained directory %s facts',async key=>{
  const f=await fixture(),signal=new AbortController().signal,receipt=await f.delivery.prepare(f.execution,f.verified,signal),changed={...receipt,directory:{...receipt.directory,[key]:`${receipt.directory[key]}0`}},path=join(f.root,'receipts',`${f.manifest.bindingId}.json`)
  await chmod(path,0o600);await writeFile(path,JSON.stringify(changed))
  await expect(f.delivery.verifyPrepared(f.execution,f.verified,changed,signal)).rejects.toThrow('Original input directory identity changed')
 })
})
