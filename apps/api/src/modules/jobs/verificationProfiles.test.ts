import { describe, expect, it } from 'vitest'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JobVerificationProfileInputSchema } from '@foreman-code/contracts/job-verification-runtime'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { createVerificationProfile, requireReviewedVerificationConfiguration } from './verificationProfiles.js'

function input() {
  const facts = verificationFixture()
  const root = buildComputerFixture('11111111-1111-4111-8111-111111111111', 'workspace').candidate.profile.root
  return { id: 'profile', workspaceId: 'workspace', revision: 1, name: 'Ordinary verification', root,
    sourceCommit: facts.build.source.commit, previous: null, now: '2026-10-05T12:00:00.000Z',
    spec: JobVerificationProfileInputSchema.parse({ rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
      resources: facts.resources, policy: jobPolicyRequirementsRecord(facts.spec.policy),
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } }) }
}

describe('reviewed verification profile settings', () => {
  it('stores the offline owner configuration and trusted commit without claiming qualification', () => {
    const request = input()
    const profile = createVerificationProfile(request)
    expect(profile.sourceCommit).toBe(request.sourceCommit)
    expect(profile.approvalConfig).toMatchObject({ approvalLifetimeMs: 86_400_000,
      review: { authority: 'repository-owner', decisionId: 'offline-verification', reviewedOn: '2026-10-05' } })
    expect(profile.status).toBe('unqualified')
    expect(profile.measurement).toBeNull()
    expect(() => requireReviewedVerificationConfiguration(profile)).not.toThrow()
  })

  it('requires a new saved identity for another commit and clears pending qualification state', () => {
    const request = input()
    const first = createVerificationProfile(request)
    const second = createVerificationProfile({ ...request, revision: 2, sourceCommit: 'c'.repeat(40),
      previous: { ...first, status: 'awaiting-approval' } })
    expect(second.specDigest).not.toBe(first.specDigest)
    expect(second.sourceCommit).toBe('c'.repeat(40))
    expect(first.sourceCommit).toBe(request.sourceCommit)
    expect(second.status).toBe('unqualified')
    expect(second.measurement).toBeNull()
  })

  it('rejects settings that differ from the reviewed approval lifetime and offline network policy', () => {
    const request = input()
    expect(() => createVerificationProfile({ ...request,
      spec: { ...request.spec, approvalConfig: { approvalLifetimeMs: 3_600_000 } } })).toThrow('24 hours')
    expect(() => createVerificationProfile({ ...request, spec: { ...request.spec,
      policy: { ...request.spec.policy, network: { schemaVersion: 2, mode: 'registry-only',
        enforcement: { implementation: 'fixture', version: '1', destinationPolicyDigest: 'a'.repeat(64) } } } } }))
      .toThrow('no network')
  })
})
