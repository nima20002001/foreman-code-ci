import { describe, expect, it } from 'vitest'
import { AutoVerificationJobSpecSchema, ResolvedVerificationJobSpecSchema, jobVerificationTemplate }
  from '@foreman-code/contracts/job-verification'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { preparationProfile, qualifiedPreparationProfile, builder, laptop, oldImage, newImage }
  from '../../../test/helpers/ciPreparationFixture.js'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import { compatibleJobComputer, orderForPlacement } from './computerSelection.js'
import { buildComputerTarget } from '../settings/buildComputers.js'
import { matchesRuntimePolicy } from './runtimeSelection.js'

function candidate(imageDigest: string, deviceId = builder) {
  let profile = preparationProfile('runtime', 'Runtime', deviceId, '44444444-4444-4444-8444-444444444444', ['unit'])
  profile.spec.policy.imageDigest = imageDigest
  profile = qualifiedPreparationProfile(profile)
  const template = jobVerificationTemplate({ profileId: profile.id, profileRevision: profile.revision,
    hostRef: profile.root.selection.hostRef, suite: 'unit', ready: true, policy: profile.spec.policy,
    resources: profile.spec.resources, maxUnitWorkers: 1 })
  const fixed = verificationFixture().spec
  const spec = ResolvedVerificationJobSpecSchema.parse({ ...fixed, argv: template.argv, outputs: template.outputs,
    target: { ...fixed.target, hostRef: profile.root.selection.hostRef, registration: profile.root.registration },
    policy: jobRuntimeProfilePolicy(profile), verification: { ...fixed.verification, resources: profile.spec.resources } })
  const preference = { target: buildComputerTarget(spec.target), revision: 1, buildEnabled: true, buildPriority: 100,
    buildAllowancePercent: 100 }
  return { profile, spec, preference, ready: true, reasons: [], template,
    sourceReservation: { scopeId: 'fixture', reservedBytes: 1024 } }
}

describe('Jobs resolve the runtime image at admission', () => {
  it('keeps the saved ticket requirements while accepting a newly qualified image', () => {
    const before = candidate(oldImage)
    const after = candidate(newImage)
    const request = AutoVerificationJobSpecSchema.parse({ ...before.spec, target: { kind: 'auto' },
      policy: before.profile.spec.policy, limits: before.profile.spec.resources.limits, runtimeSelection: 'qualified-profile' })
    expect(compatibleJobComputer(after, request)).toBe(true)
    expect(request.policy.imageDigest).toBe(oldImage)
    expect(after.spec.policy.imageDigest).toBe(newImage)
    expect(compatibleJobComputer(after, AutoVerificationJobSpecSchema.parse({ ...request, runtimeSelection: undefined }))).toBe(false)
    expect(matchesRuntimePolicy({ ...request, policy: { ...request.policy, network: { schemaVersion: 2, mode: 'public-egress',
      enforcement: { implementation: 'fixture', version: '1', destinationPolicyDigest: 'a'.repeat(64) } } } }, after.profile)).toBe(false)
  })

  it('considers the Agent’s preferred computer with a different image and keeps the other computer for spillover', async () => {
    const ci = ciFixture()
    const primary = candidate(oldImage, laptop)
    const local = candidate(newImage)
    const request = AutoVerificationJobSpecSchema.parse({ ...local.spec, target: { kind: 'auto' },
      policy: local.profile.spec.policy, limits: local.profile.spec.resources.limits,
      runtimeSelection: 'qualified-profile' })
    const definition = await ci.jobs.saveDefinition(ci.operator, 'mcp', ci.workspaceId, {
      commandId: 'save-preferred-computer', expectedRevision: null,
      name: 'Preferred computer', spec: request,
    })
    local.spec.source = definition.spec.source
    primary.spec.source = definition.spec.source
    expect(definition.spec.policy.imageDigest).toBe(newImage)
    expect(compatibleJobComputer(local, definition.spec)).toBe(true)
    expect(compatibleJobComputer(primary, definition.spec)).toBe(true)
    expect(orderForPlacement([primary, local], { kind: 'prefer', hostRef: local.spec.target.hostRef })
      .map(value => value.spec.target.hostRef)).toEqual([local.spec.target.hostRef, primary.spec.target.hostRef])
  })
})
