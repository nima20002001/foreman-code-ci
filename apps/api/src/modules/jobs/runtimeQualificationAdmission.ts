import { randomUUID } from 'node:crypto'
import { DeviceExecutionAdmissionFields } from '@foreman-code/contracts/device-resources'
import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileRecordSchema, JobRuntimeNativeAdmissionRecordSchema,
  type JobRuntimeNativeAdmissionRecord, type JobRuntimeFingerprintRecord, type JobRuntimeProfileRecord, type JobRuntimeApprovalRecord,
  type JobQualificationCandidateRecord, jobRuntimeQualificationAnchorAt } from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { JobSql } from './repository.js'
import { jobQualificationFingerprint } from './qualification.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

export interface JobRuntimeNativeAdmissionInput {
  candidate: JobQualificationCandidateRecord
  runCommandId: string
  runPrincipalId: string
  resolveRoot(sql: JobSql, profile: JobRuntimeProfileRecord, principal: Awaited<ReturnType<typeof readLiveManagementPrincipal>>): Promise<JobRuntimeProfileRecord['root']>
  /** Trusted installed host capture and live carrier binding; no public observations. */
  readCurrent(sql: JobSql, profile: JobRuntimeProfileRecord): Promise<{ fingerprint: JobRuntimeFingerprintRecord; connection: DeviceSessionBinding | null }>
}
function changed(): never { throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original human-approved qualification authority changed.', 409) }

/** Reading an admitted operation permits cleanup only; it cannot issue or renew a lease. */
export async function readInstalledJobQualificationAdmission(sql: JobSql, input: {
  approval: JobRuntimeApprovalRecord; runCommandId: string; runPrincipalId: string
}): Promise<JobRuntimeNativeAdmissionRecord> {
  const { approval } = input
  await lockActiveWorkspace(sql, approval.workspaceId)
  const row = (await sql.query<{
    record: unknown; run_command_id: string | null; run_principal_id: string | null; native_admission: unknown
  }>(`select record,run_command_id,run_principal_id,native_admission
    from job_runtime_qualification_approvals where id=$1 and workspace_id=$2 for share`,
  [approval.id,approval.workspaceId])).rows[0]
  if (!row?.native_admission) changed()
  const current = JobRuntimeApprovalRecordSchema.parse(row.record)
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse(row.native_admission)
  if (!['qualifying','recovery-required'].includes(current.status)
    || current.id !== approval.id || current.workspaceId !== approval.workspaceId
    || current.profileId !== approval.profileId || current.profileRevision !== approval.profileRevision
    || row.run_command_id !== input.runCommandId || row.run_principal_id !== input.runPrincipalId
    || current.qualificationId !== approval.qualificationId || current.fingerprintDigest !== approval.fingerprintDigest
    || canonicalJson(current.fingerprint) !== canonicalJson(approval.fingerprint)
    || admission.approvalId !== approval.id || admission.qualificationId !== approval.qualificationId
    || admission.workspaceId !== approval.workspaceId || admission.profileId !== approval.profileId
    || admission.profileRevision !== approval.profileRevision || admission.fingerprintDigest !== approval.fingerprintDigest
    || admission.runCommandId !== input.runCommandId || admission.runPrincipalId !== input.runPrincipalId
    || admission.expiresAt !== approval.expiresAt || admission.bootId !== approval.fingerprint.bootId
    || canonicalJson(admission.hostRef) !== canonicalJson(approval.fingerprint.hostRef)
    || canonicalJson(admission.registration) !== canonicalJson(approval.fingerprint.registration)
    || admission.mainInstallationId !== approval.fingerprint.mainInstallationId) changed()
  requireAuthorization(await readLiveManagementPrincipal(sql,input.runPrincipalId),
    'job_definitions:write',{workspaceId:approval.workspaceId})
  const registration = await assertDeviceHostInstallation(sql,admission.hostRef,
    admission.hostRef.kind === 'main' ? admission.mainInstallationId : admission.registration!.workerInstallationId)
  const registrationPin = registration ? { workerInstallationId: registration.workerInstallationId,
    keyRevision: registration.keyRevision,authorizationRevision: registration.authorizationRevision } : null
  if (canonicalJson(registrationPin) !== canonicalJson(admission.registration)) changed()
  return admission
}
/** Called inside the existing Main transaction, committed before native entry.
 * Its original approval row is the sole admission store. Retry reads the same
 * immutable lease and never mints replacement native authority. */
export async function admitInstalledJobQualification(sql: JobSql, input: JobRuntimeNativeAdmissionInput, options: { access: 'launch' | 'read'; requireExisting?: boolean } = { access: 'launch' }): Promise<JobRuntimeNativeAdmissionRecord> {
  const candidate = input.candidate
  await lockActiveWorkspace(sql,candidate.fingerprint.root.binding.workspaceId)
  const row = (await sql.query<{ record: unknown; run_command_id: string | null; run_principal_id: string | null;
    native_admission: unknown }>(`select record,run_command_id,run_principal_id,native_admission
      from job_runtime_qualification_approvals where id=$1 for update`, [candidate.approvalId])).rows[0]
  if (!row) changed()
  const approval = JobRuntimeApprovalRecordSchema.parse(row.record)
  if (options.access === 'read') {
    if (candidate.approvalId !== approval.id || candidate.fingerprint.root.binding.workspaceId !== approval.workspaceId
      || candidate.operationId !== approval.qualificationId || candidate.qualificationId !== approval.qualificationId
      || jobQualificationFingerprint(candidate) !== approval.fingerprintDigest
      || canonicalJson(candidate.fingerprint) !== canonicalJson(approval.fingerprint)) changed()
    return readInstalledJobQualificationAdmission(sql,{ approval,runCommandId: input.runCommandId,
      runPrincipalId: input.runPrincipalId })
  }
  if (approval.id!==candidate.approvalId||approval.workspaceId!==candidate.fingerprint.root.binding.workspaceId||approval.status !== 'qualifying' || row.run_command_id !== input.runCommandId || row.run_principal_id !== input.runPrincipalId || Date.parse(approval.expiresAt) <= Date.now() ||
    candidate.operationId !== approval.qualificationId || candidate.qualificationId !== approval.qualificationId ||
    jobQualificationFingerprint(candidate) !== approval.fingerprintDigest || canonicalJson(candidate.fingerprint) !== canonicalJson(approval.fingerprint)) changed()
  const runner=await readLiveManagementPrincipal(sql, input.runPrincipalId)
  requireAuthorization(runner, 'job_definitions:write', { workspaceId: approval.workspaceId })
  const profileRow = (await sql.query<{ record: unknown }>(`select v.record from job_runtime_profile_versions v
    join job_runtime_profiles p on p.id=v.profile_id where p.workspace_id=$1 and v.profile_id=$2 and v.revision=$3
    and p.revision=$3 and p.record->>'status'='qualifying' for share of p,v`, [approval.workspaceId, approval.profileId, approval.profileRevision])).rows[0]
  if (!profileRow) changed()
  const profile = JobRuntimeProfileRecordSchema.parse(profileRow.record)
  if ('approvedAt' in candidate && candidate.approvedAt !== jobRuntimeQualificationAnchorAt(approval)) changed()
  if ('profile' in candidate && canonicalJson(candidate.profile) !== canonicalJson(profile)) changed()
  if (profile.id !== approval.profileId || profile.revision !== approval.profileRevision || profile.workspaceId !== approval.workspaceId ||
    profile.specDigest !== approval.fingerprint.specDigest || canonicalJson(profile.root) !== canonicalJson(approval.fingerprint.root)) changed()
  if(canonicalJson(await input.resolveRoot(sql,profile,runner))!==canonicalJson(profile.root))changed()
  const root=profile.root
  const currentRoot=(await sql.query(`select 1 from source_root_catalog c join workspace_root_policies p on p.workspace_id=c.workspace_id
    where c.root_id=$1 and c.workspace_id=$2 and c.current_binding_revision=$3
    and p.root_policy_id=$4 and p.root_policy_revision=$5 and p.revoked_at is null for share of c,p`,
    [root.binding.rootId,approval.workspaceId,root.binding.bindingRevision,root.selection.rootPolicyId,root.selection.rootPolicyRevision])).rows[0]
  if(!currentRoot||root.binding.accessMode!=='exclusive-write')changed()
  const current = await input.readCurrent(sql, profile)
  if (canonicalJson(current.fingerprint) !== canonicalJson(approval.fingerprint)) changed()
  const fingerprint = current.fingerprint
  const registration = await assertDeviceHostInstallation(sql, fingerprint.hostRef,
    fingerprint.hostRef.kind === 'main' ? fingerprint.mainInstallationId : fingerprint.registration!.workerInstallationId)
  const registrationPin = registration ? { workerInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
    authorizationRevision: registration.authorizationRevision } : null
  if (canonicalJson(registrationPin) !== canonicalJson(fingerprint.registration)) changed()
  const context = { schemaVersion: fingerprint.schemaVersion,
    ...Object.fromEntries(Object.keys(DeviceExecutionAdmissionFields).filter(field => field in fingerprint)
      .map(field => [field, Reflect.get(fingerprint, field)])), kind: 'job-runtime-qualification' as const, approvalId: approval.id,
    qualificationId: approval.qualificationId, operationId: approval.qualificationId, workspaceId: approval.workspaceId,
    profileId: approval.profileId, profileRevision: approval.profileRevision, fingerprintDigest: approval.fingerprintDigest,
    runCommandId: input.runCommandId, runPrincipalId: input.runPrincipalId,
    ...(approval.approvedByPrincipalId ? { approvedByPrincipalId: approval.approvedByPrincipalId } : {}),
    hostRef: fingerprint.hostRef, registration: fingerprint.registration, mainInstallationId: fingerprint.mainInstallationId,
    bootId: fingerprint.bootId, connection: current.connection, expiresAt: approval.expiresAt }
  if (row.native_admission) {
    const saved = JobRuntimeNativeAdmissionRecordSchema.parse(row.native_admission)
    const expected = { ...context, leaseId: saved.leaseId, admittedAt: saved.admittedAt }
    if (canonicalJson(saved) !== canonicalJson(expected)) changed()
    return saved
  }
  if(options.requireExisting)changed()
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse({ ...context, leaseId: randomUUID(), admittedAt: new Date().toISOString() })
  await sql.query('update job_runtime_qualification_approvals set native_admission=$2::jsonb where id=$1', [approval.id, JSON.stringify(admission)])
  return admission
}

/** Recheck the original persisted lease without ever creating one. */
export async function assertInstalledJobQualification(sql:JobSql,input:JobRuntimeNativeAdmissionInput,admission:JobRuntimeNativeAdmissionRecord):Promise<void> {
  const saved=await admitInstalledJobQualification(sql,input,{ access: 'launch', requireExisting: true })
  if(canonicalJson(saved)!==canonicalJson(admission))changed()
}

export async function assertInstalledJobQualificationRead(sql: JobSql, input: JobRuntimeNativeAdmissionInput,
  admission: JobRuntimeNativeAdmissionRecord): Promise<void> {
  const saved = await admitInstalledJobQualification(sql, input, { access: 'read', requireExisting: true })
  if (canonicalJson(saved) !== canonicalJson(admission)) changed()
}
