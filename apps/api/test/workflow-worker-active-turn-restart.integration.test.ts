import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('planned API restart during a Worker native workflow turn', () => {
  for (const completion of ['after reconnect', 'while API is down'] as const) {
    it(`keeps the same worker execution and collects its result ${completion}`, async () => {
      await assertActiveTurnRestart({ executionHost: 'worker', mode: 'graceful', completion })
    }, 240_000)
  }
})
