import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('planned API restart during a native workflow turn', () => {
  for (const executionHost of ['main'] as const) {
    for (const completion of ['after reconnect'] as const) {
      it(`keeps the same ${executionHost} execution and collects its result ${completion}`, async () => {
        await assertActiveTurnRestart({ executionHost, mode: 'graceful', completion })
      }, 240_000)
    }
  }
})
