import { expect, it } from 'vitest'
import { HarnessProfileSelectionSchema } from './harnessRegistry.js'
it('keeps exact canonical instance and installation identity, refusing guessed ids', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const target = { hostRef: { kind: 'main', mainId: id }, applicationInstallationId: id,
    harnessInstallationId: 'provider-install', installationFingerprint: 'fingerprint' }
  const selection = { instanceId: id, instanceRevision: '17', target }
  expect(HarnessProfileSelectionSchema.parse(selection)).toEqual(selection)
  expect(HarnessProfileSelectionSchema.safeParse({ ...selection, instanceId: 'configuration.id' }).success).toBe(false)
  expect(HarnessProfileSelectionSchema.safeParse({ ...selection, target: { ...target, installationFingerprint: null } }).success).toBe(false)
})
