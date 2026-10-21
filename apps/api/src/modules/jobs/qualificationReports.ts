import { qualificationUnitWorkers, qualificationIntegrationShards } from '@foreman-code/contracts/job-verification-policy'
import { withTransaction } from '../../infrastructure/transaction.js'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { JobDefinitionRecordSchema, JobVerificationReportReadSchema }
  from '@foreman-code/contracts/job-verification'
import { JobQualificationReportSchema, JobVerificationQualificationCandidateSchema,
  type JobQualificationReport, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import { createCanonicalJobArtifactPort } from '../files/jobs/factory.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { JobSql } from './repository.js'
import { sourceBindingHash } from '../sources/bindingHash.js'
import { jobDigest } from './digest.js'
import { qualificationExecution } from './qualificationExecution.js'

export type QualificationReportPublisher = (candidate: JobQualificationCandidateRecord,
  report: JobQualificationReport, bytes: Uint8Array) => Promise<JobArtifact>

export function validateQualificationReport(raw: JobQualificationCandidateRecord, report: JobQualificationReport) {
  const candidate = JobVerificationQualificationCandidateSchema.parse(raw)
  const { identity } = report.context
  const materialization = report.materialization
  const { scope } = report.closure
  const expectedRoot = candidate.fingerprint.quotaPool?.slots.some(slot =>
    identity.target.destination.canonicalProjectRoot === join(candidate.sourceParent,
      slot.namespace, candidate.operationId, 'tree'))
  const fingerprintDigest = jobDigest(candidate.fingerprint)
  const expectedBinding = sourceBindingHash(candidate.profile.root, materialization.receipt, identity.executionId)
  if (materialization.sourceBindingHash !== expectedBinding
    || materialization.receipt.placementHash !== expectedBinding
    || materialization.reservationId !== candidate.qualificationId
    || materialization.receipt.localTreeIdentity.device !== candidate.profile.root.binding.filesystem.device
    || materialization.receipt.localTreeIdentity.mountId !== candidate.profile.root.binding.filesystem.mountId
    || identity.target.destination.directoryIdentityHash !== jobDigest(materialization.receipt.localTreeIdentity)
    || materialization.operationId !== identity.executionId
    || materialization.receipt.executionId !== identity.executionId
    || materialization.receipt.attemptId !== identity.attemptId
    || materialization.receipt.materializationId !== candidate.qualificationId
    || materialization.receipt.verifiedManifestDigest !== identity.manifestDigest
    || !isDeepStrictEqual(materialization.receipt.binding, candidate.profile.root.binding)
    || !candidate.fingerprint.quotaPool?.slots.some(slot => isDeepStrictEqual(slot, materialization.receipt.quota))
    || !expectedRoot || scope.admission.approvalId !== candidate.approvalId
    || scope.subject.operationId !== candidate.operationId
    || scope.subject.fingerprint !== fingerprintDigest
    || identity.profile.fingerprintDigest !== fingerprintDigest
    || scope.subject.qualificationId !== candidate.qualificationId
    || scope.subject.profileId !== candidate.profile.id || scope.subject.profileRevision !== candidate.profile.revision
    || scope.admission.operationId !== candidate.operationId
    || scope.admission.workspaceId !== candidate.profile.workspaceId
    || identity.profile.rootId !== candidate.profile.root.binding.rootId
    || identity.profile.bindingRevision !== candidate.profile.root.binding.bindingRevision
    || identity.profile.approvalExpiresAt !== scope.admission.expiresAt
    || Date.parse(identity.profile.qualificationExpiresAt) > Date.parse(scope.admission.expiresAt)
    || contextTimeoutWidened(candidate, report)
    || identity.target.destination.managedRuntimeRoot !== candidate.runtimeRoot
    || identity.target.destination.canonicalCwd !== identity.target.destination.canonicalProjectRoot
    || identity.target.destination.rootPolicyId !== candidate.profile.root.selection.rootPolicyId
    || identity.target.destination.rootPolicyRevision !== candidate.profile.root.selection.rootPolicyRevision
    || scope.admission.fingerprintDigest !== identity.profile.fingerprintDigest
    || scope.bootId !== candidate.fingerprint.bootId
    || report.closure.process.bootId !== scope.bootId
    || identity.commit !== candidate.profile.sourceCommit
    || identity.manifestDigest !== candidate.profile.root.source.manifestDigest
    || identity.profile.profileId !== candidate.profile.id
    || identity.profile.profileRevision !== candidate.profile.revision
    || identity.profile.qualificationId !== candidate.qualificationId
    || identity.profile.approvalId !== candidate.approvalId
    || !identity.executionId.startsWith(`${candidate.operationId}:`)
    || !identity.definitionVersionId.startsWith(`${candidate.profile.id}:${candidate.profile.revision}:`)
    || !candidate.profile.spec.suites.includes(identity.suite)
    || !isDeepStrictEqual(identity.resources, candidate.profile.spec.resources)
    || !isDeepStrictEqual(identity.target.hostRef, candidate.fingerprint.hostRef)
    || !isDeepStrictEqual(identity.target.registration, candidate.fingerprint.registration)
    || !isDeepStrictEqual(identity.profile.network, candidate.fingerprint.network)
    || identity.profile.imageDigest !== candidate.fingerprint.imageDigest
    || identity.profile.toolchainDigest !== candidate.fingerprint.toolchainDigest
    || identity.parameters.unitWorkers !== qualificationUnitWorkers(candidate.profile.spec.resources.limits)
    || identity.parameters.integrationShards !== (identity.suite === 'integration'
      ? qualificationIntegrationShards(candidate.profile.spec.resources) : 1)
) {
    throw new DomainError('JOB_QUALIFICATION_REPORT_CONFLICT', 'Report differs from its approved diagnostic.', 409)
  }
  return candidate
}

/** Human-approved diagnostics publish through the ordinary canonical Job file ledger. */
export function createQualificationReportPublisher(input: { pool: pg.Pool; storageRoot: string }) {
  return async (raw: JobQualificationCandidateRecord, rawReport: JobQualificationReport, bytes: Uint8Array,
    assertCurrent: () => Promise<void>): Promise<JobArtifact> => {
    const report = JobQualificationReportSchema.parse(rawReport)
    const candidate = validateQualificationReport(raw, report)
    if (report.byteSize !== bytes.byteLength || report.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw new DomainError('JOB_QUALIFICATION_REPORT_CONFLICT', 'Diagnostic report bytes changed.', 409)
    }
    const execution = qualificationExecution(candidate, report)
    const spec = execution.acceptedSpec
    const declaration = spec.outputs.find(output => output.path === report.path)!
    if (report.byteSize > declaration.maxBytes) throw new DomainError('JOB_OUTPUT_BUDGET_EXCEEDED',
      'Qualification report exceeds its approved declaration.', 413)
    const authorize = async (sql: JobSql) => {
      await assertCurrent()
      const row = (await sql.query<{ record: unknown; run_principal_id: string }>(
        'select record,run_principal_id from job_runtime_qualification_approvals where id=$1 for share',
        [candidate.approvalId])).rows[0]
      const approval = row?.record as { status: string; fingerprintDigest: string; expiresAt: string }
      if (!row || approval.status !== 'qualifying'
        || approval.fingerprintDigest !== report.closure.scope.subject.fingerprint
        || Date.parse(approval.expiresAt) <= Date.now()) {
        throw new DomainError('JOB_RUNTIME_QUALIFICATION_OWNER_CHANGED', 'The original qualification is no longer active.', 403)
      }
      const principal = await readLiveManagementPrincipal(sql, row.run_principal_id)
      requireAuthorization(principal, 'job_definitions:write', { workspaceId: execution.workspaceId })
      requireAuthorization(principal, 'jobs:start', { workspaceId: execution.workspaceId })
      requireAuthorization(principal, 'job_artifacts:read', { workspaceId: execution.workspaceId })
      return { principal, execution }
    }
    await withTransaction(input.pool, async (sql) => {
      const { principal } = await authorize(sql)
      const { target, argv, inputs, outputs, policy, verification } = spec
      const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: spec.definitionId,
        workspaceId: execution.workspaceId, revision: 1, versionId: spec.definitionVersionId,
        name: `Verification qualification: ${execution.attemptId.split(':').at(-1)}`,
        spec: { source: { ...candidate.profile.root.source, commit: report.context.identity.commit },
          target, argv, inputs, outputs, policy, verification },
        createdAt: execution.createdAt, updatedAt: execution.createdAt })
      await sql.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by)
        values($1,$2,1,$3,$4::jsonb,$5) on conflict(id) do nothing`,
      [definition.id, definition.workspaceId, definition.versionId, JSON.stringify(definition), principal.id])
      await sql.query(`insert into job_definition_versions(id,definition_id,workspace_id,revision,record)
        values($1,$2,$3,1,$4::jsonb) on conflict(id) do nothing`,
      [definition.versionId, definition.id, definition.workspaceId, JSON.stringify(definition)])
      await sql.query(`insert into job_executions(id,workspace_id,definition_version_id,operation_id,attempt_id,
        record,accepted_spec,accepted_by) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) on conflict(id) do nothing`,
      [execution.id, execution.workspaceId, spec.definitionVersionId, execution.operationId, execution.attemptId,
        JSON.stringify(execution), JSON.stringify(spec), principal.id])
      const saved = (await sql.query<{ accepted_spec: unknown }>('select accepted_spec from job_executions where id=$1',
        [execution.id])).rows[0]!
      if (!isDeepStrictEqual(saved.accepted_spec, spec)) throw new Error('Original diagnostic Job changed.')
    })
    const artifacts = createCanonicalJobArtifactPort({ ...input,
      authority: { authorizePublication: authorize },
      reader: { open: async request => {
        if (request.path !== report.path || request.sha256 !== report.sha256) throw new Error('Sealed report changed.')
        return Readable.from(Buffer.from(bytes))
      } } })
    try {
    const published = await artifacts.publishAccepted({ workspaceId: execution.workspaceId, executionId: execution.id,
      attemptId: execution.attemptId, owner: execution.owner, commandId: `${execution.id}:${report.path}`,
      path: report.path, mediaType: declaration.mediaType, sha256: report.sha256, byteSize: report.byteSize })
    const { principal } = await authorize(input.pool)
    const retained = await artifacts.read(input.pool, principal, execution.workspaceId, execution.id,
      published.artifact.fileId, published.artifact.revisionId)
    if (!Buffer.from(bytes).equals(retained.bytes)) throw new Error('Canonical diagnostic report readback differs.')
    const all = await artifacts.list(input.pool, principal, execution.workspaceId, execution.id)
    if (all.length === spec.outputs.length) {
      await artifacts.verifyRequiredOutputs(input.pool, execution)
      await input.pool.query('update job_executions set record=$2::jsonb where id=$1',
        [execution.id, JSON.stringify({ ...execution, publication: 'complete' })])
    }
    if (report.path.endsWith('/summary.json')) JobVerificationReportReadSchema.parse({
      report: JSON.parse(retained.bytes.toString('utf8')), expected: report.context.identity })
    return retained.artifact
    } catch (error) {
      await input.pool.query('update job_executions set record=$2::jsonb where id=$1',
        [execution.id, JSON.stringify({ ...execution, publication: 'failed', resultIssue: 'publication_failed' })])
      throw error
    }
  }
}


function contextTimeoutWidened(candidate: ReturnType<typeof JobVerificationQualificationCandidateSchema.parse>,
  report: JobQualificationReport): boolean {
  const context = report.context
  const policy = candidate.profile.spec.policy
  const maximum = Math.floor(Math.min(policy.maxOutputBytes, candidate.profile.spec.resources.reportBytes) / 4)
  return context.executionTimeoutMs > policy.executionTimeoutMs
    || context.cancellationTimeoutMs > policy.cancellationGraceMs
    || ['summaryBytes', 'junitBytes', 'vitestBytes', 'logsArchiveBytes'].some(name =>
      Reflect.get(context.limits, name) > maximum)
}
