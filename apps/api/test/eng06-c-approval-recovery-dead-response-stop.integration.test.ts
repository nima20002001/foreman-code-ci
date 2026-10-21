import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: dead response stop`, () => {
    it('settles Stop with missing response proof and a dead session, without manufacturing an ACK', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.hideResponseEvidence = true
      const sent = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(sent.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.compare()
      t.faults.killOnRestart = true
      await t.restart()
      expect(t.faults.deadSessions.has(pending.nativeSessionId)).toBe(true)
      expect(await t.stop()).toBe(true)
      await t.settled('canceled'); await t.assertShape(1)
      expect((await t.runtime.repository.get(pending.id))?.deliveryState).not.toBe('delivered')
      await t.assertNoNativeAcknowledgement(pending.id)
      expect(await t.f.receipts()).toHaveLength(0)
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      expect(t.faults.responseWrites).toHaveLength(1)
    }, 90000)
  })
}
