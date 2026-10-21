import type pg from 'pg'
import { JobExecutionFileScopeSchema } from '@foreman-code/contracts/job-artifacts'
import { DomainError } from '../../errors.js'
import type { JobSql } from '../../jobs/repository.js'
import { PostgresFileRepository } from '../postgres.js'
import type { JobPublicationLedger, JobPublicationLink } from './port.js'

/** Uses file_tool_publications/file_allocations, including their append-only/no-pending rules. */
export class PostgresJobPublicationLedger implements JobPublicationLedger {
  private readonly files: PostgresFileRepository
  constructor(private readonly pool: pg.Pool) { this.files = new PostgresFileRepository(pool) }
  async link(value: JobPublicationLink): Promise<void> {
    await this.pool.query(`insert into file_tool_publications(owner_principal_id,request_id,binding,file_id,revision_id,record)
      values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`,
    [value.ownerPrincipalId,value.requestId,value.binding,value.ref.fileId,value.ref.revisionId,JSON.stringify(value)])
    const result = await this.pool.query<{record:JobPublicationLink}>(`select record from file_tool_publications
      where owner_principal_id=$1 and request_id=$2`,[value.ownerPrincipalId,value.requestId])
    const prior = result.rows[0]?.record
    if (!prior || prior.kind !== 'job_execution' || prior.inputHash !== value.inputHash || prior.binding !== value.binding
      || prior.ref.fileId !== value.ref.fileId || prior.ref.revisionId !== value.ref.revisionId) {
      throw new DomainError('FILE_REQUEST_CONFLICT','The job output already belongs to a different immutable publication.',409)
    }
  }
  async list(query: JobSql, workspaceId: string, executionId: string) {
    const rows = await query.query<{record:JobPublicationLink}>(`select p.record from file_tool_publications p
      join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      join files f on f.file_id=p.file_id
      where p.record->>'kind'='job_execution' and p.record->>'workspaceId'=$1 and p.record->>'executionId'=$2
        and f.scope_kind='job_execution' and f.workspace_id=$1 and f.job_execution_id=$2 and a.state='finalized'
      order by p.record->>'path',p.request_id limit 65`,[workspaceId,executionId])
    if (rows.rows.length > 64) throw new DomainError('JOB_OUTPUT_MANIFEST_OVERFLOW','Job publication manifest exceeds its accepted output count.',409)
    const output = []
    for (const row of rows.rows) {
      const link = row.record
      const stored = await this.files.read(link.ref.fileId,link.ref.revisionId,query)
      if (!stored) throw new DomainError('JOB_ARTIFACT_NOT_FOUND','The retained canonical artifact metadata is missing.',410)
      const scope = JobExecutionFileScopeSchema.parse(stored.value.file.scope)
      if (scope.workspaceId !== workspaceId || scope.jobExecutionId !== executionId) throw new DomainError('JOB_ARTIFACT_SCOPE_CONFLICT','The artifact does not belong to the requested execution.',409)
      output.push({link,value:stored.value})
    }
    return output
  }
}
