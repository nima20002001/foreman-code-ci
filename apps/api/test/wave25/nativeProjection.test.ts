import { describe, it } from 'vitest'
import { nativeProjectionCases } from './nativeProjection.cases.js'
describe('Wave 2.5 incremental native projection and S1 parity oracle', () => {
  for (const fixture of nativeProjectionCases) it(fixture.name, fixture.run)
})
