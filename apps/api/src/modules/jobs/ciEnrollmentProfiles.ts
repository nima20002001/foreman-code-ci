import type { CiInstalledStorage } from '@foreman-code/contracts'
import { JobRuntimeProfileSaveRecordSchema, jobRuntimeProfilePolicy, jobRuntimeProfileLimits,
  type JobRuntimeProfileRecord, type JobRuntimeProfileSaveRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { DomainError } from '../errors.js'
import { jobDigest } from './digest.js'

export function ciEnrollmentTemplateDigest(profile: JobRuntimeProfileRecord): string {
  const policy = jobPolicyRequirementsRecord(jobRuntimeProfilePolicy(profile))
  // Preparation creates fresh snapshot IDs even when the pinned Git commit is unchanged.
  const sourceCommit = profile.schemaVersion === 2 ? profile.sourceCommit : null
  return jobDigest({ name: profile.name, policy: { ...policy, imageDigest: null },
    limits: jobRuntimeProfileLimits(profile),
    source: sourceCommit ? null : profile.root.source, sourceCommit,
    verification: profile.schemaVersion === 2 ? {
      resources: profile.spec.resources, suites: profile.spec.suites, approvalConfig: profile.spec.approvalConfig,
    } : null })
}

export function requireCiEnrollmentStorage(template: JobRuntimeProfileRecord, storage: CiInstalledStorage): void {
  const diskBytes = jobRuntimeProfileLimits(template).diskBytes
  const needsMoreInodes = template.schemaVersion === 2
    && template.spec.resources.mutableInodes > storage.mutableInodes
  if (diskBytes > storage.diskBytes || needsMoreInodes) {
    throw new DomainError('CI_ENROLLMENT_STORAGE_REQUIRED',
      'The installed CI volume is too small for this template’s disk or inode budget.', 409)
  }
}

export function ciEnrollmentProfileInput(template: JobRuntimeProfileRecord, root: SourceRootRecord,
  storage: CiInstalledStorage, commandId: string, previous?: JobRuntimeProfileRecord): JobRuntimeProfileSaveRecord {
  requireCiEnrollmentStorage(template, storage)
  let spec: JobRuntimeProfileSaveRecord['spec']
  if (template.schemaVersion === 2) {
    spec = { ...template.spec, rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
  } else {
    spec = { limits: template.limits, policy: jobPolicyRequirementsRecord(template.policy),
      rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
  }
  return JobRuntimeProfileSaveRecordSchema.parse({ commandId, name: template.name, spec,
    expectedRevision: previous?.revision ?? null, ...(previous ? { id: previous.id } : {}) })
}
