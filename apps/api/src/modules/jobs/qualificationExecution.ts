import { errorMessage } from '../../shared/errorMessage.js'
import { acceptedJobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { AcceptedVerificationJobSpecSchema, VerificationJobExecutionSchema,
  type JobVerificationReport } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { JobVerificationQualificationCandidateSchema,
  type JobQualificationReport, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { QUALIFICATION_PRESSURE_DRIVER } from './qualificationCancellation.js'
import { sourceMaterializationDigest } from '../sources/bindingHash.js'
import { jobDigest } from './digest.js'

export async function publishFailedQualification(input: {
  suite: string
  exitCode: number
  stderr: string
  failure?: Error
  closeContainer(): Promise<boolean>
  publish(): Promise<JobVerificationReport>
}): Promise<never> {
  const originalFailure = input.failure?.message.slice(0, 240)
  const failure = `${input.suite} qualification failed (exit ${input.exitCode}).`
    + (originalFailure ? ` ${originalFailure}` : '')
  if (!await input.closeContainer()) {
    throw new Error(`${failure} Physical closure of verification descendants is unconfirmed.`, { cause: input.failure })
  }
  const diagnostic = input.stderr.trim().slice(0, 300)
  let report: JobVerificationReport
  try {
    report = await input.publish()
  } catch (error) {
    const publication = errorMessage(error, 'Reports are unavailable')
    throw new Error(`${failure} Report publication failed: ${publication.slice(0, 160)}. ${diagnostic}`.trim()
      .slice(0, 500), { cause: error })
  }
  const retained = `Reports: Job ${report.executionId}. ${report.totals.failed} failed checks; `
    + `${report.completedPortions}/${report.expectedPortions} portions complete (${report.outcome}).`
  throw new Error(`${failure} ${retained} ${diagnostic}`.trim().slice(0, 500), { cause: input.failure })
}

/** Qualification has human diagnostic admission; it does not borrow a qualified Job grant. */
export function qualificationExecution(raw: JobQualificationCandidateRecord,
  report: Pick<JobQualificationReport, 'context' | 'terminal' | 'startedAt' | 'materialization'>) {
  const candidate = JobVerificationQualificationCandidateSchema.parse(raw)
  const { context, terminal, startedAt } = report
  const identity = context.identity
  const policy = { ...candidate.profile.spec.policy, isolationPolicyId: candidate.profile.id,
    isolationPolicyRevision: candidate.profile.revision, executionTimeoutMs: context.executionTimeoutMs }
  const files = [
    ['summary.json', 'suite-summary', 'application/json', context.limits.summaryBytes],
    ['junit.xml', 'junit', 'application/xml', context.limits.junitBytes],
    ['vitest.json', 'vitest-json', 'application/json', context.limits.vitestBytes],
    ['logs.tar.gz', 'logs-archive', 'application/gzip', context.limits.logsArchiveBytes],
  ] as const
  const outputs = files.map(([name, kind, mediaType, maxBytes]) => ({
    path: `.logs/verification/${name}`, kind, mediaType, maxBytes, required: true,
  }))
  const source = { ...candidate.profile.root.source, commit: candidate.profile.sourceCommit,
    materializationId: report.materialization.receipt.materializationId,
    materializationDigest: sourceMaterializationDigest(report.materialization) }
  const definitionId = `qualification:${identity.executionId}`
  const interruption = identity.executionId.endsWith(':cancelled') || identity.executionId.endsWith(':timed_out')
  const argv = interruption
    ? ['node', '-e', QUALIFICATION_PRESSURE_DRIVER, '/workspace/.graphql-job-inputs/qualification-context.json']
    : ['node', '/opt/graphql-ci/verification/verify-repository.mjs', '--context',
      '.graphql-job-inputs/qualification-context.json']
  const spec = { schemaVersion: 2, source, target: identity.target, argv,
    inputs: [], outputs, policy, workflowInput: null, definitionId, definitionRevision: 1,
    definitionVersionId: identity.definitionVersionId, profile: identity.profile,
    reservationId: candidate.qualificationId, lifecycle: verificationJobLifecycle(startedAt, policy),
    verification: { suite: identity.suite, resources: identity.resources,
      parameters: identity.parameters, credentialRefs: [] },
    resourcePolicyRevision: candidate.fingerprint.resourcePolicyRevision,
    resourcePolicyDigest: candidate.fingerprint.resourcePolicyDigest,
    runtimeApprovalId: candidate.fingerprint.runtimeApprovalId,
    runtimeApprovalRevision: candidate.fingerprint.runtimeApprovalRevision,
    scriptDigest: jobDigest(argv), outputSpecDigest: jobDigest(outputs),
    specDigest: jobDigest({ context, policy, source }), bindingHash: jobDigest({ candidate: candidate.fingerprint, context }) }
  const accepted = AcceptedVerificationJobSpecSchema.parse(spec)
  return VerificationJobExecutionSchema.parse({ schemaVersion: 2, id: identity.executionId,
    workspaceId: candidate.profile.workspaceId, acceptedSpec: { ...accepted, ...acceptedJobSpecDigests(accepted) },
    operationId: identity.executionId, attemptId: identity.attemptId,
    owner: { grantId: `qualification:${candidate.approvalId}`, epoch: '1' }, workflow: null,
    process: { phase: 'terminal', outcome: terminal.outcome, exitCode: terminal.exitCode,
      signal: terminal.signal, processStopped: true },
    transport: 'connected', publication: 'collecting', startedAt, finishedAt: terminal.finishedAt,
    lastSeenAt: terminal.finishedAt, resultIssue: null,
    cancelRequestedAt: terminal.outcome === 'cancelled' ? terminal.finishedAt : null,
    createdAt: startedAt, updatedAt: terminal.finishedAt })
}
