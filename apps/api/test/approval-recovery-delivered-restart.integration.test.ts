import { describe, expect, it } from 'vitest'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import {
  createApprovalRecoverySetup,
  loseGraphAcknowledgement,
  assertPredecessorsUnchanged,
} from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: delivered restart`, () => {
    it('recovers proven delivery once and waits for retained native evidence before acknowledging it', async () => {
      const t = await setup(form)
      const gate = t.faults.holdWorkerAcknowledgement()
      const { pending, delivered } = await loseGraphAcknowledgement(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      await t.restart()
      const detached = await t.closureRows()
      const resuming = t.runtime.engine.resume(t.runId)
      try {
        await gate.entered
        expect(await t.f.receipts()).toHaveLength(0)
        await t.assertNoNativeAcknowledgement(pending.id)
        expect(await t.closureRows()).toEqual([...detached, expect.objectContaining({
          execution_id: pending.executionId,
          execution_identity: expect.objectContaining({ id: pending.executionId, runId: t.runId }),
          expected_reference: { harness: pending.harness, providerVersion: pending.providerVersion,
            nativeSessionId: pending.nativeSessionId },
          closed_at: null, closed_reference: null, closed_without_session: false,
          detached_at: null, detached_reference: null,
        })])
      } finally { gate.release() }
      await resuming
      expect(await t.runtime.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered',
        nativeSessionId: delivered.nativeSessionId, selectedOptionId: delivered.selectedOptionId })
      const receipts = await t.f.receipts()
      expect(receipts).toEqual([expect.objectContaining({ entity_id: pending.id })])
      const resumed = await t.resumeRows(pending.id)
      expect(resumed).toEqual([expect.objectContaining({ state: 'resumed',
        approval_native_ack_id: expect.any(String),
        approval_native_ack_record: expect.objectContaining({
          interaction: expect.objectContaining({ id: pending.id, executionId: pending.executionId,
            nativeSessionId: pending.nativeSessionId, nativeRequestId: pending.nativeRequestId }),
          nativeSource: expect.objectContaining({ sourceKind: 'native_event' }),
        }),
      })])
      await assertPredecessorsUnchanged(t, before)
      expect(await t.recoveryRows()).toEqual([])
      await t.runtime.engine.resumeInteraction(delivered)
      await t.runtime.service.reconcile(delivered)
      expect(await t.f.receipts()).toEqual(receipts)
      expect(await t.resumeRows(pending.id)).toEqual(resumed)
      expect(t.f.provider.counts).toMatchObject({ starts: form === 'ordinary' ? 2 : 4, responses: 1, attaches: 1 })
      await t.finishApprovals()
      await t.settled('succeeded')
      expect((await t.f.receipts()).filter((receipt) => receipt.entity_id === pending.id)).toEqual(receipts)
      expect(await t.resumeRows(pending.id)).toEqual(resumed)
      expect(t.faults.responseWrites.filter((write) => write.requestId === pending.nativeRequestId))
        .toEqual([{ sessionId: pending.nativeSessionId, requestId: pending.nativeRequestId,
          optionId: approvalResponse(pending).optionId }])
    }, 90000)
  })
}
