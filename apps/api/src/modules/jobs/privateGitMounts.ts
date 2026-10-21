import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { DomainError } from '../errors.js'
import { JOB_PRIVATE_GIT_LAYOUT, verifyPrivateJobRepositoryMounts, type PrivateJobRepositoryMounts } from '../sources/repository.js'
import type { JobAcceptedSpecRecord, JobExecutionRecord } from '@foreman-code/contracts/job-verification'
export { JOB_PRIVATE_GIT_LAYOUT }
export type VerifiedJobGitMounts = PrivateJobRepositoryMounts
export const JOB_GIT_CONTAINER_DIRECTORY = '/graphql-job-git' as const
/** Fixed nonsecret environment; no caller Git directory, hooks, helpers or history. */
export const JOB_GIT_ENVIRONMENT = Object.freeze({
  GIT_DIR:JOB_GIT_CONTAINER_DIRECTORY,GIT_WORK_TREE:'/workspace',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',
})
type JobGitSubject = Pick<JobExecutionRecord, 'workspaceId' | 'id' | 'attemptId' | 'operationId' | 'owner'> & {
  acceptedSpec: Pick<JobAcceptedSpecRecord, 'source' | 'target' | 'specDigest' | 'bindingHash'>
}
export function requireJobGitMounts(execution:JobGitSubject,source:{gitMounts?:VerifiedJobGitMounts}):VerifiedJobGitMounts {
  const mounts=source.gitMounts,spec=execution.acceptedSpec,parent=dirname(spec.target.destination.canonicalProjectRoot)
  if(!mounts||mounts.layout!==JOB_PRIVATE_GIT_LAYOUT||mounts.version!==1||mounts.workspaceId!==execution.workspaceId
    ||mounts.executionId!==execution.id||mounts.attemptId!==execution.attemptId||mounts.operationId!==execution.operationId
    ||!isDeepStrictEqual(mounts.owner,execution.owner)||mounts.specDigest!==spec.specDigest||mounts.bindingHash!==spec.bindingHash
    ||mounts.materializationId!==spec.source.materializationId||mounts.materializationDigest!==spec.source.materializationDigest
    ||mounts.git.sourceCommit!==spec.source.commit||parent.split('/').at(-1)!==spec.source.materializationId
    ||spec.target.destination.canonicalProjectRoot!==join(parent,'tree')||mounts.git.directory!==join(parent,'repository')
    ||mounts.scheduler.directory!==join(parent,'job-heavy-jobs')||mounts.git.filesystem.device!==mounts.scheduler.filesystem.device
    ||mounts.git.filesystem.mountId!==mounts.scheduler.filesystem.mountId)
    throw new DomainError('JOB_GIT_MOUNTS_INVALID', 'Original qualified Job Git/scheduler mounts required.', 409)
  return mounts
}
export async function verifyJobGitMounts(execution:JobExecutionRecord,source:{gitMounts?:VerifiedJobGitMounts}):Promise<void> {
  await verifyPrivateJobRepositoryMounts(execution,requireJobGitMounts(execution,source))
}
