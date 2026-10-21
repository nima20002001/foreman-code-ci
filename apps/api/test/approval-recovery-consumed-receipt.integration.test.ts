import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: consumed receipt`, () => {
    it('preserves the consumed receipt across restart and acknowledges only retained native evidence', async () => {
      const t = await setup(form), pending = await startWaiting(t), gate = t.faults.holdWorkerAcknowledgement()
      const response = t.runtime.service.respond(t.responder, approvalResponse(pending))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      try {
        await gate.entered
        expect((await t.runtime.repository.get(pending.id))?.deliveryState).toBe('delivered')
        const consumed = await t.f.receipts()
        expect(consumed).toHaveLength(1)
        const resumeRows = await t.resumeRows(pending.id)
        expect(resumeRows).toEqual([{ state: 'resumed', approval_native_ack_id: null, approval_native_ack_record: null }])
        await t.assertNoNativeAcknowledgement(pending.id)
        await t.restart(); await response
        expect(await t.f.receipts()).toEqual(consumed)
        expect(await t.resumeRows(pending.id)).toEqual(resumeRows)
        await t.assertNoNativeAcknowledgement(pending.id)
        gate.release()
        await t.runtime.engine.resume(t.runId)
        expect(await t.f.receipts()).toEqual(consumed)
        const acknowledged = await t.resumeRows(pending.id)
        expect(acknowledged).toEqual([expect.objectContaining({ state: 'resumed',
          approval_native_ack_id: expect.any(String),
          approval_native_ack_record: expect.objectContaining({
            interaction: expect.objectContaining({ id: pending.id, executionId: pending.executionId,
              nativeSessionId: pending.nativeSessionId, nativeRequestId: pending.nativeRequestId }),
            nativeSource: expect.objectContaining({ sourceKind: 'native_event' }),
          }),
        })])
        await t.runtime.engine.resumeInteraction((await t.runtime.repository.get(pending.id))!)
        expect(await t.f.receipts()).toEqual(consumed)
        expect(await t.resumeRows(pending.id)).toEqual(acknowledged)
        expect(t.f.provider.counts).toMatchObject({ starts: form === 'ordinary' ? 2 : 4, responses: 1, attaches: 1 })
        await t.finishApprovals()
        await t.settled('succeeded')
        expect((await t.f.receipts()).filter((receipt) => receipt.entity_id === pending.id)).toEqual(consumed)
        expect(await t.resumeRows(pending.id)).toEqual(acknowledged)
        expect(t.faults.responseWrites.filter((write) => write.requestId === pending.nativeRequestId))
          .toEqual([{ sessionId: pending.nativeSessionId, requestId: pending.nativeRequestId,
            optionId: approvalResponse(pending).optionId }])
      } finally { gate.release(); await response }
    }, 90000)
  })
}
