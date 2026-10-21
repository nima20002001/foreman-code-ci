import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'

describe.skipIf(!postgresEnabled)('current execution regressions', () => {
  it('recovers persisted queued work without replaying predecessor or native turns', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      expect((await f.runs.get(f.f.run.id))?.executionState).toBe('queued')
      const errors: unknown[] = []
      await f.engine.reconcile((error) => errors.push(error))
      await expect.poll(async () => (await f.runs.get(f.f.run.id))?.executionState, { timeout: 45000 }).toBe('waiting')
      const [interaction] = await f.pending()
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 1 })
      expect(errors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
