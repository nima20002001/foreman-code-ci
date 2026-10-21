import { AcceptedVerificationJobSpecSchema, type PreparedJobSpecRecord,
  type JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import { JobVerificationDispatchValiditySchema, verificationJobLifecycle }
  from '@foreman-code/contracts/job-verification-policy'
import type { RunInput } from '@foreman-code/contracts'
import { acceptedJobSpecDigests, jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { JobSql } from './repository.js'
import { readJobRuntimeProfileVersion } from './runtimeProfileVersion.js'
import { verificationDependencyBasis } from './dependencyBasis.js'

export async function acceptVerificationSpec(sql: JobSql, input: {
  definition: JobDefinitionRecord
  spec: PreparedJobSpecRecord
  workflowInput: RunInput | null
  executionId: string
  attemptId: string
  operationId: string
}) {
  if (!('verification' in input.spec)) throw new Error('Verification acceptance requires a verification request.')
  const spec = input.spec
  const profile = await readJobRuntimeProfileVersion(sql, input.definition.workspaceId,
    spec.policy.isolationPolicyId, spec.policy.isolationPolicyRevision)
  if (profile.schemaVersion !== 2 || !profile.measurement || profile.status !== 'qualified') {
    throw new DomainError('JOB_RUNTIME_UNQUALIFIED', 'Verification requires its own measured runtime profile.', 409)
  }
  const selection = (await sql.query<{ claimed_at: Date | null; operation_id: string; attempt_id: string;
    spec: unknown; limits: unknown; ticket_id: string | null }>(`select s.claimed_at,s.operation_id,s.attempt_id,
      s.spec,s.limits,q.id::text as ticket_id from job_computer_selections s
      left join job_admission_queue q on q.execution_id=s.execution_id
      where s.execution_id=$1 and s.workspace_id=$2 for share of s`,
  [input.executionId, input.definition.workspaceId])).rows[0]
  if (!selection?.claimed_at || selection.operation_id !== input.operationId || selection.attempt_id !== input.attemptId
    || canonicalJson(selection.limits) !== canonicalJson(spec.verification.resources.limits)) {
    throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'The original verification capacity claim is missing or changed.', 409)
  }
  const measurement = profile.measurement
  if (measurement.fingerprint.sourceCommit !== profile.sourceCommit) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The verification measurement belongs to another qualification commit.', 409)
  }
  const dependencyBasis = await verificationDependencyBasis(sql, input.definition.workspaceId, profile, spec.source)
  const dispatchAt = selection.claimed_at.toISOString()
  JobVerificationDispatchValiditySchema.parse({ identity: measurement.identity, approvedAt: measurement.approvedAt,
    approvalConfig: profile.approvalConfig, dispatchAt, policy: spec.policy })
  const fingerprint = measurement.fingerprint
  const accepted = AcceptedVerificationJobSpecSchema.parse({ ...spec,
    schemaVersion: 2, workflowInput: input.workflowInput,
    definitionId: input.definition.id, definitionRevision: input.definition.revision,
    definitionVersionId: input.definition.versionId, profile: measurement.identity,
    reservationId: selection.ticket_id ?? input.operationId,
    lifecycle: verificationJobLifecycle(dispatchAt, spec.policy),
    resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
    runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
    ...(dependencyBasis ? { dependencyBasis } : {}),
    ...jobSpecDigests(spec, input.workflowInput) })
  return AcceptedVerificationJobSpecSchema.parse({ ...accepted, ...acceptedJobSpecDigests(accepted) })
}
