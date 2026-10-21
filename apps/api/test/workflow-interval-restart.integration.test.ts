import { describe, it } from 'vitest'
import { assertIntervalRestart } from './helpers/workflowIntervalRestart.js'

describe('API restart with graph work and an interval check', () => {
  it('preserves both active main native turns and completes their original executions', async () => {
    await assertIntervalRestart('main')
  }, 300_000)
})
