import { sourceMaterializationParent } from '@foreman-code/contracts/source-materialization'
import { isDeepStrictEqual as same } from 'node:util'
import { join } from 'node:path'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { ApprovedSourceSchema, SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { RemoteJobAcceptedSourceReadoutRecord } from '@foreman-code/contracts/remote-job-execution'
import { JobRuntimeProfileRecordSchema, JobVerificationRuntimeMeasurementSchema, jobRuntimeProfilePolicy, jobRuntimeProfileLimits }
  from '@foreman-code/contracts/job-verification-runtime'
import type { JobSql } from '../../jobs/repository.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { sourceSha256, verifySourceManifest } from '../../sources/manifest.js'
import { DomainError } from '../../errors.js'

export type AcceptedJobSourceReadout = RemoteJobAcceptedSourceReadoutRecord
function conflict(): never { throw new DomainError('JOB_ACCEPTED_SOURCE_CONFLICT', 'The original accepted Job source/root/runtime binding is unavailable or changed.', 409) }
/** Call after the exact current Job read fence, in the same transaction. This
 * returns immutable Main metadata, never a physical source/qualification claim. */
export function readAcceptedJobSource(sql: JobSql, execution: JobExecutionRecord): Promise<AcceptedJobSourceReadout> {
  return readJobSource(sql, execution, 'execution')
}

export function readAcceptedJobCleanupSource(sql: JobSql, execution: JobExecutionRecord): Promise<AcceptedJobSourceReadout> {
  return readJobSource(sql, execution, 'before-entry-cleanup')
}

async function readJobSource(sql: JobSql, execution: JobExecutionRecord, purpose: 'execution' | 'before-entry-cleanup')
  : Promise<AcceptedJobSourceReadout> {
  const spec = execution.acceptedSpec, target = spec.target, destination = target.destination
  const row = (await sql.query<{ record: unknown; state: string }>(`select record,state from source_execution_materializations
    where materialization_id=$1 and workspace_id=$2 and execution_id=$3 and attempt_id=$4 for share`,
  [spec.source.materializationId, execution.workspaceId, execution.id, execution.attemptId])).rows[0]
  if (!row) conflict()
  const materialization = SourceMaterializationRecordSchema.parse(row.record)
  materialization.state = SourceMaterializationRecordSchema.shape.state.parse(row.state)
  const receipt = materialization.receipt, binding = receipt.binding
  if (!['prepared', 'running', 'closed'].includes(materialization.state) || materialization.operationId !== execution.operationId ||
    receipt.materializationId !== spec.source.materializationId || receipt.executionId !== execution.id || receipt.attemptId !== execution.attemptId ||
    materialization.finalDispatchBindingHash !== spec.bindingHash || sourceMaterializationDigest(materialization) !== spec.source.materializationDigest ||
    binding.workspaceId !== execution.workspaceId || binding.mainId !== target.mainId || binding.snapshotId !== spec.source.snapshotId ||
    binding.manifestDigest !== spec.source.manifestDigest || receipt.verifiedManifestDigest !== spec.source.manifestDigest ||
    binding.deviceId !== (target.hostRef.kind === 'device' ? target.hostRef.deviceId : null) ||
    binding.workerInstallationId !== (target.registration?.workerInstallationId ?? null) || receipt.keyRevision !== (target.registration?.keyRevision ?? null) ||
    receipt.authorizationRevision !== (target.registration?.authorizationRevision ?? null) || binding.accessMode !== 'exclusive-write') conflict()
  const rootRow = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
    [binding.rootId, binding.bindingRevision])).rows[0]
  if (!rootRow) conflict()
  const root = SourceRootRecordSchema.parse(rootRow.record)
  const source = { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest }
  const projectRoot = join(sourceMaterializationParent(receipt), 'tree')
  if (!same(root.binding, binding) || !same(root.source, source) || !same(root.selection.hostRef, target.hostRef) || !same(root.registration, target.registration) ||
    root.attestationId !== destination.attestationId || root.attestationDigest !== destination.attestationHash ||
    root.selection.rootPolicyId !== destination.rootPolicyId || root.selection.rootPolicyRevision !== destination.rootPolicyRevision ||
    root.selection.locationRevision !== destination.locationRevision || materialization.rootPolicyId !== root.selection.rootPolicyId ||
    materialization.rootPolicyRevision !== root.selection.rootPolicyRevision || materialization.sourceBindingHash !== sourceBindingHash(root, receipt, execution.operationId) ||
    receipt.placementHash !== materialization.sourceBindingHash || binding.canonicalPath !== join(destination.managedRuntimeRoot, 'source-materializations', destination.rootPolicyId) || projectRoot !== destination.canonicalProjectRoot ||
    (spec.relativeCwd ? join(projectRoot, spec.relativeCwd) : projectRoot) !== destination.canonicalCwd ||
    sourceSha256(Buffer.from(JSON.stringify(receipt.localTreeIdentity))) !== destination.directoryIdentityHash) conflict()
  const snapshot = (await sql.query<{ record: unknown }>(`select record from source_snapshots
    where workspace_id=$1 and snapshot_id=$2 and approved_source_id=$3 and manifest_digest=$4 and availability='retained' for share`,
  [execution.workspaceId, source.snapshotId, source.approvedSourceId, source.manifestDigest])).rows[0]
  if (!snapshot) conflict()
  const approved = ApprovedSourceSchema.parse(snapshot.record), manifest = verifySourceManifest(approved.manifest)
  if (approved.workspaceId !== execution.workspaceId || approved.mainId !== target.mainId || approved.availability !== 'retained' ||
    manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes) conflict()
  if (manifest.snapshotId !== source.snapshotId || manifest.approvedSourceId !== source.approvedSourceId ||
    manifest.manifestDigest !== source.manifestDigest || manifest.git?.commit !== spec.source.commit) conflict()
  const version = (await sql.query<{ record: unknown }>('select record from job_runtime_profile_versions where profile_id=$1 and revision=$2 for share',
    [spec.policy.isolationPolicyId, spec.policy.isolationPolicyRevision])).rows[0]
  if (!version) conflict()
  const profile = JobRuntimeProfileRecordSchema.parse(version.record), original = profile.root
  const policy = jobRuntimeProfilePolicy(profile)
  const limits = jobRuntimeProfileLimits(profile)
  if (profile.id !== spec.policy.isolationPolicyId || profile.revision !== spec.policy.isolationPolicyRevision || profile.workspaceId !== execution.workspaceId ||
    !same(policy, spec.policy) || !same(original.selection, root.selection) || !same(original.registration, root.registration) ||
    original.binding.workspaceId !== execution.workspaceId || original.binding.canonicalPath !== binding.canonicalPath || !same(original.binding.filesystem, binding.filesystem) ||
    !Number.isSafeInteger(limits.diskBytes) || limits.diskBytes <= 0 || receipt.verifiedBytes > limits.diskBytes) conflict()
  if (execution.schemaVersion === 2) {
    const accepted = execution.acceptedSpec
    const qualified = (await sql.query<{ measurement: unknown }>(`select measurement
      from job_runtime_qualification_approvals where id=$1 and qualification_id=$2
        and profile_id=$3 and profile_revision=$4 and workspace_id=$5 and record->>'status'='complete' for share`,
    [accepted.profile.approvalId, accepted.profile.qualificationId, profile.id, profile.revision, execution.workspaceId])).rows[0]
    if (!qualified || profile.schemaVersion !== 2) conflict()
    const measured = JobVerificationRuntimeMeasurementSchema.parse(qualified.measurement)
    if (!same(measured.identity, accepted.profile) || !same(measured.fingerprint.root, original)) conflict()
    if (receipt.quota) {
      const slot = measured.fingerprint.quotaPool?.slots.find(value => value.namespace === receipt.quota!.namespace)
      if (!slot || !same(slot, receipt.quota)
        || slot.hardLimitBytes !== accepted.verification.resources.limits.diskBytes
        || slot.hardInodes !== accepted.verification.resources.mutableInodes) conflict()
    } else if (purpose === 'execution') conflict()
  }
  return { execution, materialization, root, diskQuotaBytes: limits.diskBytes }
}
