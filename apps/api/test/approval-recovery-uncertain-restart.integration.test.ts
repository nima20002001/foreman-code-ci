import { describe, expect, it } from 'vitest'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import {
  createApprovalRecoverySetup,
  startWaiting,
  assertPredecessorsUnchanged,
} from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: uncertain restart`, () => {
    it('restores an uncertain answer after restart and waits for native evidence without resending', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      const counts = { ...t.f.provider.counts }
      t.faults.hideResponseEvidence = true
      const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(response.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.compare(); await t.restart()
      const detached = await t.closureRows()
      // Delivery reconciliation alone cannot cold-attach the requester.
      const observed = await t.runtime.service.reconcile(response.interaction)
      expect(observed).toMatchObject({ id: pending.id, deliveryState: 'uncertain' })
      expect(t.f.provider.counts.attaches).toBe(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      await t.runtime.engine.start(t.runId)
      await t.runtime.service.reconcile(response.interaction)
      await t.runtime.engine.start(t.runId)
      expect(await t.runtime.runs.get(t.runId)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(await t.runtime.repository.get(pending.id)).toMatchObject({ deliveryState: 'uncertain' })
      expect(t.f.provider.counts).toEqual({ ...counts, responses: 1, attaches: counts.attaches + 1 })
      expect(await t.closureRows()).toEqual([...detached, expect.objectContaining({
        execution_id: pending.executionId,
        execution_identity: expect.objectContaining({ id: pending.executionId, runId: t.runId }),
        expected_reference: { harness: pending.harness, providerVersion: pending.providerVersion,
          nativeSessionId: pending.nativeSessionId },
        closed_at: null, closed_reference: null, closed_without_session: false,
        detached_at: null, detached_reference: null,
      })])
      expect(await t.recoveryRows()).toEqual([])
      await assertPredecessorsUnchanged(t, before)
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      expect(t.faults.responseWrites).toEqual([{ sessionId: pending.nativeSessionId,
        requestId: pending.nativeRequestId, optionId: approvalResponse(pending).optionId }])

      t.faults.hideResponseEvidence = false
      const delivered = await t.runtime.service.reconcile(response.interaction)
      expect(delivered).toMatchObject({ id: pending.id, deliveryState: 'delivered',
        nativeSessionId: pending.nativeSessionId, selectedOptionId: response.interaction.selectedOptionId })
      const receipts = await t.f.receipts()
      expect(receipts).toEqual([expect.objectContaining({ entity_id: pending.id })])
      await t.runtime.service.reconcile(delivered)
      await t.runtime.engine.resumeInteraction(delivered)
      expect(await t.f.receipts()).toEqual(receipts)
      expect(t.faults.responseWrites).toHaveLength(1)
      await t.finishApprovals()
      await t.settled('succeeded')
      await assertPredecessorsUnchanged(t, before)
      expect((await t.f.receipts()).filter((receipt) => receipt.entity_id === pending.id)).toEqual(receipts)
      expect(t.faults.responseWrites.filter((write) => write.requestId === pending.nativeRequestId))
        .toEqual([{ sessionId: pending.nativeSessionId, requestId: pending.nativeRequestId,
          optionId: approvalResponse(pending).optionId }])
      expect(new Set(t.f.provider.startedExecutions).size).toBe(t.f.provider.startedExecutions.length)
    }, 90000)
  })
}
