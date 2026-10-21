import type { JobRuntimeMeasurementRecord, JobRuntimeProfileRecord, JobRuntimeApprovalRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { jobRuntimeProfileLimits, jobRuntimeQualificationAnchorAt } from '@foreman-code/contracts/job-verification-runtime'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { jobDigest } from './digest.js'

export function runtimeQualificationFacts(measurement: JobRuntimeMeasurementRecord) {
  if (measurement.schemaVersion === 1) return {
    profileId: measurement.profileId, profileRevision: measurement.profileRevision, specDigest: measurement.specDigest,
    qualificationId: measurement.qualificationId, approvalId: measurement.approvalId,
    fingerprintDigest: measurement.fingerprintDigest, root: measurement.root,
    hostRef: measurement.hostRef, registration: measurement.registration,
  }
  return {
    profileId: measurement.identity.profileId, profileRevision: measurement.identity.profileRevision,
    specDigest: measurement.fingerprint.specDigest, qualificationId: measurement.identity.qualificationId,
    approvalId: measurement.identity.approvalId, fingerprintDigest: measurement.identity.fingerprintDigest,
    root: measurement.fingerprint.root, hostRef: measurement.fingerprint.hostRef,
    registration: measurement.fingerprint.registration,
  }
}

export function validateRuntimeQualification(approval: JobRuntimeApprovalRecord, measurement: JobRuntimeMeasurementRecord,
  options: { allowExpired?: boolean } = {}) {
  const facts = runtimeQualificationFacts(measurement)
  if (facts.approvalId !== approval.id || facts.qualificationId !== approval.qualificationId
    || facts.fingerprintDigest !== approval.fingerprintDigest || facts.fingerprintDigest !== jobDigest(measurement.fingerprint)
    || canonicalJson(measurement.fingerprint) !== canonicalJson(approval.fingerprint)
    || facts.profileId !== approval.profileId || facts.profileRevision !== approval.profileRevision
    || canonicalJson(facts.root) !== canonicalJson(approval.fingerprint.root)
    || canonicalJson(facts.hostRef) !== canonicalJson(approval.fingerprint.hostRef)
    || canonicalJson(facts.registration) !== canonicalJson(approval.fingerprint.registration)
    || Date.parse(measurement.expiresAt) > Date.parse(approval.expiresAt)
    || !options.allowExpired && Date.parse(measurement.expiresAt) <= Date.now()) {
    throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT',
      'Measured evidence changed the captured installed context or lifetime.', 409)
  }
  if (measurement.schemaVersion === 2) {
    if (approval.schemaVersion !== 2 || measurement.identity.approvalExpiresAt !== approval.expiresAt
      || measurement.approvedAt !== jobRuntimeQualificationAnchorAt(approval)) {
      throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT', 'Verification changed its original captured candidate.', 409)
    }
    return
  }
  if (approval.schemaVersion !== 1 || measurement.runtime.imageDigest !== approval.fingerprint.imageDigest
    || measurement.runtime.toolchainDigest !== approval.fingerprint.toolchainDigest
    || measurement.runtimeBinarySha256 !== approval.fingerprint.runtimeBinarySha256
    || measurement.ociBinarySha256 !== approval.fingerprint.ociBinarySha256
    || measurement.runtimeExecutable !== approval.fingerprint.runtimeExecutable
    || Object.entries(approval.fingerprint.limits).some(([key, limit]) =>
      Reflect.get(measurement.runtime, key) !== limit)) {
    throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT', 'Measured runtime differs from its approved profile.', 409)
  }
}

export function qualificationTimeoutMs(profile: JobRuntimeProfileRecord, approval: JobRuntimeApprovalRecord): number {
  if (profile.schemaVersion === 1) return 240_000
  const policy = profile.spec.policy
  const timeout = (profile.spec.suites.length + 2) * (policy.preparationTimeoutMs + policy.serviceStartupTimeoutMs
    + policy.executionTimeoutMs + policy.cancellationGraceMs + policy.publicationTimeoutMs + policy.cleanupTimeoutMs)
  if (!Number.isSafeInteger(timeout)
    || Date.parse(approval.expiresAt) - Date.now() < timeout
    || canonicalJson(jobRuntimeProfileLimits(profile)) !== canonicalJson(approval.fingerprint.limits)) {
    throw new DomainError('JOB_VERIFICATION_APPROVAL_TOO_SHORT',
      'The remaining reviewed approval does not cover every suite and its cleanup.', 409)
  }
  return timeout
}

export function qualificationDeadline(timeoutMs: number) {
  const controller = new AbortController()
  const deadlineAt = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) controller.abort(new Error('Qualification deadline exceeded.'))
    else {
      timer = setTimeout(check, Math.min(remaining, 2_147_423_647))
      timer.unref()
    }
  }
  check()
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}
