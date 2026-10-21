import { describe, expect, it } from 'vitest'
import { JOB_RUNTIME_WORKSPACE_LAYOUT, QualifiedJobRuntimeSchema, CurrentQualifiedJobRuntimeSchema,
  JobRuntimeFingerprintSchema, CurrentJobRuntimeFingerprintSchema, JobRuntimeMeasurementSchema,
  CurrentJobRuntimeMeasurementSchema, JobRuntimeQualificationReadSchema, jobRuntimeWorkspaceLayoutIssue } from './jobRuntime.js'

// Contract fixtures only: no host, mount, toolchain, grant or qualification is produced.
const id='00000000-0000-4000-8000-000000000001',digest='a'.repeat(64)
const limits={cpuLimit:1,memoryBytes:67108864,pidsLimit:64,diskBytes:2097152}
const root={version:1,source:{approvedSourceId:id,snapshotId:id,manifestDigest:digest},
  selection:{hostRef:{kind:'main',mainId:id},rootPolicyId:id,rootPolicyRevision:'1',locationRevision:'1'},
  binding:{version:1,mainId:id,deviceId:null,workerInstallationId:null,workspaceId:id,rootId:id,bindingRevision:1,
    locationRevision:1,canonicalPath:'/approved/source',filesystem:{device:'12',inode:'34',mountId:'56'},
    accessMode:'exclusive-write',snapshotId:id,manifestDigest:digest},ownerPrincipalId:id,authorizedByPrincipalId:id,
  registration:null,attestationId:id,attestationDigest:digest,boundAt:'2026-10-01T00:00:00Z'}
const runtime={...limits,policyId:id,policyRevision:1,imageDigest:`sha256:${digest}`,toolchainDigest:digest,
  runtimeVersion:'podman-fixture',ociRuntimeVersion:'crun-fixture',kernelVersion:'kernel-fixture',qualificationId:id,
  rootless:true,cgroupV2:true,filesystemBounded:true,descendantContainment:true,network:'none'}
const fingerprint={schemaVersion:1,profileId:id,profileRevision:1,specDigest:digest,hostRef:{kind:'main',mainId:id},
  registration:null,mainInstallationId:id,bootId:id,root,runtimeExecutable:'/usr/bin/podman',runtimeBinarySha256:digest,
  ociExecutable:'/usr/bin/crun',ociBinarySha256:digest,configurationDigest:digest,imageDigest:`sha256:${digest}`,
  toolchainDigest:digest,limits}
const measurement={schemaVersion:1,qualificationId:id,profileId:id,profileRevision:1,specDigest:digest,
  hostRef:fingerprint.hostRef,registration:null,root,runtime,runtimeBinarySha256:digest,ociBinarySha256:digest,
  runtimeExecutable:'/usr/bin/podman',environment:{PATH:'/usr/bin',XDG_RUNTIME_DIR:'/run/user/1000',LANG:'C.UTF-8'},
  fingerprint,fingerprintDigest:digest,approvalId:id,origin:'real-runtime',checkedAt:'2026-10-01T00:00:00Z',
  expiresAt:'2026-10-01T01:00:00Z',checks:['rootless','cgroup-v2','filesystem-quota','descendant-containment','network-none','image-toolchain','credential-isolation']
    .map(id=>({id,passed:true,evidenceDigest:digest}))}

