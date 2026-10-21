import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { WorkerJobApplicationSink } from './workerJobApplicationSink.js'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import type { RemoteJobAcceptedSourceReadout } from '@foreman-code/contracts/remote-job-execution'
import { verifyPrivateSourceRepository, preparePrivateJobRepositoryMounts } from '../../sources/repository.js'
import { createInstalledJobSource } from './installedJobSource.js'
vi.mock('../../sources/repository.js',()=>({verifyPrivateSourceRepository:vi.fn(),preparePrivateJobRepositoryMounts:vi.fn()}))
vi.mock('../../sources/workingDirectory.js',()=>({verifyMaterializedWorkingDirectory:vi.fn(async(record:{testCwd:string})=>({canonicalCwd:record.testCwd}))}))
vi.mock('../../sources/rootAttestation.js',()=>({verifyApprovedRootAllowlist:vi.fn(async()=>{})}))
function fixture() {
  const execution=jobExecution(),binding={mainId:execution.acceptedSpec.target.mainId,deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionGeneration:1,connectionEpoch:randomUUID()},fs={device:'1',inode:'2',mountId:'3'},policy='root-policy'
  const namespace=`/approved/runtime/source-materializations/${policy}`,tree=`${namespace}/${execution.acceptedSpec.source.materializationId}/tree`
  execution.acceptedSpec.target={...execution.acceptedSpec.target,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},destination:{...execution.acceptedSpec.target.destination,managedRuntimeRoot:'/approved/runtime',canonicalProjectRoot:tree,canonicalCwd:tree}}
  const accepted={execution,materialization:{testCwd:tree,receipt:{materializationId:execution.acceptedSpec.source.materializationId,binding:{canonicalPath:namespace},placementHash:execution.acceptedSpec.bindingHash,executionId:execution.id,attemptId:execution.attemptId,keyRevision:1,authorizationRevision:1}},root:{selection:{rootPolicyId:policy}},diskQuotaBytes:1024} as unknown as RemoteJobAcceptedSourceReadout
  const original={execution,intent:{operationId:execution.operationId}},application={resolveAcceptedSource:vi.fn(async()=>accepted)} as unknown as WorkerJobApplicationSink
  const roots=ApprovedRootAllowlistSchema.parse({schemaVersion:1,hostRef:execution.acceptedSpec.target.hostRef,applicationInstallationId:binding.workerInstallationId,configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:'/approved',filesystem:fs,accessModes:['read-write']}],managedRuntimeRoot:'/approved/runtime',runtimeFilesystem:fs})
  const mounts={version:1,layout:'source-inputs-private-git-scheduler-v1',workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,specDigest:execution.acceptedSpec.specDigest,bindingHash:execution.acceptedSpec.bindingHash,materializationId:execution.acceptedSpec.source.materializationId,materializationDigest:execution.acceptedSpec.source.materializationDigest,git:{directory:tree.replace(/tree$/,'repository'),filesystem:fs,generatedCommit:'4'.repeat(40),sourceCommit:execution.acceptedSpec.source.commit,repositoryReceiptDigest:'a'.repeat(64),configDigest:'a'.repeat(64),indexDigest:'a'.repeat(64),mountpoint:fs},scheduler:{directory:tree.replace(/tree$/,'job-heavy-jobs'),filesystem:fs},receiptDigest:'a'.repeat(64)} as const
  vi.mocked(verifyPrivateSourceRepository).mockResolvedValue({workTree:tree,gitDirectory:mounts.git.directory,generatedCommit:mounts.git.generatedCommit,sourceCommit:mounts.git.sourceCommit})
  vi.mocked(preparePrivateJobRepositoryMounts).mockResolvedValue(mounts)
  const source=createInstalledJobSource({journal:{jobOperations:async()=>[original]} as unknown as RemoteOperationJournal,application,currentBinding:()=>binding,approvedRoots:async()=>roots})
  return {execution,accepted,application,source,mounts,binding}
}
describe('installed original Job Git source bridge (metadata authority doubles)',()=>{
  it('retains exact original mount metadata from its owner-bound helper',async()=>{
    const f=fixture(),source=await f.source.verify(f.execution.acceptedSpec,AbortSignal.timeout(10000))
    expect(source.gitMounts).toBe(f.mounts)
    expect(preparePrivateJobRepositoryMounts).toHaveBeenLastCalledWith(expect.objectContaining({execution:f.accepted.execution,record:f.accepted.materialization,reauthorize:expect.any(Function)}))
  })
  it('denies changed original owner and current channel before returning authority',async()=>{
    const f=fixture();vi.mocked(f.application.resolveAcceptedSource).mockResolvedValue({...f.accepted,execution:{...f.execution,owner:{grantId:'changed',epoch:'2'}}})
    await expect(f.source.verify(f.execution.acceptedSpec,AbortSignal.timeout(10000))).rejects.toThrow('owner changed')
    const changed=fixture();vi.mocked(preparePrivateJobRepositoryMounts).mockImplementationOnce(async input=>{changed.binding.connectionEpoch=randomUUID();await input.reauthorize();return changed.mounts})
    await expect(changed.source.verify(changed.execution.acceptedSpec,AbortSignal.timeout(10000))).rejects.toThrow('authority changed')
  })
})
