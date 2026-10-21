import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { reduceRepeatGraphPageV3 } from '@foreman-code/contracts/wave25'
import { readRepeatGraphPage, readRepeatGraphSnapshot } from '../src/modules/run-graph/repeatReader.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it('an uncommitted Stop cannot cancel a waiting native session', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      await t.engine.start(t.f.run.id)
      const cancel = vi.spyOn(t.native, 'cancelRun')
      await expect(t.engine.cancel(t.f.run.id)).rejects.toMatchObject({ code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
      expect(cancel).not.toHaveBeenCalled()
      expect((await t.runs.get(t.f.run.id))?.executionState).toBe('waiting')
      const request = { scope: t.f.scope, protocolVersion: 1 }
      const before = await readRepeatGraphSnapshot(t.db.pool, request, async () => undefined)
      await t.stop()
      expect(await t.engine.cancel(t.f.run.id)).toBe(true)
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('canceled')
      expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      const after = await readRepeatGraphSnapshot(t.db.pool, request, async () => undefined)
      const page = await readRepeatGraphPage(t.db.pool, { ...request, afterSequence: before.asOfSequence }, async () => undefined)
      if (page.kind !== 'page') throw new Error('Unexpected Stop graph reset')
      expect(reduceRepeatGraphPageV3(before, page)).toEqual(after)
      expect(after.state.interactions).toEqual([])
    } finally { await t.close() }
  }, 60000)
})