describe('immutable runtime history and current private Git/scheduler layout',()=>{
  it('retains historical records without filling a missing layout or accepting them as current',()=>{
    expect(QualifiedJobRuntimeSchema.parse(runtime)).toEqual(runtime)
    expect(JobRuntimeFingerprintSchema.parse(fingerprint)).toEqual(fingerprint)
    expect(JobRuntimeMeasurementSchema.parse(measurement)).toEqual(measurement)
    expect(CurrentQualifiedJobRuntimeSchema.safeParse(runtime).success).toBe(false)
    expect(CurrentJobRuntimeFingerprintSchema.safeParse(fingerprint).success).toBe(false)
    expect(CurrentJobRuntimeMeasurementSchema.safeParse(measurement).success).toBe(false)
    expect(jobRuntimeWorkspaceLayoutIssue(QualifiedJobRuntimeSchema.parse(runtime),JobRuntimeFingerprintSchema.parse(fingerprint)))
      .toBe('unsupported_workspace_layout')
  })
  it('requires the explicit identical layout in measured runtime and approved fingerprint',()=>{
    const currentRuntime={...runtime,workspaceLayout:JOB_RUNTIME_WORKSPACE_LAYOUT}
    const currentFingerprint={...fingerprint,workspaceLayout:JOB_RUNTIME_WORKSPACE_LAYOUT}
    const current={...measurement,runtime:currentRuntime,fingerprint:currentFingerprint}
    expect(CurrentQualifiedJobRuntimeSchema.parse(currentRuntime)).toEqual(currentRuntime)
    expect(CurrentJobRuntimeFingerprintSchema.parse(currentFingerprint)).toEqual(currentFingerprint)
    expect(CurrentJobRuntimeMeasurementSchema.parse(current)).toEqual(current)
    expect(jobRuntimeWorkspaceLayoutIssue(currentRuntime,currentFingerprint)).toBeNull()
    expect(JobRuntimeMeasurementSchema.safeParse({...current,fingerprint}).success).toBe(false)
    expect(JobRuntimeMeasurementSchema.safeParse({...current,runtime}).success).toBe(false)
  })
  it.each(['source-inputs-v1','unknown-future-layout'])('reads unsupported %s as history and returns an explicit readiness issue',workspaceLayout=>{
    const historicalRuntime={...runtime,workspaceLayout},historicalFingerprint={...fingerprint,workspaceLayout}
    expect(JobRuntimeMeasurementSchema.parse({...measurement,runtime:historicalRuntime,fingerprint:historicalFingerprint}).runtime.workspaceLayout).toBe(workspaceLayout)
    expect(CurrentQualifiedJobRuntimeSchema.safeParse(historicalRuntime).success).toBe(false)
    expect(CurrentJobRuntimeFingerprintSchema.safeParse(historicalFingerprint).success).toBe(false)
    expect(jobRuntimeWorkspaceLayoutIssue(historicalRuntime,historicalFingerprint)).toBe('unsupported_workspace_layout')
  })
  it('preserves historical qualified profile/approval facts while readback reports unsupported readiness',()=>{
    const policy={isolationPolicyId:id,isolationPolicyRevision:1,imageDigest:runtime.imageDigest,toolchainDigest:digest,
      environmentScopeRefs:[],network:'none',queueTimeoutMs:1000,preparationTimeoutMs:1000,executionTimeoutMs:1000,
      cancellationGraceMs:100,maxLogChunkBytes:1024,maxLogBytes:4096,maxWorkerSpoolBytes:131072,
      logOverflow:'stop',maxOutputBytes:1024,retentionSeconds:3600}
    const profile={schemaVersion:1,id,workspaceId:id,revision:1,name:'historical',root,policy,limits,specDigest:digest,
      status:'qualified',measurement,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}
    const approval={schemaVersion:1,id,qualificationId:id,workspaceId:id,profileId:id,profileRevision:1,fingerprint,
      fingerprintDigest:digest,requestedByPrincipalId:id,status:'complete',approvedByPrincipalId:id,
      approvedAt:'2026-10-01T00:00:00Z',expiresAt:'2026-10-01T01:00:00Z'}
    const read={approval,nativeAdmission:null,measurement,profile,
      readiness:{ready:false,reasons:['unsupported_workspace_layout'],sideEffects:false}}
    expect(JobRuntimeQualificationReadSchema.parse(read)).toEqual(read)
    expect(read.profile.status).toBe('qualified')
    expect('workspaceLayout' in read.measurement.runtime).toBe(false)
  })
})
