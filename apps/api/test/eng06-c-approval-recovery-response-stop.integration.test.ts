import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'
import { rejectableDeferred } from './helpers/deferred.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: response stop`, () => {
    it('does not consume a late native ACK when Stop wins during an in-flight approval response', async () => {
      const t = await setup(form), pending = await startWaiting(t), entered = rejectableDeferred(), release = rejectableDeferred()
      t.f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
      const response = t.runtime.service.respond(t.responder, approvalResponse(pending))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      try {
        await entered.promise
        await t.f.stop()
        release.resolve(); await response
        expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
        await t.settled('canceled'); await t.assertShape(1)
        expect(await t.f.receipts()).toHaveLength(0)
        await expect.poll(() => t.f.provider.counts.responses, { timeout: 2000, interval: 10 }).toBe(1)
        // Current exchanges intentionally retire after positive cleanup. Assert
        // retained SQL identity/no ACK and absence, not a permanent UI row.
        expect(await t.runtime.repository.get(pending.id)).toMatchObject({ status: 'canceled',
          nativeSessionId: pending.nativeSessionId, nativeRequestId: pending.nativeRequestId })
        await t.assertNoNativeAcknowledgement(pending.id)
        expect((await t.compare()).state.interactions.some((item) => item.interactionId === pending.id)).toBe(false)
        expect(t.faults.responseWrites).toHaveLength(1)
        expect((await t.runtime.runs.getExecution(pending.executionId!))?.result?.outcome).toBe('canceled')
        const receipts = await t.f.receipts()
        await t.runtime.engine.resumeInteraction(pending)
        expect(await t.f.receipts()).toEqual(receipts)
        await t.settled('canceled')
      } finally { release.resolve(); await response; delete t.f.provider.beforeRespond }
    }, 90000)
  })
}
