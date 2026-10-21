import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('main workflow turns after abrupt API owner loss', () => {
  it('recovers the original turn and its result while API is down', async () => {
    await assertActiveTurnRestart({ executionHost: 'main', mode: 'crash', completion: 'while API is down' })
  }, 240_000)
})
