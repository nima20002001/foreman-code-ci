import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, stageDelivered, checkpointCut, expireAbandonedClaims, recover } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('approval checkpoint branches', () => {
  const fixture = productionFixtures()

  it('two actual persisted parallel delivered branches commit two task values and two receipts together', async () => {
    const f = await fixture(2)
    await f.engine.start(f.f.run.id)
    const interactions = await f.pending()
    expect(interactions).toHaveLength(2)
    expect(new Set(interactions.map((item) => item.executionId)).size).toBe(2)
    expect(new Set(interactions.map((item) => item.graphInterruptId)).size).toBe(2)
    await stageDelivered(f)
    const cut = await checkpointCut(f)
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    let writes = 0
    const failure = vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      await consume(sql, interaction)
      if (++writes === 2) throw new Error('rollback-second-branch')
    })
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(writes).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'rollback-second-branch' })
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
    expect(await f.receipts()).toEqual([]) // Includes the FIRST branch's receipt.
    expect(f.provider.counts.responses).toBe(2)
    failure.mockRestore()
    await expireAbandonedClaims(f)
    await recover(f)
    const stored = (await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__') ?? []
    expect(stored).toHaveLength(2)
    expect(new Set(stored.map((write) => write[0])).size).toBe(2) // Actual task IDs, not a plan-only array test.
    expect(await f.receipts()).toHaveLength(2)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 2 })
  }, 60000)

  it('two delivered sibling requests in one persisted task share one value but have separate receipts', async () => {
    const f = await fixture(1, 2)
    await f.engine.start(f.f.run.id)
    const interactions = await f.pending()
    expect(interactions).toHaveLength(2)
    expect(new Set(interactions.map((item) => item.executionId)).size).toBe(1)
    expect(new Set(interactions.map((item) => item.graphInterruptId)).size).toBe(1)
    const cut = await checkpointCut(f)
    await stageDelivered(f)
    await recover(f)
    const stored = (await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__') ?? []
    expect(stored).toHaveLength(1)
    expect(stored[0]![2]).toEqual([{ interactionId: interactions[0]!.id }])
    expect(await f.receipts()).toHaveLength(2)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 2 })
  }, 60000)
})
