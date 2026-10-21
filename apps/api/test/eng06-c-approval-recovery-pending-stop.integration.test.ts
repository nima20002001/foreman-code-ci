import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: pending stop`, () => {
    it('settles Stop while approval is pending and fences late response/replayed resume notifications', async () => {
      const t = await setup(form), pending = await startWaiting(t), counts = { ...t.f.provider.counts }
      expect(await t.stop()).toBe(true)
      await t.settled('canceled'); await t.assertShape(1)
      expect((await t.runtime.repository.get(pending.id))?.status).toBe('canceled')
      expect(await t.f.receipts()).toHaveLength(0)
      await expect(t.runtime.service.respond(t.responder, approvalResponse(pending)))
        .rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
      await t.runtime.engine.resumeInteraction(pending)
      expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
      await t.settled('canceled'); await t.assertNoNativeAcknowledgement(pending.id)
      expect(await t.f.receipts()).toHaveLength(0)
      expect(t.f.provider.counts.starts).toBe(counts.starts)
      expect(t.f.provider.counts.responses).toBe(0)
    }, 90000)
  })
}
