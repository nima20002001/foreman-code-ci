import { describe, expect, it } from 'vitest'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, stageDelivered, recover, checkpointCut } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('approval checkpoint ownership', () => {
  const fixture = productionFixtures()

  it('independent competing engine owners cannot consume one delivered checkpoint twice', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id); await stageDelivered(f)
    const held = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (!held) throw new Error('Expected independent database ownership')
    try {
      await expect(f.engine.resume(f.f.run.id)).rejects.toMatchObject({ code: 'RUN_ALREADY_OWNED' })
      expect(await f.receipts()).toEqual([])
      expect(f.provider.counts.responses).toBe(1)
      await held.release()
      await recover(f)
    } finally { await held.release() }
    await recover(f)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('an unreceipted pre-existing task value is not laundered into a fresh receipt', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id); await stageDelivered(f)
    const [interaction] = await f.pending(), cut = await checkpointCut(f)
    const interrupted = cut.pendingWrites?.find((write) => write[1] === '__interrupt__')
    if (!interrupted) throw new Error('Expected the persisted task interrupt')
    // Deliberately model an old/incorrect checkpoint writer using the actual
    // saver API. This is invalid historical fixture state, never production code.
    await f.saver.putWrites(cut.config, [['__resume__', [{ interactionId: interaction!.id }]]], interrupted[0])
    const invalid = (await f.saver.getTuple(cut.config))?.pendingWrites
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'GRAPH_RESUME_RECEIPT_MISSING' })
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(invalid)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.responses).toBe(1)
  }, 60000)
})
