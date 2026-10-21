import { DomainError } from '../errors.js'
import type { JobSql } from './repository.js'
/** Checked again before final acceptance, after all outside-SQL source I/O. */
export async function requireJobPreparationDeadline(sql:JobSql,kind:'manual'|'workflow',executionId:string,budgetMs:number,now=Date.now()) {
  const statement=kind==='manual'
    ?'select created_at from job_preparations where execution_id=$1 for update'
    :"select created_at from workflow_job_preparations where preparation->>'executionId'=$1 for update"
  const row=(await sql.query<{created_at:Date}>(statement,[executionId])).rows[0]
  if(!row||!Number.isFinite(row.created_at.getTime()))throw new DomainError('JOB_PREPARATION_MISSING','The original durable preparation start is missing.',409)
  if(now-row.created_at.getTime()>=budgetMs)throw new DomainError('JOB_PREPARATION_TIMEOUT','The original source preparation exceeded its accepted budget.',409)
}
