import { describe, it } from 'vitest'
import { nim2644StateCases } from './nim2644State.cases'

describe('NIM-2644 frontend acknowledgement and pending authoring evidence', () => {
  for (const test of nim2644StateCases) it(test.name, test.run)
})
