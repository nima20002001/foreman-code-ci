import { describe, expect, it } from 'vitest'
import { JobRuntimeNativeAdmissionSchema, CurrentJobRuntimeNativeAdmissionSchema } from './jobRuntime.js'

const mainId='00000000-0000-4000-8000-000000000001'
const qualificationId='00000000-0000-4000-8000-000000000002'
const bootId='00000000-0000-4000-8000-000000000003'
const admission={schemaVersion:1,kind:'job-runtime-qualification',approvalId:'00000000-0000-4000-8000-000000000004',
  qualificationId,operationId:qualificationId,workspaceId:'workspace',profileId:'profile',profileRevision:1,
  fingerprintDigest:'a'.repeat(64),leaseId:'00000000-0000-4000-8000-000000000005',
  runCommandId:'run-command',runPrincipalId:'runner',approvedByPrincipalId:'human',
  hostRef:{kind:'main',mainId},registration:null,mainInstallationId:mainId,bootId,connection:null,
  admittedAt:'2026-10-01T22:00:00.000Z',expiresAt:'2026-10-01T23:00:00.000Z'}
const workerInstallationId='00000000-0000-4000-8000-000000000006'
const deviceId='00000000-0000-4000-8000-000000000007'
const remote={...admission,hostRef:{kind:'device',mainId,deviceId},registration:{workerInstallationId,keyRevision:1,authorizationRevision:2},
  connection:{mainId,deviceId,workerInstallationId,keyRevision:1,authorizationRevision:2,bootId,
    connectionGeneration:3,connectionEpoch:'00000000-0000-4000-8000-000000000008'}}

describe('runtime qualification admission identity',()=>{
  it('requires device policy and revocable approval on new diagnostic entry, retaining old history',()=>{
    expect(CurrentJobRuntimeNativeAdmissionSchema.safeParse(admission).success).toBe(false)
    const current={...admission,schemaVersion:2,resourcePolicyRevision:1,resourcePolicyDigest:'a'.repeat(64),
      runtimeApprovalId:admission.approvalId,runtimeApprovalRevision:1}
    expect(CurrentJobRuntimeNativeAdmissionSchema.parse(current)).toEqual(current)
    expect(JobRuntimeNativeAdmissionSchema.safeParse({...current,resourcePolicyDigest:undefined}).success).toBe(false)
  })
  it('retains a distinct diagnostic subject for local and authenticated remote hosts',()=>{
    expect(JobRuntimeNativeAdmissionSchema.parse(admission)).toEqual(admission)
    expect(JobRuntimeNativeAdmissionSchema.parse(remote)).toEqual(remote)
  })
  it.each([
    {operationId:admission.approvalId}, {mainInstallationId:deviceId}, {expiresAt:admission.admittedAt},
    {owner:{grantId:'borrowed-workflow-grant',epoch:'1'}}, {ready:true}, {connection:remote.connection},
  ])('rejects mismatched or caller-invented local admission fields %j',change=>{
    expect(JobRuntimeNativeAdmissionSchema.safeParse({...admission,...change}).success).toBe(false)
  })
  it.each(['mainId','deviceId','workerInstallationId','bootId','keyRevision','authorizationRevision'] as const)(
    'rejects a remote %s that differs from the actual admitted target',key=>{
      const current=remote.connection[key]
      const changed=typeof current==='number'?current+1:admission.approvalId
      expect(JobRuntimeNativeAdmissionSchema.safeParse({...remote,connection:{...remote.connection,[key]:changed}}).success).toBe(false)
    })
  it('does not admit a remote diagnostic without current worker binding',()=>{
    expect(JobRuntimeNativeAdmissionSchema.safeParse({...remote,connection:null}).success).toBe(false)
  })
})
