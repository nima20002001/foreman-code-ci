import type pg from 'pg'
import { JobRuntimeProfileRecordSchema, type JobRuntimeProfileRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'

/** A failed inspection is retried only after this delay; every queue wake would otherwise re-measure it. */
export const JOB_RUNTIME_INSPECTION_RETRY_MS = 30_000

/** Restores inspected metadata without creating or extending qualification. */
export class JobRuntimeMetadataRecovery {
  private readonly captures = new Map<string, Promise<void>>()
  private readonly failedAt = new Map<string, number>()
  private scan: Promise<void> | undefined
  private closing = false

  constructor(private readonly pool: pg.Pool, private readonly host: InstalledJobRuntimeHost,
    private readonly changed: () => void, private readonly now: () => number = Date.now) {}

  request(): void {
    if (this.closing || this.scan) return
    this.scan = this.pool.query<{ record: unknown }>(`select record from job_runtime_profiles
      where record->>'status'='qualified'
      union all select v.record || jsonb_build_object('status','qualified','measurement',a.measurement)
        from job_runtime_profile_versions v join job_runtime_qualification_approvals a
          on a.profile_id=v.profile_id and a.profile_revision=v.revision
        join job_runtime_profiles p on p.id=v.profile_id
        where a.record->>'status'='complete' and p.record->>'status'<>'revoked'`)
      .then(result => {
        for (const row of result.rows) {
          const parsed = JobRuntimeProfileRecordSchema.safeParse(row.record)
          if (!parsed.success) {
            componentLogger('jobs').error({ err: parsed.error }, 'Stored Job runtime metadata is invalid')
            continue
          }
          const profile = parsed.data
          if (!profile.measurement || Date.parse(profile.measurement.expiresAt) <= Date.now()) continue
          const key = `${profile.id}:${profile.revision}`
          if (this.captures.has(key)) continue
          const failed = this.failedAt.get(key)
          if (failed !== undefined && this.now() - failed < JOB_RUNTIME_INSPECTION_RETRY_MS) continue
          const capture = this.refresh(profile).then(refreshed => {
            this.failedAt.delete(key)
            if (refreshed && !this.closing) this.changed()
          }).catch(error => {
            // A connection that is not bound yet resolves on reconnect; only rejected inspections wait.
            if (!(error instanceof DomainError && error.code === 'JOB_RUNTIME_CONNECTION_CHANGED')) this.failedAt.set(key, this.now())
            componentLogger('jobs').warn({ err: error, profileId: profile.id }, 'Job runtime inspection unavailable')
          }).finally(() => { this.captures.delete(key) })
          this.captures.set(key, capture)
        }
      }).catch(error => {
        componentLogger('jobs').error({ err: error }, 'Job runtime metadata recovery failed')
      }).finally(() => { this.scan = undefined })
  }

  private async refresh(profile: JobRuntimeProfileRecord): Promise<boolean> {
    if (await this.host.currentMetadata(this.pool, profile)) return false
    if (this.host.capture) await this.host.capture(profile)
    else await this.host.descriptor(profile)
    // Runtime readiness still compares this inspected fingerprint with the retained measurement.
    return true
  }

  async refreshExecution(executionId: string): Promise<void> {
    const row = (await this.pool.query<{ record: unknown }>(`select v.record from job_executions e
      join job_runtime_profile_versions v on v.profile_id=e.accepted_spec #>> '{policy,isolationPolicyId}'
        and v.revision=(e.accepted_spec #>> '{policy,isolationPolicyRevision}')::bigint
      where e.id=$1`, [executionId])).rows[0]
    if (row) await this.refresh(JobRuntimeProfileRecordSchema.parse(row.record))
  }

  async close(): Promise<void> {
    this.closing = true
    await this.scan
    await Promise.all([...this.captures.values()])
  }
}
