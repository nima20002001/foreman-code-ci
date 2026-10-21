import { describe, expect, it } from 'vitest'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'

describe('installed Worker startup', () => {
  it('starts the installed Worker and reads its harness inventory through MCP', async () => {
    const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
      parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false })
    try {
      const inventory = await f.inventory()
      expect(inventory.installations.some(installation => installation.driverId === 'codex')).toBe(true)
    } finally { await f.close() }
  }, 240_000)

})
