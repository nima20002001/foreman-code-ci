import { expect, it } from 'vitest'
import { CiRunInputSchema, OperatorCiRunInputSchema, BuildComputerPrepareInputSchema } from './ci.js'
import { CiEnrollmentUpdateSchema } from './ciEnrollment.js'
import { BuildComputerUpdateSchema, BuildComputerBatchUpdateSchema } from './buildComputers.js'
import { deviceProvisioningTargetFixture } from './deviceProvisioningFixtures.js'

it('accepts CI and build computer requests without caller command IDs', () => {
  const change = { target: deviceProvisioningTargetFixture, expectedRevision: 0,
    buildEnabled: true, buildPriority: 50 }
  const requests = [
    [CiRunInputSchema, { suite: 'install' }],
    [OperatorCiRunInputSchema, { workspaceId: 'workspace', suite: 'install' }],
    [BuildComputerPrepareInputSchema, { workspaceId: 'workspace', profileId: 'profile' }],
    [CiEnrollmentUpdateSchema, { workspaceId: 'workspace', target: deviceProvisioningTargetFixture,
      expectedRevision: 0, enabled: true }],
    [BuildComputerUpdateSchema, change],
    [BuildComputerBatchUpdateSchema, { updates: [change] }],
  ] as const
  for (const [schema, input] of requests) {
    expect(schema.parse(input)).toEqual(input)
    expect(schema.safeParse({ ...input, commandId: '' }).success).toBe(false)
    expect(schema.parse({ ...input, commandId: 'caller-command' })).toEqual({ ...input, commandId: 'caller-command' })
  }
})
