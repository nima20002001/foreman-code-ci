import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, response } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('BR1-003 production-composed approval/checkpoint recovery: delivery', () => {
  const fixture = productionFixtures()

  it('normal service response uses production registration, actual saver and one native delivery', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction?.graphInterruptId).toBeTruthy()
    expect(f.provider.counts.starts).toBe(2)
    // Native dispatch is outside the resume transaction. An independent writer
    // can take the same parent lock while the provider responds.
    f.provider.beforeRespond = async () => {
      const client = await f.db.pool.connect()
      try {
        await client.query('begin')
        await client.query('select id from runs where id=$1 for no key update nowait', [f.f.run.id])
      } finally { await client.query('rollback'); client.release() }
    }
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
    expect(result.interaction.deliveryState).toBe('delivered')
    expect(await f.receipts()).toHaveLength(1)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    // Repeated late engine delivery notifications cannot submit another response.
    for (let n = 0; n < 3; n++) await f.engine.resumeInteraction(result.interaction)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('repeated service delivery/decision requests do not repeat an already acknowledged native response', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending(), input = response(interaction!)
    const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-before-consume'))
    try {
      for (let n = 0; n < 4; n++) {
        const result = await f.service.respond({ kind: 'user', principal: f.principal }, input)
        expect(result.interaction.deliveryState).toBe('delivered')
        expect(result.replayed).toBe(n > 0)
      }
      expect(f.provider.counts.responses).toBe(1)
      expect(await f.receipts()).toEqual([])
    } finally { crash.mockRestore() }
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts.responses).toBe(1)
  }, 60000)
})
