import { expect, it, vi } from 'vitest'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { JobRuntimeProfiles, verificationProfileReadiness } from './runtimeProfiles.js'
import { InstalledVerificationRuntimeCaptureInputSchema } from './installedVerificationConfiguration.js'

function historicalProfile() {
  const original = verificationRuntimeFixture()
  const measurement = structuredClone(original.measurement)
  measurement.fingerprint.tools.push({ kind: 'opencode', executable: '/saved/opencode',
    version: '1.18.31', binarySha256: 'a'.repeat(64) })
  const fingerprint = measurement.fingerprint
  return JobVerificationProfileSchema.parse({
    schemaVersion: 2, id: fingerprint.profileId, revision: fingerprint.profileRevision,
    workspaceId: fingerprint.root.binding.workspaceId, name: 'Saved qualification',
    root: fingerprint.root, sourceCommit: fingerprint.sourceCommit, specDigest: fingerprint.specDigest,
    approvalConfig: fingerprint.approvalConfig, status: 'qualified', measurement,
    createdAt: measurement.approvedAt, updatedAt: measurement.checkedAt,
    spec: { rootId: fingerprint.root.binding.rootId, bindingRevision: fingerprint.root.binding.bindingRevision,
      resources: fingerprint.resources, policy: jobPolicyRequirementsRecord(original.spec.policy),
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: fingerprint.approvalConfig.approvalLifetimeMs } },
  })
}

it('reads a retained qualification as unavailable without invoking a runtime producer', async () => {
  const profile = historicalProfile()
  const saved = structuredClone(profile)
  const revalidate = vi.fn()
  const service = new JobRuntimeProfiles({} as never, {} as never, {} as never,
    { capture: vi.fn(), run: vi.fn(), revalidate })
  expect(await service.readiness({} as never, profile)).toEqual({ ready: false, reasons: ['HARNESS_RETIRED'] })
  expect(verificationProfileReadiness({ profile, currentFingerprint: null }))
    .toEqual({ ready: false, reasons: ['HARNESS_RETIRED'], sideEffects: false })
  expect(revalidate).not.toHaveBeenCalled()
  expect(profile).toEqual(saved)
})

it('exposes only supported tools for a new protected capture', () => {
  const kind = InstalledVerificationRuntimeCaptureInputSchema.shape.toolSources.element.shape.kind
  expect(kind.parse('claude')).toBe('claude')
  expect(kind.safeParse('opencode').success).toBe(false)
})
