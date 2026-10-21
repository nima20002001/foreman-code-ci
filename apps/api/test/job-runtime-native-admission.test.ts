import { describe,expect,it,vi } from 'vitest'
import type pg from 'pg'
import { createJobRuntimeProfileService,type InstalledJobRuntimeHost } from '../src/modules/jobs/runtimeProfileFactory.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobRuntimeProfileSchema,JobRuntimeFingerprintSchema,JobRuntimeApprovalSchema,type JobRuntimeNativeAdmission } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { admitInstalledJobQualification,assertInstalledJobQualification,assertInstalledJobQualificationRead } from '../src/modules/jobs/runtimeQualificationAdmission.js'
import { jobDigest } from '../src/modules/jobs/service.js'
import { jobSpec } from './helpers/jobFixture.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import type { JobQualificationCandidate } from '../src/modules/jobs/qualification.js'
const uuid='11111111-1111-4111-8111-111111111111',digest='1'.repeat(64)
const principal:ManagementPrincipal={id:'runtime-reader',name:'Runtime reader',audience:'operator',grants:[{actions:['job_definitions:read','job_definitions:write'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:uuid,snapshotId:uuid,manifestDigest:digest},selection:{hostRef:{kind:'main',mainId:uuid},rootPolicyId:'root-policy',rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:uuid,deviceId:null,workerInstallationId:null,workspaceId:'workspace-fixture',rootId:uuid,bindingRevision:1,locationRevision:1,canonicalPath:'/approved',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write',snapshotId:uuid,manifestDigest:digest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:'actual-test-attestation',attestationDigest:digest,boundAt:'2026-10-01T00:00:00.000Z'})
const profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id:'runtime-profile',workspaceId:'workspace-fixture',revision:1,name:'Runtime metadata',root,policy:{...jobSpec().policy,isolationPolicyId:'runtime-profile',maxWorkerSpoolBytes:131072},limits:{cpuLimit:1,memoryBytes:1024,pidsLimit:32,diskBytes:2097152},specDigest:digest,status:'unqualified',measurement:null,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
const fingerprint=JobRuntimeFingerprintSchema.parse({schemaVersion:1,profileId:profile.id,profileRevision:1,specDigest:digest,hostRef:root.selection.hostRef,registration:null,mainInstallationId:uuid,bootId:uuid,root,runtimeExecutable:'/usr/bin/podman',runtimeBinarySha256:digest,ociExecutable:'/usr/bin/crun',ociBinarySha256:digest,configurationDigest:digest,imageDigest:profile.policy.imageDigest,toolchainDigest:digest,limits:profile.limits})
const approval=JobRuntimeApprovalSchema.parse({schemaVersion:1,id:uuid,qualificationId:uuid,workspaceId:profile.workspaceId,profileId:profile.id,profileRevision:1,fingerprint,fingerprintDigest:digest,requestedByPrincipalId:principal.id,status:'awaiting-approval',approvedByPrincipalId:null,approvedAt:null,expiresAt:'2099-01-01T00:00:00.000Z'})

function setup() {
  const approved={...approval,status:'approved' as const,fingerprintDigest:jobDigest(fingerprint),approvedByPrincipalId:principal.id,approvedAt:'2026-10-01T00:00:00.000Z'}
  const state={approval:{...approved,status:'qualifying' as const},receipt:approved,runCommandId:'actual-command',revoked:false,expired:false,profile:{...profile},nativeAdmission:null as JobRuntimeNativeAdmission|null}
  const query=vi.fn(async(text:string,args?:unknown[])=>{
    let rows:unknown[]=[]
    if(text.includes('from job_runtime_qualification_approvals'))rows=[{record:state.expired?{...state.approval,expiresAt:'2020-01-01T00:00:00Z'}:state.approval,run_command_id:state.runCommandId,run_principal_id:principal.id,approved_by:principal.id,native_admission:state.nativeAdmission}]
    else if(text.includes('from management_principals'))rows=[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:state.revoked?new Date():null,delegated_from:null}]
    else if(text.includes('select archived_at'))rows=[{archived_at:null}]
    else if(text.includes('from management_command_receipts'))rows=state.receipt?[{result:state.receipt}]:[]
    else if(text.includes('from job_runtime_profile_versions'))rows=[{record:state.profile}]
    else if(text.includes('from job_runtime_profiles'))rows=[{record:state.profile}]
    else if(text.includes('from application_installation'))rows=[{id:uuid}]
    else if(text.includes('from source_root_catalog'))rows=[{exists:1}]
    else if(text.startsWith('update job_runtime_qualification_approvals set native_admission'))state.nativeAdmission=JSON.parse(args![1] as string)
    return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
  })
  const input={candidate:{approvalId:uuid,qualificationId:uuid,operationId:uuid,fingerprint} as JobQualificationCandidate,
    runCommandId:'actual-command',runPrincipalId:principal.id,resolveRoot:vi.fn(async()=>root),readCurrent:vi.fn(async()=>({fingerprint,connection:null}))}
  return {state,input,query,sql:{query} as JobSql}
}
describe('Main persisted qualification admission (no native IO)',()=>{
  it('retains one lease on its original approved row and retries/read assertions reuse it',async()=>{
    const f=setup(),first=await admitInstalledJobQualification(f.sql,f.input)
    expect(first).toMatchObject({kind:'job-runtime-qualification',runCommandId:'actual-command',runPrincipalId:principal.id,connection:null})
    expect(f.state.nativeAdmission).toEqual(first)
    expect(await admitInstalledJobQualification(f.sql,f.input)).toEqual(first)
    await assertInstalledJobQualification(f.sql,f.input,first)
    expect(f.query.mock.calls.filter(([text])=>text.startsWith('update job_runtime_qualification_approvals set native_admission'))).toHaveLength(1)
  })
  it('assert never mints an absent lease',async()=>{
    const f=setup()
    await expect(admitInstalledJobQualification(f.sql,f.input,{ access: 'launch', requireExisting: true })).rejects.toMatchObject({code:'JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT'})
    expect(f.state.nativeAdmission).toBeNull()
  })
  it.each(['owner','expired','revoked','profile','root','host','candidate'] as const)('denies changed %s before minting',async change=>{
    const f=setup()
    if(change==='owner')f.state.runCommandId='different-command'
    if(change==='expired')f.state.expired=true
    if(change==='revoked')f.state.revoked=true
    if(change==='profile')f.state.profile.revision++
    if(change==='root')f.input.resolveRoot.mockResolvedValue({...root,binding:{...root.binding,workspaceId:'other-workspace'}})
    if(change==='host')f.input.readCurrent.mockResolvedValue({fingerprint:{...fingerprint,bootId:'22222222-2222-4222-8222-222222222222'},connection:null})
    if(change==='candidate')f.state.approval={...f.state.approval,fingerprintDigest:'2'.repeat(64)}
    await expect(admitInstalledJobQualification(f.sql,f.input)).rejects.toThrow()
    expect(f.state.nativeAdmission).toBeNull()
  })
  it('result reconciliation retains the admitted lease and still enforces live scoped permission', async () => {
    const f = setup()
    const original = await admitInstalledJobQualification(f.sql, f.input)
    await expect(assertInstalledJobQualificationRead(f.sql, f.input, original)).resolves.toBeUndefined()
    expect(f.state.nativeAdmission).toEqual(original)
    await expect(assertInstalledJobQualificationRead(f.sql, f.input,
      { ...original, leaseId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow()
    f.state.revoked = true
    await expect(assertInstalledJobQualificationRead(f.sql, f.input, original)).rejects.toThrow()
    expect(f.state.nativeAdmission).toEqual(original)
  })
  it('reads original cleanup authority after expiry and a profile edit without issuing another lease', async () => {
    const f = setup()
    const startedAt = Date.now()
    f.state.approval.expiresAt = new Date(startedAt + 60_000).toISOString()
    const original = await admitInstalledJobQualification(f.sql,f.input)
    const now = vi.spyOn(Date,'now').mockReturnValue(startedAt + 120_000)
    try {
      f.state.profile = { ...f.state.profile,revision:2,specDigest:'2'.repeat(64) }
      await expect(assertInstalledJobQualificationRead(f.sql,f.input,original)).resolves.toBeUndefined()
      await expect(assertInstalledJobQualification(f.sql,f.input,original)).rejects.toThrow()
      expect(f.state.nativeAdmission).toEqual(original)
      expect(f.input.readCurrent).toHaveBeenCalledOnce()
      f.state.revoked = true
      await expect(assertInstalledJobQualificationRead(f.sql,f.input,original)).rejects.toThrow()
    } finally { now.mockRestore() }
  })
  it('retained lease cannot survive changed current context or be replaced',async()=>{
    const f=setup(),first=await admitInstalledJobQualification(f.sql,f.input)
    await expect(assertInstalledJobQualification(f.sql,f.input,{...first,leaseId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow()
    f.state.revoked=true
    await expect(admitInstalledJobQualification(f.sql,f.input)).rejects.toThrow()
    expect(f.state.nativeAdmission).toEqual(first)
  })
  it('uses the original local recovery owner after expiry and a profile edit without inspecting or launching', async () => {
    const f = setup()
    const startedAt = Date.now()
    f.state.approval.expiresAt = new Date(startedAt + 60_000).toISOString()
    const original = await admitInstalledJobQualification(f.sql,f.input)
    f.state.profile = { ...f.state.profile,revision:2,specDigest:'2'.repeat(64) }
    const nativeWork = vi.fn(async () => { throw new Error('Recovery attempted a new qualification') })
    const reconcile = vi.fn<NonNullable<InstalledJobRuntimeHost['reconcileQualification']>>(async input => {
      expect(input.nativeAdmission).toEqual(original)
      await input.assertAdmission()
      return { outcome:'denied' as const,closure:'confirmed' as const,reasons:['Original owner closed'] }
    })
    const commands = { execute:async (input: { prepare():Promise<void>; perform(sql:JobSql):Promise<unknown> }) => {
      await input.prepare()
      return { value:await input.perform(f.sql),replayed:false }
    } } as unknown as PostgresCommandCoordinator
    const service = createJobRuntimeProfileService({ commands,sources:{} as PostgresSourceService,
      pool:{ connect:async () => ({ query:f.query,release:vi.fn() }) } as unknown as pg.Pool,
      host:{ reconcileQualification:reconcile,capture:nativeWork,descriptor:nativeWork,
        currentMetadata:nativeWork,currentConnection:nativeWork,reserveQualification:nativeWork } })
    const now = vi.spyOn(Date,'now').mockReturnValue(startedAt + 120_000)
    try {
      const result = await service.qualify(principal,'mcp',profile.workspaceId,'actual-command',approval.id)
      expect(result).toEqual(f.state.profile)
      expect(reconcile).toHaveBeenCalledOnce()
      expect(nativeWork).not.toHaveBeenCalled()
      expect(f.state.nativeAdmission).toEqual(original)
    } finally { now.mockRestore() }
  })
})

it('captures an installed device candidate through its trusted carrier without opening Main-local worker paths',async()=>{
  const hostRef={kind:'device' as const,mainId:uuid,deviceId:'22222222-2222-4222-8222-222222222222'},registration={workerInstallationId:'33333333-3333-4333-8333-333333333333',keyRevision:1,authorizationRevision:1}
  const remoteRoot={...root,selection:{...root.selection,hostRef},registration,binding:{...root.binding,deviceId:hostRef.deviceId,workerInstallationId:registration.workerInstallationId}}
  const remoteProfile=JobRuntimeProfileSchema.parse({...profile,root:remoteRoot})
  const remoteFingerprint=JobRuntimeFingerprintSchema.parse({...fingerprint,hostRef,registration,root:remoteRoot})
  const query=vi.fn(async(text:string)=>{
    let rows:unknown[]=[]
    if(text.includes('from management_principals'))rows=[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:null,delegated_from:null}]
    else if(text.includes('select archived_at'))rows=[{archived_at:null}]
    else if(text.startsWith('select record from job_runtime_profiles'))rows=[{record:remoteProfile}]
    return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
  })
  const commands={execute:async(input:{prepare():Promise<void>;perform(sql:JobSql):Promise<unknown>})=>{await input.prepare();return {value:await input.perform({query} as JobSql)}}} as unknown as PostgresCommandCoordinator
  const capture=vi.fn(async()=>remoteFingerprint),descriptor=vi.fn(async()=>{throw new Error('Worker paths cannot be read by Main')})
  const service=createJobRuntimeProfileService({pool:{connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool,commands,sources:{} as PostgresSourceService,
    host:{capture,descriptor,currentMetadata:async()=>remoteFingerprint,currentConnection:async()=>null,reserveQualification:async()=>{throw new Error('Request cannot enter native runtime')}}})
  const requested=await service.requestQualification(principal,'mcp',profile.workspaceId,{commandId:'remote-request',profileId:profile.id,expectedRevision:1})
  expect(requested.fingerprint).toEqual(remoteFingerprint);expect(capture).toHaveBeenCalledOnce();expect(descriptor).not.toHaveBeenCalled()
})
