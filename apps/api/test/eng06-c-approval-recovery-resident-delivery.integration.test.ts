import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: resident delivery`, () => {
    it('recovers a lost delivery observation on the original resident session exactly once', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.hideResponseEvidence = true
      const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(response.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      t.faults.hideResponseEvidence = false
      const recovered = await t.runtime.service.reconcile(response.interaction)
      expect(recovered.deliveryState).toBe('delivered')
      expect(await t.f.receipts()).toHaveLength(1)
      expect(t.f.provider.counts).toMatchObject({ responses: 1, attaches: 0 })
      expect((await t.runtime.runs.getExecution(pending.executionId!))?.result?.outcome).toBe('succeeded')
      const ack = (await t.f.db.pool.query<{ approval_native_ack_id: string; approval_native_ack_record: unknown }>(
        'select approval_native_ack_id,approval_native_ack_record from interaction_graph_resumes where interaction_id=$1', [pending.id])).rows
      expect(ack).toHaveLength(1)
      expect(ack[0]!.approval_native_ack_id).toEqual(expect.any(String))
      expect(ack[0]!.approval_native_ack_record).not.toBeNull()
      await t.compare(); await t.finishApprovals()
      expect(t.f.provider.counts).toMatchObject({ starts: form === 'repeat' ? 4 : 2, responses: form === 'repeat' ? 2 : 1 })
      expect(await t.recoveryRows()).toHaveLength(0)
    }, 90000)
  })
}
