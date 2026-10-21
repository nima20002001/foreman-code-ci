import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { expect, it } from 'vitest'
import { sameComputer } from './sameComputer'

it('compares Main and device references using all of their identity fields', () => {
  const main: CanonicalMachineReference = { kind: 'main', mainId: 'main-a' }
  const device: CanonicalMachineReference = { kind: 'device', mainId: 'main-a', deviceId: 'device-a' }
  expect(sameComputer(main, { ...main })).toBe(true)
  expect(sameComputer(device, { ...device })).toBe(true)
  expect(sameComputer(main, device)).toBe(false)
  expect(sameComputer(device, main)).toBe(false)
  expect(sameComputer(main, { ...main, mainId: 'main-b' })).toBe(false)
  expect(sameComputer(device, { ...device, deviceId: 'device-b' })).toBe(false)
  expect(sameComputer(device, { ...device, mainId: 'main-b' })).toBe(false)
})
