import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { createApprovalRecoverySetup, startWaiting, assertInterrupted } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: cleanup evidence`, () => {
    it('keeps cleanup pending without positive process evidence, then settles the same lifetime when evidence is available', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.killOnRestart = true
      await t.restart()
      const detached = await t.closureRows()
      t.faults.recoveryAvailable = false
      await expect(t.runtime.engine.start(t.runId)).rejects.toBeInstanceOf(AggregateError)
      expect((await t.runtime.runs.get(t.runId))?.executionState).not.toBe('completed')
      expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(true)
      expect(await t.recoveryRows()).toHaveLength(0)
      expect((await t.compare()).state.run.cleanupPending).toBe(true)
      await t.assertNoNativeAcknowledgement(pending.id)
      t.faults.recoveryAvailable = true
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      const closures = await t.closureRows()
      expect(closures.slice(0, detached.length)).toEqual(detached)
      expect(closures).toHaveLength(detached.length + 1)
      expect(closures.at(-1)).toMatchObject({ execution_id: pending.executionId,
        expected_reference: { nativeSessionId: pending.nativeSessionId }, closed_at: null, detached_at: null })
      expect((await t.recoveryRows())[0]?.generation).toBe(String(closures.at(-1)!.generation))
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 0, attaches: 0 })
    }, 90000)
  })
}
