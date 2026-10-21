import { expect, it } from 'vitest'
import { BuildComputerPreferenceSchema, BuildComputerUpdateSchema, BuildComputerBatchUpdateSchema } from './buildComputers.js'
import { deviceProvisioningTargetFixture } from './deviceProvisioningFixtures.js'

it('validates participation revisions and bounded priority without changing device authority', () => {
  const preference = { target: deviceProvisioningTargetFixture, revision: 0, buildEnabled: false, buildPriority: 50,
    buildAllowancePercent: 40 }
  expect(BuildComputerPreferenceSchema.parse(preference)).toEqual(preference)
  // Preferences saved before allowances existed read with the computer's whole allowance.
  const saved: Partial<typeof preference> = { ...preference }
  delete saved.buildAllowancePercent
  expect(BuildComputerPreferenceSchema.parse(saved)).toEqual({ ...saved, buildAllowancePercent: 100 })
  // Builds use one priority order; the retired Primary/Backup role is not accepted.
  expect(BuildComputerPreferenceSchema.safeParse({ ...preference, buildRole: 'backup' }).success).toBe(false)
  const input = { ...preference, commandId: 'build-command', expectedRevision: 0 }
  delete (input as Partial<typeof input>).revision
  expect(BuildComputerUpdateSchema.safeParse(input).success).toBe(true)
  for (const buildPriority of [-1, 101, 1.5]) {
    expect(BuildComputerUpdateSchema.safeParse({ ...input, buildPriority }).success).toBe(false)
  }
  expect(BuildComputerUpdateSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false)
})
it('validates one batch command with unique computers on the same Main and revisioned changes', () => {
  const change = { target: deviceProvisioningTargetFixture, expectedRevision: 2,
    buildEnabled: true, buildPriority: 100, buildAllowancePercent: 60 }
  const command = { commandId: 'save-order', updates: [change] }
  expect(BuildComputerBatchUpdateSchema.parse(command)).toEqual(command)
  expect(BuildComputerBatchUpdateSchema.safeParse({ ...command, updates: [] }).success).toBe(false)
  expect(BuildComputerBatchUpdateSchema.safeParse({ ...command, updates: [change, change] }).success).toBe(false)
  const foreign = { ...change, target: { ...change.target,
    hostRef: { ...change.target.hostRef, mainId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } }
  expect(BuildComputerBatchUpdateSchema.safeParse({ ...command, updates: [change, foreign] }).success).toBe(false)
  expect(BuildComputerBatchUpdateSchema.safeParse({ ...command,
    updates: [{ ...change, expectedRevision: -1 }] }).success).toBe(false)
})
