import { describe, expect, it, vi } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Current workflow result and checkpoint durability', () => {
  it('a committed result survives a lost acceptance acknowledgement without another native launch', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      const factory = t.runs.repeatRepositoryFactory(), original = factory.forOwner.bind(factory)
      let lose = true
      const hook = vi.spyOn(factory, 'forOwner').mockImplementation((...args) => {
        const store = original(...args), accept = store.acceptTerminal.bind(store)
        if (!vi.isMockFunction(store.acceptTerminal)) vi.spyOn(store, 'acceptTerminal').mockImplementation(async (...input) => {
          const result = await accept(...input)
          if (lose) { lose = false; throw new Error('ENG03_LOST_RESULT_ACK') }
          return result
        })
        return store
      })
      await expect(t.engine.start(t.f.run.id)).rejects.toThrow('ENG03_LOST_RESULT_ACK')
      expect((await t.db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [t.f.run.id])).rowCount).toBe(1)
      hook.mockRestore()
      await t.engine.resume(t.f.run.id)
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse((await t.pending())[0]!))
      expect(t.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      expect((await t.db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [t.f.run.id])).rowCount).toBe(2)
    } finally { vi.restoreAllMocks(); await t.close() }
  }, 60000)
})
