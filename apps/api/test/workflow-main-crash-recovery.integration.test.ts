import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('main workflow turns after abrupt API owner loss', () => {
  it('recovers the original turn and its result after reconnect', async () => {
    await assertActiveTurnRestart({ executionHost: 'main', mode: 'crash', completion: 'after reconnect' })
  }, 240_000)
})
