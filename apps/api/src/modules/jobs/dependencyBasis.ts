import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { JobDependencyBasisSchema, jobDependencyInputs, sameJobDependencyInputs, type JobDependencyBasis,
  type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import { DomainError } from '../errors.js'
import type { JobSql } from './repository.js'

interface SourcePin { approvedSourceId: string; snapshotId: string; manifestDigest: string; commit: string }

async function sourceEntries(sql: JobSql, workspaceId: string, pin: Omit<SourcePin, 'commit'>) {
  const row = (await sql.query<{ record: unknown }>(`select record from source_snapshots
    where workspace_id=$1 and approved_source_id=$2 and snapshot_id=$3 and manifest_digest=$4 for share`,
  [workspaceId, pin.approvedSourceId, pin.snapshotId, pin.manifestDigest])).rows[0]
  if (!row) throw new DomainError('SOURCE_NOT_FOUND', 'The exact approved source snapshot was not found in this workspace.', 404)
  const source = ApprovedSourceSchema.parse(row.record)
  if (source.workspaceId !== workspaceId || source.manifest.manifestDigest !== pin.manifestDigest) {
    throw new DomainError('SOURCE_FACT_CONFLICT', 'Persisted source facts do not match their immutable identifiers.', 409)
  }
  return source.manifest.entries
}

/** A computer qualifies its runtime with one commit's offline dependency seed. Another commit may run on it
 * when its dependency files are byte-identical; otherwise the Job waits for a qualification of the new files.
 * Undefined means the Job uses the qualification commit itself. */
export async function verificationDependencyBasis(sql: JobSql, workspaceId: string, profile: JobVerificationProfile,
  source: SourcePin): Promise<JobDependencyBasis | undefined> {
  if (!profile.sourceCommit) throw new DomainError('JOB_SOURCE_COMMIT_REQUIRED', 'The verification profile has no qualification commit.', 409)
  if (source.commit === profile.sourceCommit) return undefined
  const qualified = jobDependencyInputs(await sourceEntries(sql, workspaceId, profile.root.source))
  const requested = jobDependencyInputs(await sourceEntries(sql, workspaceId, source))
  if (!sameJobDependencyInputs(qualified, requested)) {
    throw new DomainError('JOB_DEPENDENCIES_CHANGED',
      'This commit changes dependency files; qualify the computer for them before it can run this Job.', 409)
  }
  return JobDependencyBasisSchema.parse({ qualificationCommit: profile.sourceCommit, inputs: qualified })
}
