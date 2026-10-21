import { JobRuntimeMeasurementRecordSchema, JobRuntimeProfileRecordSchema,
  type JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
import { DomainError } from '../errors.js'
import type { JobSql } from './repository.js'

export async function readJobRuntimeProfileVersion(sql: JobSql, workspaceId: string,
  profileId: string, revision: number): Promise<JobRuntimeProfileRecord> {
  const row = (await sql.query<{ record: unknown; current_record: unknown }>(`select v.record,p.record as current_record
    from job_runtime_profile_versions v join job_runtime_profiles p on p.id=v.profile_id
    where p.workspace_id=$1 and v.profile_id=$2 and v.revision=$3 for share of p,v`,
  [workspaceId, profileId, revision])).rows[0]
  if (!row) throw new DomainError('JOB_RUNTIME_UNQUALIFIED', 'The saved runtime profile version is missing.', 409)
  const current = JobRuntimeProfileRecordSchema.parse(row.current_record)
  const saved = JobRuntimeProfileRecordSchema.parse(row.record)
  if (saved.id !== profileId || saved.revision !== revision || saved.workspaceId !== workspaceId
    || current.id !== profileId || current.workspaceId !== workspaceId) {
    throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT', 'The saved runtime profile scope changed.', 409)
  }
  if (current.status === 'revoked') {
    throw new DomainError('AUTH_REVOKED', 'The runtime profile authority was revoked.', 403)
  }
  const measurements = (await sql.query<{ measurement: unknown }>(`select measurement
    from job_runtime_qualification_approvals where profile_id=$1 and profile_revision=$2
      and workspace_id=$3 and record->>'status'='complete' order by id`,
  [profileId, revision, workspaceId])).rows.map(row => JobRuntimeMeasurementRecordSchema.parse(row.measurement))
  if (saved.schemaVersion === 1) {
    const measurement = measurements.find(value => value.schemaVersion === 1 && Date.parse(value.expiresAt) > Date.now()
      && value.specDigest === saved.specDigest && value.profileId === profileId && value.profileRevision === revision)
    return JobRuntimeProfileRecordSchema.parse({ ...saved, status: measurement ? 'qualified' : saved.status,
      measurement: measurement ?? null })
  }
  const measurement = measurements.find(value => value.schemaVersion === 2 && Date.parse(value.expiresAt) > Date.now()
    && value.fingerprint.specDigest === saved.specDigest && value.identity.profileId === profileId
    && value.identity.profileRevision === revision)
  return JobRuntimeProfileRecordSchema.parse({ ...saved, status: measurement ? 'qualified' : saved.status,
    measurement: measurement ?? null })
}
