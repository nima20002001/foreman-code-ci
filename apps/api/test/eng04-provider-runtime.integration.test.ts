import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'

describe.skipIf(!postgresEnabled)('Current provider runtime composition', () => {
  it('settles the deterministic checkpoint provider through original native captures', async () => {
    const fixture = await checkpointRuntimeFixture()
    try {
      await fixture.engine.start(fixture.f.run.id)
      const [interaction] = await fixture.pending()
      expect(interaction?.graphInterruptId).toBeTruthy()
      const response = await fixture.service.respond({ kind: 'user', principal: fixture.principal }, approvalResponse(interaction!))
      expect(response.interaction.deliveryState).toBe('delivered')
      expect((await fixture.runs.get(fixture.f.run.id))?.outcome).toBe('succeeded')
      expect(fixture.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    } finally { await fixture.close() }
  }, 60000)

})
