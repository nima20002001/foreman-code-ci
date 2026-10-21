import { describe, it } from 'vitest'
import { coreCases } from './core.cases'

describe('Agent 6 managed authoring regressions (synthetic transport)', () => {
  for (const test of coreCases) it(test.name, test.run)
})
