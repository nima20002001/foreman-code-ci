import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { checkpointCut, productionFixtures, stageDelivered } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('approval recovery while another callback owns a delivered branch', () => {
  const fixture = productionFixtures()

  it('defers the shared checkpoint and releases sibling claims for immediate recovery', async () => {
    const f = await fixture(2)
    await f.engine.start(f.f.run.id)
    await stageDelivered(f)
    const [interaction] = await f.pending()
    const claim = await f.repository.delivery.claimAtomicGraphResume(interaction!.id, 'pending-review-callback')
    expect(claim).toBeDefined()
    const before = await checkpointCut(f)
    try {
      await expect(f.engine.resume(f.f.run.id)).resolves.toBeUndefined()
      expect(await f.receipts()).toEqual([])
      expect(await checkpointCut(f)).toEqual(before)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
      expect(f.provider.counts.responses).toBe(2)
    } finally {
      await f.repository.delivery.finishGraphResume(claim!, 'callback-interrupted')
    }

    await f.engine.resume(f.f.run.id)
    const consumed = await f.receipts()
    expect(consumed).toHaveLength(2)
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toEqual(consumed)
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 2 })
  }, 60_000)
})
