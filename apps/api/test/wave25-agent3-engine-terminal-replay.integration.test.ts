import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it('terminal Start replay leaves accepted results and provider calls unchanged', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      await t.engine.start(t.f.run.id)
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse((await t.pending())[0]!))
      await expect.poll(() => t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      const accepted = () => t.db.pool.query("select entity_id,effect_digest,first_sequence::text from run_graph_effects where run_id=$1 and effect_kind='result.accept' order by entity_id", [t.f.run.id]).then((result) => result.rows)
      const receipts = await accepted(), counts = { ...t.provider.counts }
      await t.engine.start(t.f.run.id)
      expect(t.provider.counts).toEqual(counts)
      expect(await accepted()).toEqual(receipts)
      await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
    } finally { await t.close() }
  }, 60000)
})
