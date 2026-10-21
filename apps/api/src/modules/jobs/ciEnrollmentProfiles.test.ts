import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { ciEnrollmentProfileInput, ciEnrollmentTemplateDigest } from './ciEnrollmentProfiles.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'

describe('CI enrollment resource envelopes', () => {
  it('preserves the template envelope, policy and suites on another approved root', () => {
    const template = verificationCapacityFixture('device')
    const resources = structuredClone(template.spec.resources)
    const storage = { diskBytes: resources.limits.diskBytes, mutableInodes: resources.mutableInodes }
    const root = structuredClone(template.root)
    root.binding.rootId = randomUUID()
    root.binding.bindingRevision = 4
    const input = ciEnrollmentProfileInput(template, root, storage, 'enroll')
    expect(input.expectedRevision).toBeNull()
    expect(input.spec).toMatchObject({ rootId: root.binding.rootId, bindingRevision: 4,
      policy: template.spec.policy, suites: template.spec.suites,
      resources })
    expect(template.spec.resources).toEqual(resources)
  })

  it('does not increase a template budget on larger storage and preserves revision conflicts', () => {
    const template = verificationCapacityFixture('device')
    const input = ciEnrollmentProfileInput(template, template.root,
      { diskBytes: template.spec.resources.limits.diskBytes * 2, mutableInodes: template.spec.resources.mutableInodes * 2 },
      'enroll', template)
    expect(input).toMatchObject({ id: template.id, expectedRevision: template.revision, spec: template.spec })
  })

  it('reports insufficient storage instead of shrinking required output budgets', () => {
    const template = verificationCapacityFixture('device')
    expect(() => ciEnrollmentProfileInput(template, template.root,
      { diskBytes: 1, mutableInodes: 100 }, 'enroll')).toThrow('too small')
  })

  it.each(['disk', 'inodes'] as const)('rejects insufficient %s even when output reservations fit', field => {
    const template = verificationCapacityFixture('device')
    const resources = template.spec.resources
    const storage = { diskBytes: resources.limits.diskBytes, mutableInodes: resources.mutableInodes }
    if (field === 'disk') storage.diskBytes--
    else storage.mutableInodes--
    expect(() => ciEnrollmentProfileInput(template, template.root, storage, 'enroll'))
      .toThrow('too small')
    expect(template.spec.resources).toEqual(resources)
  })

  it('does not clone again after qualification or an image refresh, but notices policy changes', () => {
    const profile = verificationCapacityFixture('device')
    const digest = ciEnrollmentTemplateDigest(profile)
    const refreshed = structuredClone(profile)
    refreshed.revision++
    refreshed.spec.policy.imageDigest = `sha256:${'9'.repeat(64)}`
    expect(ciEnrollmentTemplateDigest(refreshed)).toBe(digest)
    refreshed.spec.resources.limits.memoryBytes++
    expect(ciEnrollmentTemplateDigest(refreshed)).not.toBe(digest)
  })

  it('reuses enrollment after preparation approves a fresh snapshot of the same commit', () => {
    const template = verificationCapacityFixture('device')
    const prepared = structuredClone(template)
    prepared.root.source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: '9'.repeat(64) }
    prepared.root.binding.bindingRevision++
    prepared.root.binding.snapshotId = prepared.root.source.snapshotId
    prepared.root.binding.manifestDigest = prepared.root.source.manifestDigest
    prepared.revision++
    prepared.spec.policy.imageDigest = `sha256:${'8'.repeat(64)}`
    expect(ciEnrollmentTemplateDigest(prepared)).toBe(ciEnrollmentTemplateDigest(template))
    prepared.sourceCommit = '7'.repeat(40)
    expect(ciEnrollmentTemplateDigest(prepared)).not.toBe(ciEnrollmentTemplateDigest(template))
  })

  it('preserves ordinary job budgets and runtime policy requirements', () => {
    const template = buildComputerFixture(randomUUID(), randomUUID()).candidate.profile
    template.policy.maxOutputBytes = 1024
    template.policy.maxWorkerSpoolBytes = 131072
    const input = ciEnrollmentProfileInput(template, template.root,
      { diskBytes: template.limits.diskBytes * 2, mutableInodes: 100 }, 'enroll')
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = template.policy
    expect(isolationPolicyId).toBe(template.id)
    expect(isolationPolicyRevision).toBe(template.revision)
    expect(input.spec).toEqual({ rootId: template.root.binding.rootId,
      bindingRevision: template.root.binding.bindingRevision, policy,
      limits: template.limits })
  })
})
