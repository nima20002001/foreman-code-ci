import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { createApprovalRecoverySetup } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: mid execution stop`, () => {
    it('Stop reaches cleanup settlement after a mid-execution backend restart', async () => {
      const t = await setup(form, { approvals: false }), gate = t.faults.holdNextTurn()
      const started = t.runtime.engine.start(t.runId).then(() => undefined, (error: unknown) => error)
      try {
        const sessionId = await gate.entered
        expect((await t.runtime.runs.get(t.runId))?.executionState).toBe('running')
        await t.compare()
        t.faults.killOnRestart = true
        await t.restart(); await started
        expect(t.faults.deadSessions.has(sessionId)).toBe(true)
        expect(await t.stop()).toBe(true)
        await t.settled('canceled'); await t.assertShape(1)
        expect(await t.recoveryRows()).toHaveLength(1)
        expect(t.f.provider.counts).toMatchObject({ starts: 1, responses: 0, attaches: 0 })
        expect(await t.f.receipts()).toHaveLength(0)
        const receipts = await t.recoveryRows()
        expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
        expect(await t.recoveryRows()).toEqual(receipts)
      } finally { gate.release(); await started }
    }, 90000)
  })
}
