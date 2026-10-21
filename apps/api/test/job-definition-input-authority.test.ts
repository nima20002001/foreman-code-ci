import { describe,expect,it,vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { SourceRootRecordSchema,ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { CanonicalJobPreparationSources } from '../src/modules/jobs/sourcePreparation.js'
import { DomainError } from '../src/modules/errors.js'
import { jobSpec } from './helpers/jobFixture.js'
const principal:ManagementPrincipal={id:'definition-input-reader',name:'Actor',audience:'operator',grants:[],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
function fixture() {
  const spec=jobSpec(),policyId=spec.source.snapshotId,filesystem={device:'1',inode:'2',mountId:'3'},runtimeRoot='/approved/runtime',sourceRoot=`${runtimeRoot}/source-materializations/${policyId}`
  spec.target.mainInstallationId=spec.target.mainId
  spec.target.destination={...spec.target.destination,rootPolicyId:policyId,canonicalProjectRoot:sourceRoot,canonicalCwd:sourceRoot,managedRuntimeRoot:runtimeRoot,directoryIdentityHash:createHash('sha256').update(JSON.stringify(filesystem)).digest('hex')}
  const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest},selection:{hostRef:spec.target.hostRef,rootPolicyId:policyId,rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:spec.target.mainId,deviceId:null,workerInstallationId:null,workspaceId:'workspace-fixture',rootId:policyId,bindingRevision:1,locationRevision:1,canonicalPath:sourceRoot,filesystem,accessMode:'exclusive-write',snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:spec.target.destination.attestationId,attestationDigest:spec.target.destination.attestationHash,boundAt:'2026-10-01T00:00:00.000Z'})
  const policy=WorkspaceRootPolicySchema.parse({schemaVersion:1,rootPolicyId:policyId,rootPolicyRevision:'1',workspaceId:root.binding.workspaceId,hostRef:root.selection.hostRef,applicationInstallationId:root.binding.mainId,registration:null,locationRevision:'1',ownerPrincipalId:principal.id,allowedBaseId:policyId,configurationRevision:'1',relativePath:'project',accessMode:'read-write',canonicalProjectRoot:'/approved/original-project',filesystem,directoryIdentityHash:'1'.repeat(64),managedRuntimeRoot:runtimeRoot,runtimeFilesystem:filesystem,attestationId:policyId,attestationDigest:'1'.repeat(64)})
  const source=ApprovedSourceSchema.parse({version:1,workspaceId:root.binding.workspaceId,ownerPrincipalId:principal.id,approvedByPrincipalId:principal.id,locationRevision:1,mainId:root.binding.mainId,originIdentityHash:'sha256:'+'1'.repeat(64),manifest:{version:1,snapshotId:spec.source.snapshotId,approvedSourceId:spec.source.approvedSourceId,capturePolicy:'git-tree-v1',executablePolicy:'strip',git:{commit:spec.source.commit,tree:'3'.repeat(40),objectFormat:'sha1'},entries:[],deletions:[],totalEntries:0,totalBytes:0,manifestDigest:spec.source.manifestDigest},approvedAt:root.boundAt,availability:'retained'})
  const query=vi.fn(async(text:string)=>({rows:text.includes('application_installation')?[{id:root.binding.mainId}]:text.includes('source_root_catalog')?[{record:root}]:[],rowCount:1,command:'SELECT',oid:0,fields:[]})),sql={query:query as JobSql['query']}
  const sources={resolveApprovedSource:vi.fn(async()=>source),resolveRootBinding:vi.fn(async()=>root),prepareExecution:vi.fn()},runtime={choices:vi.fn(),revalidate:vi.fn(async()=>undefined)},repositories={prepare:vi.fn()},inputs={validateDeclaredJobInputs:vi.fn(async()=>undefined)},roots={resolve:vi.fn(async()=>policy)}
  return {spec,root,policy,sql,query,sources,runtime,repositories,inputs,roots,service:new CanonicalJobPreparationSources(sources as unknown as PostgresSourceService,runtime,repositories,inputs,roots)}
}
describe('job definition input and genuine root metadata admission',()=>{
  it('checks exact input pins and uses actual registered runtime namespace before Save',async()=>{
    const f=fixture();await f.service.validateSelection(f.sql,principal,f.root.binding.workspaceId,f.spec)
    expect(f.inputs.validateDeclaredJobInputs).toHaveBeenCalledWith(f.sql,principal,f.root.binding.workspaceId,f.spec.inputs)
    expect(f.roots.resolve).toHaveBeenCalledWith(f.sql,principal,{workspaceId:f.root.binding.workspaceId,...f.root.selection})
    expect(f.sources.resolveRootBinding).toHaveBeenCalledOnce();expect(f.sources.prepareExecution).not.toHaveBeenCalled()
  })
  it('refuses input permission denial before any source probe or materialization',async()=>{
    const f=fixture();f.inputs.validateDeclaredJobInputs.mockRejectedValue(new DomainError('JOB_INPUT_SCOPE_DENIED','Exact input scope denied.',403))
    await expect(f.service.materialize(f.sql,principal,f.root.binding.workspaceId,f.spec,{executionId:'real-job',attemptId:'real-attempt',operationId:'real-operation'})).rejects.toMatchObject({code:'JOB_INPUT_SCOPE_DENIED'})
    expect(f.query).not.toHaveBeenCalled();expect(f.sources.resolveApprovedSource).not.toHaveBeenCalled();expect(f.repositories.prepare).not.toHaveBeenCalled()
  })
  it('rejects source namespace substituted for the approved managed runtime root',async()=>{
    const f=fixture();f.spec.target.destination.managedRuntimeRoot=f.root.binding.canonicalPath
    await expect(f.service.validateSelection(f.sql,principal,f.root.binding.workspaceId,f.spec)).rejects.toMatchObject({code:'JOB_ROOT_PIN_CONFLICT'})
    expect(f.sources.prepareExecution).not.toHaveBeenCalled()
  })
  it('rejects an installation identifier that differs from the genuine Main singleton',async()=>{
    const f=fixture();f.query.mockImplementation(async text=>({rows:text.includes('application_installation')?[{id:'different-main'}]:[{record:f.root}],rowCount:1,command:'SELECT',oid:0,fields:[]}))
    await expect(f.service.validateSelection(f.sql,principal,f.root.binding.workspaceId,f.spec)).rejects.toMatchObject({code:'JOB_ROOT_PIN_CONFLICT'})
  })
})
