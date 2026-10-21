import { describe, expect, it } from 'vitest'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT, requireJobGitMounts, type VerifiedJobGitMounts } from './privateGitMounts.js'
const digest='a'.repeat(64)
function fixture() {
  const execution=jobExecution(),spec=execution.acceptedSpec,parent=`/original/${spec.source.materializationId}`
  spec.target.destination.canonicalProjectRoot=`${parent}/tree`
  const mounts:VerifiedJobGitMounts={version:1,layout:JOB_PRIVATE_GIT_LAYOUT,workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,specDigest:spec.specDigest,bindingHash:spec.bindingHash,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest,git:{directory:`${parent}/repository`,filesystem:{device:'1',inode:'2',mountId:'3'},generatedCommit:'4'.repeat(40),sourceCommit:spec.source.commit,repositoryReceiptDigest:digest,configDigest:digest,indexDigest:digest,mountpoint:{device:'1',inode:'3',mountId:'3'}},scheduler:{directory:`${parent}/job-heavy-jobs`,filesystem:{device:'1',inode:'4',mountId:'3'}},receiptDigest:digest}
  return {execution,mounts}
}
describe('exact accepted Job Git mount contract',()=>{
  it('returns only original structured metadata and fixes nonsecret Git environment',()=>{
    const f=fixture();expect(requireJobGitMounts(f.execution,{gitMounts:f.mounts})).toBe(f.mounts)
    expect(JOB_GIT_ENVIRONMENT).toEqual({GIT_DIR:'/graphql-job-git',GIT_WORK_TREE:'/workspace',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'})
  })
  it('denies missing boolean-only authority, arbitrary host Git, changed owner/spec and unqualified mount',()=>{
    const f=fixture();expect(()=>requireJobGitMounts(f.execution,{})).toThrow('Original qualified')
    for(const altered of [{...f.mounts,git:{...f.mounts.git,directory:'/host/project/.git'}},{...f.mounts,owner:{grantId:'changed',epoch:'2'}},{...f.mounts,specDigest:'0'.repeat(64)},{...f.mounts,scheduler:{...f.mounts.scheduler,filesystem:{...f.mounts.scheduler.filesystem,mountId:'999'}}}])
      expect(()=>requireJobGitMounts(f.execution,{gitMounts:altered})).toThrow('Original qualified')
  })
})
