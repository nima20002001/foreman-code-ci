import { describe, it } from 'vitest'
import { assertIntervalRestart } from './helpers/workflowIntervalRestart.js'

describe('API restart with graph work and an interval check', () => {
  it('preserves both active worker native turns and completes their original executions', async () => {
    await assertIntervalRestart('worker')
  }, 300_000)
})
