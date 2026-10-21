import type pg from 'pg'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import type { JobExecutionFileScope } from '@foreman-code/contracts/job-artifacts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { JobRepository } from '../../jobs/repository.js'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { DomainError } from '../../errors.js'
import { FileStorageService, type FileScopeAuthorization } from '../service.js'
import type { FileAccess } from '../authorization.js'
import type { FileQuery } from '../repository.js'
import { PostgresFileRepository } from '../postgres.js'
import { CiOutputByteStorage } from './byteStorage.js'
import { PostgresJobPublicationLedger } from './ledger.js'
import { CanonicalJobArtifactPort, type TrustedJobOutputReader } from './port.js'

export class PostgresJobArtifactScopeAuthorization implements FileScopeAuthorization<JobExecutionFileScope> {
  private readonly jobs = new JobRepository()
  constructor(private readonly pool: pg.Pool) {}
  async resolve(principal: ManagementPrincipal, target: JobExecutionFileScope, access: FileAccess, query: FileQuery = this.pool) {
    const execution = await this.jobs.execution(query,target.workspaceId,target.jobExecutionId)
    const current = await readLiveManagementPrincipal(query,principal.id)
    if (access === 'read') {
      const scope = await this.jobs.executionScope(query, execution.workspaceId, execution.id)
      requireAuthorization(current, 'job_artifacts:read', { ...scope, workspaceId: execution.workspaceId })
    }
    else {
      const accepted = (await query.query<{accepted_by:string}>('select accepted_by from job_executions where id=$1 and workspace_id=$2',[execution.id,execution.workspaceId])).rows[0]
      if (accepted?.accepted_by !== current.id) throw new DomainError('JOB_ARTIFACT_OWNER_DENIED','Only the accepted main authority can publish this output.',403)
      requireAuthorization(current,execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,
        ...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
    }
    return {kind:'job_execution' as const,workspaceId:execution.workspaceId,jobExecutionId:execution.id}
  }
}
/** Uses the same canonical storage root and file tables; CI capability is separately validated. */
export function createCanonicalJobArtifactPort(input: {pool:pg.Pool;storageRoot:string;excludedRoots?:readonly string[];
  authority:Pick<JobPublicationAuthority,'authorizePublication'>;reader:TrustedJobOutputReader;clock?:()=>Date}) {
  const bytes = new CiOutputByteStorage(input.storageRoot,MAX_FILE_BYTES,input.excludedRoots)
  const repository = new PostgresFileRepository(input.pool)
  const files = new FileStorageService(repository,bytes,new PostgresJobArtifactScopeAuthorization(input.pool),undefined,input.clock)
  return new CanonicalJobArtifactPort(input.pool,files,new PostgresJobPublicationLedger(input.pool),input.authority,input.reader,input.clock)
}
