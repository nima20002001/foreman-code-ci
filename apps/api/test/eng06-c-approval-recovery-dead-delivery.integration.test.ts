import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { createApprovalRecoverySetup, loseGraphAcknowledgement, assertInterrupted } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: dead delivery`, () => {
    it('does not strand proven delivery when the native process dies before graph acknowledgement', async () => {
      const t = await setup(form), { pending } = await loseGraphAcknowledgement(t)
      t.faults.killOnRestart = true
      await t.restart()
      expect(t.faults.deadSessions.has(pending.nativeSessionId)).toBe(true)
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
    }, 90000)
  })
}
