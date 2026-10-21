import { describe,expect,it,vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceMaterializationRecordSchema,SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import { CanonicalJobPreparationSources } from '../src/modules/jobs/sourcePreparation.js'
import { sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution,jobSpec } from './helpers/jobFixture.js'
const principal:ManagementPrincipal={id:'accepted-source-actor',name:'Actor',audience:'operator',grants:[],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
function fixture() {
  const execution=jobExecution(),spec=jobSpec(),source=spec.source,uuid=source.snapshotId
  const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:source.approvedSourceId,snapshotId:source.snapshotId,manifestDigest:source.manifestDigest},selection:{hostRef:spec.target.hostRef,rootPolicyId:spec.target.destination.rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:spec.target.mainId,deviceId:null,workerInstallationId:null,workspaceId:execution.workspaceId,rootId:uuid,bindingRevision:1,locationRevision:1,canonicalPath:spec.target.destination.canonicalProjectRoot,filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write',snapshotId:source.snapshotId,manifestDigest:source.manifestDigest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:spec.target.destination.attestationId,attestationDigest:spec.target.destination.attestationHash,boundAt:execution.createdAt})
  const materialization=SourceMaterializationRecordSchema.parse({receipt:{version:1,materializationId:uuid,binding:root.binding,placementHash:'1'.repeat(64),executionId:execution.id,attemptId:execution.attemptId,keyRevision:null,authorizationRevision:null,verifiedManifestDigest:source.manifestDigest,verifiedEntries:1,verifiedBytes:1,verifiedAt:execution.createdAt,localTreeIdentity:{device:'1',inode:'4',mountId:'3'}},rootPolicyId:root.selection.rootPolicyId,rootPolicyRevision:'1',operationId:execution.operationId,reservationId:uuid,sourceBindingHash:'1'.repeat(64),finalDispatchBindingHash:null,state:'closed'})
  execution.acceptedSpec.source.materializationDigest=sourceMaterializationDigest(materialization)
  Object.assign(execution.acceptedSpec,jobSpecDigests(execution.acceptedSpec,null));materialization.finalDispatchBindingHash=execution.acceptedSpec.bindingHash
  const query=vi.fn(async(text:string)=>({rows:text.includes('source_execution_materializations')?[{record:materialization,state:'closed'}]:text.includes('job_definition_versions')?[{record:{schemaVersion:1,id:execution.acceptedSpec.definitionId,workspaceId:execution.workspaceId,versionId:execution.acceptedSpec.definitionVersionId,revision:1,name:'Original',spec,createdAt:execution.createdAt,updatedAt:execution.createdAt}}]:[],rowCount:1,command:'SELECT',oid:0,fields:[]}))
  const resolveRootBinding=vi.fn(async()=>root),runtime={choices:vi.fn(async()=>[]),revalidate:vi.fn(async()=>undefined)},prepare=vi.fn()
  const service=new CanonicalJobPreparationSources({resolveRootBinding} as unknown as PostgresSourceService,runtime,{prepare},{validateDeclaredJobInputs:vi.fn(async()=>undefined)},{resolve:vi.fn()})
  return {execution,materialization,root,query,resolveRootBinding,runtime,prepare,service}
}
describe('original accepted source revalidation',()=>{
  it('uses the original root and immutable definition rather than a changed authoring catalog',async()=>{
    const f=fixture()
    await f.service.revalidateAccepted({query:f.query as JobSql['query']},principal,f.execution,
      { requireQualification: true })
    expect(f.resolveRootBinding).toHaveBeenCalledWith(expect.anything(),principal,{workspaceId:f.execution.workspaceId,rootId:f.root.binding.rootId,bindingRevision:1,source:f.root.source})
    expect(f.runtime.revalidate).toHaveBeenCalledOnce();expect(f.runtime.choices).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled()
    expect(f.query.mock.calls.some(([sql])=>sql.includes('job_definitions '))).toBe(false)
  })
  it('keeps retained source authority independent of launch qualification', async () => {
    const f = fixture()
    f.runtime.revalidate.mockRejectedValue(new DomainError('JOB_RUNTIME_UNQUALIFIED', 'Qualification expired.', 409))
    await expect(f.service.revalidateAccepted({ query: f.query as JobSql['query'] }, principal, f.execution))
      .resolves.toBeUndefined()
    expect(f.resolveRootBinding).toHaveBeenCalledOnce()
    expect(f.runtime.revalidate).not.toHaveBeenCalled()
    await expect(f.service.revalidateAccepted({ query: f.query as JobSql['query'] }, principal, f.execution,
      { requireQualification: true })).rejects.toMatchObject({ code: 'JOB_RUNTIME_UNQUALIFIED' })
  })
  it('fails current root revocation before accepting publication',async()=>{
    const f=fixture();f.resolveRootBinding.mockRejectedValue(new DomainError('AUTH_REVOKED','Original root authority revoked.',403))
    await expect(f.service.revalidateAccepted({query:f.query as JobSql['query']},principal,f.execution)).rejects.toMatchObject({code:'AUTH_REVOKED'})
    expect(f.runtime.revalidate).not.toHaveBeenCalled()
  })
  it('uses the current materialization state column rather than stale JSON readiness',async()=>{
    const f=fixture()
    f.query.mockResolvedValueOnce({rows:[{record:f.materialization,state:'uncertain'}],rowCount:1,command:'SELECT',oid:0,fields:[]})
    await expect(f.service.revalidateAccepted({query:f.query as JobSql['query']},principal,f.execution)).rejects.toMatchObject({code:'SOURCE_ATTEMPT_CONFLICT'})
    expect(f.resolveRootBinding).not.toHaveBeenCalled();expect(f.runtime.revalidate).not.toHaveBeenCalled()
  })
  it('rejects a switched original dispatch binding before current root lookup',async()=>{
    const f=fixture();f.materialization.finalDispatchBindingHash='2'.repeat(64)
    await expect(f.service.revalidateAccepted({query:f.query as JobSql['query']},principal,f.execution)).rejects.toMatchObject({code:'SOURCE_ATTEMPT_CONFLICT'})
    expect(f.resolveRootBinding).not.toHaveBeenCalled()
  })
})
