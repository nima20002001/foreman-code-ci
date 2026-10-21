import { expect, it } from 'vitest'
import { qualificationUnitWorkers } from './jobVerificationPolicy.js'

it('runs qualification unit tests on at most the profile\'s whole CPUs and the owner maximum', () => {
  expect(qualificationUnitWorkers({ cpuLimit: 2 })).toBe(2)
  expect(qualificationUnitWorkers({ cpuLimit: 4.25 })).toBe(4)
  expect(qualificationUnitWorkers({ cpuLimit: 0.5 })).toBe(1)
  expect(qualificationUnitWorkers({ cpuLimit: 32 })).toBe(12)
})
