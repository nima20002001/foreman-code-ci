import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer } from '../sources/materialization.js'
import { verifyMaterializedWorkingDirectory } from '../sources/workingDirectory.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { freezePlacement, deriveDispatch } from './binding.js'
import { bindNativeExecution, readNativeExecutionBinding, nativePlacementDigest } from './executionBinding.js'
const temporary: string[]=[]
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true})})
it('binds an actual FD-verified source subdirectory and keeps lifecycle state outside the native digest',async()=>{
  const path=await mkdtemp('/tmp/agent-placement-unit-');temporary.push(path)
  const sourceRoot=join(path,'source'), nativeRoot=join(path,'native');await mkdir(sourceRoot,{mode:0o700});await mkdir(nativeRoot,{mode:0o700})
  const rootFd=await openPrivateRoot(sourceRoot), filesystem=await identity(rootFd);await rootFd.close()
  const mainId=randomUUID(),rootId=randomUUID(),sourceId=randomUUID(),snapshotId=randomUUID(),digest='a'.repeat(64),bytes=Buffer.from('actual approved bytes\n')
  const manifest=createSourceManifest({version:1,approvedSourceId:sourceId,snapshotId,capturePolicy:'exclusive-explicit-bytes-v1',executablePolicy:'strip',deletions:[],entries:[{path:'src/file.ts',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}]})
  const binding={version:1 as const,mainId,deviceId:null,workerInstallationId:null,workspaceId:'workspace',rootId,bindingRevision:1,locationRevision:1,canonicalPath:sourceRoot,filesystem,accessMode:'exclusive-write' as const,snapshotId,manifestDigest:manifest.manifestDigest}
  const receipt=await new PrivateSourceMaterializer({read:async()=>bytes},async()=>undefined).prepare({manifest,binding,attempt:{executionId:'execution',attemptId:'attempt',placementHash:digest,keyRevision:null,authorizationRevision:null}})
  const record:SourceMaterializationRecord={receipt,rootPolicyId:'policy',rootPolicyRevision:'1',operationId:'operation',reservationId:randomUUID(),sourceBindingHash:digest,finalDispatchBindingHash:null,state:'prepared'}
  const parent=freezePlacement({schemaVersion:1,mainId,mainInstallationId:mainId,runId:'run',nodeId:'node',hostRef:{kind:'main',mainId},registration:null,
    destination:{canonicalProjectRoot:sourceRoot,canonicalCwd:join(sourceRoot,'src'),managedRuntimeRoot:nativeRoot,directoryIdentityHash:digest,rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:digest},
    source:{kind:'pending',approvedSourceId:sourceId,snapshotId,revisionId:snapshotId,manifestDigest:manifest.manifestDigest,rootId,bindingRevision:1,materializationId:null,materializationDigest:null},
    payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'config',driverId:'codex',driverRevision:'1',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness',installationFingerprint:digest,runtimeContractVersion:1,protocolRevision:'1',credentialScopeRefs:[]}})
  const intent=deriveDispatch(parent,{executionId:'execution',attemptId:'attempt',operationId:'operation',occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,inputDigest:`sha256:${digest}`,owner:{grantId:'grant',epoch:'1'}})
  const tree=await verifyMaterializedWorkingDirectory(record,'src',async()=>undefined)
  expect(tree.cwdAttestation?.filesystem.inode).not.toBe(receipt.localTreeIdentity.inode)
  const native=bindNativeExecution(parent,intent,record,tree)
  for(const state of ['running','closed'] as const){const changed={...native,materialization:{...record,state,finalDispatchBindingHash:native.bindingHash}};expect(readNativeExecutionBinding(parent,intent,changed).bindingHash).toBe(native.bindingHash)}
  const wrong={...native,workingTree:{...tree,cwdAttestation:{...tree.cwdAttestation!,relativeCwd:'other'}}}
  const {bindingHash:_hash,...fields}=wrong;void _hash
  expect(()=>readNativeExecutionBinding(parent,intent,{...wrong,bindingHash:nativePlacementDigest(fields)})).toThrow('CWD')
})
