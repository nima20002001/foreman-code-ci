import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'
import { rejectableDeferred } from './helpers/deferred.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: duplicate responses`, () => {
    it('deduplicates open and terminal responses without replaying native work or another occurrence', async () => {
      const t = await setup(form), first = await startWaiting(t), input = approvalResponse(first)
      const entered = rejectableDeferred(), release = rejectableDeferred()
      t.f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
      const firstReply = t.runtime.service.respond(t.responder, input)
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      // Keep the Run OPEN while the second request reads the real decision.
      // Promise.all without this gate races completion and legitimately gets
      // EXECUTION_STOPPED for the late caller on an ordinary two-node Run.
      try {
        await entered.promise
        const duplicate = await t.runtime.service.respond(t.responder, input)
        expect(duplicate.replayed).toBe(true)
        expect(t.faults.responseWrites).toHaveLength(1)
        release.resolve()
        expect(await firstReply).toMatchObject({ value: { replayed: false } })
      } finally { release.resolve(); await firstReply; delete t.f.provider.beforeRespond }
      expect(t.f.provider.counts.responses).toBe(1)
      if (form === 'repeat') {
        const second = await t.onePending(), receipts = await t.f.receipts(), head = (await t.compare()).asOfSequence
        expect(second.executionId).not.toBe(first.executionId)
        expect(second.nativeRequestId).not.toBe(first.nativeRequestId)
        expect((await t.runtime.service.respond(t.responder, input)).replayed).toBe(true)
        expect(await t.runtime.repository.get(second.id)).toEqual(second)
        expect(await t.f.receipts()).toEqual(receipts)
        expect((await t.compare()).asOfSequence).toBe(head)
        const conflicting = first.responseOptions.find((item) => item.optionId !== input.optionId)!
        await expect(t.runtime.service.respond(t.responder, { ...input, optionId: conflicting.optionId }))
          .rejects.toBeInstanceOf(DomainError)
        expect(await t.runtime.repository.get(second.id)).toEqual(second)
        expect(t.f.provider.counts.responses).toBe(1)
      }
      await t.finishApprovals()
      await t.restart()
      const receipts = await t.f.receipts(), head = (await t.compare()).asOfSequence
      expect((await t.runtime.service.respond(t.responder, input)).replayed).toBe(true)
      expect(await t.f.receipts()).toEqual(receipts)
      expect((await t.compare()).asOfSequence).toBe(head)
      expect(t.f.provider.counts).toMatchObject({ starts: form === 'repeat' ? 4 : 2, responses: form === 'repeat' ? 2 : 1 })
      expect(await t.recoveryRows()).toHaveLength(0)
      await t.settled('succeeded')
    }, 90000)
  })
}
