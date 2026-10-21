import { jobPolicyRequirementsRecord, type JobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import type { JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

export function matchesRuntimePolicy(spec: JobDefinitionSpecRecord, profile: JobRuntimeProfileRecord,
  runtimePolicy = jobRuntimeProfilePolicy(profile)): boolean {
  const policy = jobPolicyRequirementsRecord(runtimePolicy)
  if ('runtimeSelection' in spec && spec.runtimeSelection === 'qualified-profile' && profile.schemaVersion === 2
    && profile.approvalConfig.review && profile.status !== 'revoked') {
    const { imageDigest: requestedImage, ...requested } = spec.policy
    const { imageDigest: profileImage, ...candidate } = policy
    void requestedImage
    void profileImage
    return canonicalJson(requested) === canonicalJson(candidate)
  }
  return canonicalJson(spec.policy) === canonicalJson(policy)
}
