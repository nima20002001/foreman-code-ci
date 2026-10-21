import { expect, it, vi } from 'vitest'
import type { JobSql } from './repository.js'
import { AutoVerificationJobSpecSchema, jobVerificationTemplate } from '@foreman-code/contracts/job-verification'
import { CanonicalJobPreparationSources } from './sourcePreparation.js'
import { preparationProfile, qualifiedPreparationProfile, builder, laptop, oldImage, newImage, mainId }
  from '../../../test/helpers/ciPreparationFixture.js'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

it.each([true, false])('uses the currently ready policy inventory for verification templates (available: %s)', async available => {
  const profile = verificationCapacityFixture('device')
  const saved = structuredClone(profile)
  const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['sources:read', 'source_roots:read'], scope: {} }] }
  const sql = { query: async (text: string) => {
    if (text.includes('select id,name,audience,grants')) return { rows: [{ ...principal,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
    if (text.includes('with recursive owners')) return { rows: [{ id: principal.id }] }
    if (text.includes('select record from job_runtime_profiles')) return { rows: [{ record: profile }] }
    return { rows: [] }
  } } as unknown as JobSql
  const policy = jobRuntimeProfilePolicy(profile)
  const runtime = { choices: vi.fn(async () => available ? [policy] : []), revalidate: vi.fn() }
  const sources = new CanonicalJobPreparationSources({} as never, runtime,
    {} as never, {} as never, {} as never)
  const choices = await sources.choices(sql, principal, profile.workspaceId)
  expect(choices.policies).toEqual(available ? [policy] : [])
  expect(choices.verificationTemplates).toHaveLength(1)
  expect(choices.verificationTemplates![0]).toMatchObject({
    hostRef: profile.root.selection.hostRef, ready: available,
  })
  expect(runtime.revalidate).not.toHaveBeenCalled()
  expect(profile).toEqual(saved)
})

it('discovers both computers when CI resolves their reviewed images at admission', async () => {
  const caller = ciFixture().operator
  const profiles = [builder, laptop].map((deviceId, index) => {
    const profile = preparationProfile(`profile-${index}`, 'Verification', deviceId,
      `${index + 4}4444444-4444-4444-8444-444444444444`, ['unit'])
    profile.spec.policy.imageDigest = index === 0 ? oldImage : newImage
    profile.root.binding.canonicalPath = '/ci/source-materializations/root-policy'
    return qualifiedPreparationProfile(profile)
  })
  const template = jobVerificationTemplate({ profileId: profiles[0]!.id, profileRevision: 3,
    suite: 'unit', ready: true, policy: profiles[0]!.spec.policy, resources: profiles[0]!.spec.resources, maxUnitWorkers: 1 })
  const request = AutoVerificationJobSpecSchema.parse({ source: { ...profiles[0]!.root.source, commit: 'c'.repeat(40) },
    target: { kind: 'auto' }, runtimeSelection: 'qualified-profile', limits: profiles[0]!.spec.resources.limits,
    policy: template.policy, argv: template.argv, outputs: template.outputs, inputs: [],
    verification: { suite: 'unit', parameters: template.parameters, resources: template.resources, credentialRefs: [] } })
  const sql = { query: async (text: string) => {
    if (text.includes('from source_root_bindings')) return { rows: profiles.map(profile => ({ record: profile.root })) }
    if (text.includes('from job_runtime_profiles')) return { rows: profiles.map(record => ({ record })) }
    if (text.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (text.includes('with recursive owners')) return { rows: [{ id: caller.id }] }
    if (text.includes('from management_principals')) return { rows: [{ id: caller.id, name: caller.name,
      audience: 'operator', grants: caller.grants, expires_at: new Date(caller.expiresAt), revoked_at: null, delegated_from: null }] }
    throw new Error('Unexpected source inventory query')
  } } as unknown as JobSql
  const revalidate = vi.fn(async () => {})
  const roots = { resolve: async (_sql: unknown, _principal: unknown, input: { hostRef: { deviceId: string } }) => ({
    ...input, managedRuntimeRoot: '/ci', registration: profiles.find(profile => profile.root.binding.deviceId === input.hostRef.deviceId)!.root.registration,
  }) }
  const inventory = new CanonicalJobPreparationSources({
    resolveApprovedSource: async () => ({ manifest: {
      git: { commit: request.source.commit, metadata: { byteSize: 4 * 1024 * 1024, sha256: 'a'.repeat(64) } },
      totalBytes: 1, totalEntries: 1, entries: [{ path: 'source.ts' }],
    } }),
    resolveRootBinding: async () => profiles[0]!.root,
  } as never, { choices: async () => [], revalidate }, { prepare: async () => {} },
  { validateDeclaredJobInputs: async () => {} }, roots as never)
  const candidates = (await inventory.candidates(sql, caller, 'workspace-fixture', request)).candidates
  expect(candidates.map(candidate => [candidate.spec.target.hostRef, candidate.spec.policy.imageDigest]))
    .toEqual(profiles.map(profile => [profile.root.selection.hostRef, profile.spec.policy.imageDigest]))
  expect(candidates.every(candidate => candidate.sourceReservation.reservedBytes > 4 * 1024 * 1024)).toBe(true)
  expect(revalidate).toHaveBeenCalledTimes(2)
  expect((await inventory.candidates(sql, caller, 'workspace-fixture',
    AutoVerificationJobSpecSchema.parse({ ...request, runtimeSelection: undefined }))).candidates).toHaveLength(1)
})
