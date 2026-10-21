import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, recoveryFixture, assertRecoveryReceipts } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: missing physical closure evidence keeps the lost attempt open until an exact receipt allows its retry', async (form) => {
    let first = true
    const f = await recoveryFixture(form, () => { if (first) { first = false; return 'park' } return 'success' })
    try {
      f.launch(); const before = await parked(f), id = before.details[0]!.execution.executionId
      // A dead API runs no shutdown step: neither its restart intent nor its close callback.
      vi.spyOn(f.runtime.native, 'preserveActiveForRestart').mockResolvedValue(true)
      await f.restart({ mode: 'crash' })
      f.provider.recoveryProofAvailable = false
      await expect(f.runtime.engine.start(f.base.f.run.id)).rejects.toThrow()
      // Without closure evidence the lost attempt stays open; nothing is retried or fenced yet.
      const pending = await readback(f)
      expect(pending.record).toMatchObject({ run: { executionState: 'running', outcome: 'pending' }, cleanupPending: false })
      expect(pending.record.run).not.toHaveProperty('result')
      expect(pending.details).toHaveLength(1)
      expect(pending.details[0]!.execution.state).toBe('running')
      expect(pending.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect((await f.base.db.pool.query('select generation from execution_native_recoveries where execution_id=$1', [id])).rows).toEqual([])
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
      f.provider.recoveryProofAvailable = true
      await f.settled()
      const settled = await readback(f)
      expect(settled.record).toMatchObject({ run: { executionState: 'completed', outcome: 'succeeded' }, cleanupPending: false })
      expect(settled.details.find((detail) => detail.execution.executionId === id)!.reportedResult)
        .toMatchObject({ outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
      await assertRecoveryReceipts(f, [id], { detached: false })
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
