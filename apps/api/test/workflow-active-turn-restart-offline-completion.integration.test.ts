import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('planned API restart during a native workflow turn', () => {
  it('keeps the same main execution and collects its result while API is down', async () => {
    await assertActiveTurnRestart({ executionHost: 'main', mode: 'graceful', completion: 'while API is down' })
  }, 240_000)
})
