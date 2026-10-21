import { JobVerificationProfileSchema, type JobVerificationProfile,
  type JobRuntimeProfileRecord, type JobVerificationProfileInput } from '@foreman-code/contracts/job-verification-runtime'
import { JobVerificationApprovalConfigSchema, JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
  JOB_VERIFICATION_OWNER_CONFIGURATION }
  from '@foreman-code/contracts/job-verification-policy'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import { jobDigest } from './digest.js'

export function createVerificationProfile(input: {
  id: string
  workspaceId: string
  revision: number
  name: string
  root: SourceRootRecord
  sourceCommit: string
  spec: JobVerificationProfileInput
  previous: JobRuntimeProfileRecord | null
  now: string
}) {
  const previous = input.previous
  const approvalConfig = JobVerificationApprovalConfigSchema.parse({
    schemaVersion: 1, revision: JOB_VERIFICATION_OWNER_CONFIGURATION.revision,
    approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
    review: { authority: 'repository-owner', decisionId: JOB_VERIFICATION_OWNER_CONFIGURATION.id,
      reviewedOn: JOB_VERIFICATION_OWNER_CONFIGURATION.reviewedOn,
      decisionDigest: jobDigest(JOB_VERIFICATION_OWNER_CONFIGURATION) },
  })
  if (input.spec.approvalConfig.approvalLifetimeMs !== approvalConfig.approvalLifetimeMs) {
    throw new DomainError('JOB_VERIFICATION_APPROVAL_POLICY_CONFLICT',
      'The reviewed verification approval lifetime is 24 hours.', 409)
  }
  if (input.spec.policy.network.mode !== 'none') {
    throw new DomainError('JOB_VERIFICATION_NETWORK_POLICY_CONFLICT',
      'Verification uses a private network namespace with no network and offline dependencies.', 409)
  }
  return JobVerificationProfileSchema.parse({
    schemaVersion: 2, id: input.id, workspaceId: input.workspaceId, revision: input.revision,
    name: input.name, root: input.root, sourceCommit: input.sourceCommit, spec: input.spec,
    specDigest: jobDigest({ workspaceId: input.workspaceId, id: input.id, revision: input.revision,
      root: input.root, sourceCommit: input.sourceCommit, spec: input.spec, approvalConfig }),
    approvalConfig, status: 'unqualified', measurement: null,
    createdAt: previous?.createdAt ?? input.now, updatedAt: input.now,
  })
}

export function requireReviewedVerificationConfiguration(profile: JobVerificationProfile): void {
  const review = profile.approvalConfig.review
  if (!review || !('authority' in review) || review.decisionId !== JOB_VERIFICATION_OWNER_CONFIGURATION.id
    || review.decisionDigest !== jobDigest(JOB_VERIFICATION_OWNER_CONFIGURATION)
    || profile.approvalConfig.approvalLifetimeMs !== JOB_VERIFICATION_APPROVAL_LIFETIME_MS
    || profile.spec.policy.network.mode !== 'none' || !profile.sourceCommit) {
    throw new DomainError('JOB_VERIFICATION_CONFIGURATION_CHANGED',
      'Save a verification profile revision with the reviewed offline policy and approved source commit.', 409)
  }
}
