import { describe, expect, it } from 'vitest'
import { approvalFaultFixture } from './helpers/eng06ApprovalFaults.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { restartCleanup } from './workflowApprovalRestart.test-support.js'

const closes = restartCleanup()

describe.skipIf(!postgresEnabled)('pending workflow approval restart', () => {
  it('settles an ended original requester after recomposition without replaying its turn or acknowledging approval', async () => {
    const t = await approvalFaultFixture('ordinary')
    closes.push(t.close)
    await t.runtime.engine.start(t.runId)
    const pending = await t.onePending()
    const before = await readCurrentExecutions(t.runtime.runs, t.runId)
    t.faults.killOnRestart = true
    await t.restart()
    await t.runtime.engine.start(t.runId)
    await t.settled('failed')
    expect(await t.runtime.runs.getExecution(pending.executionId)).toMatchObject({
      state: 'completed', result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } },
      input: before.find((item) => item.id === pending.executionId)!.input,
    })
    expect(t.f.provider.counts).toMatchObject({ starts: 2, sessions: 2, attaches: 0, responses: 0 })
    expect(t.faults.processes.isClosed(pending.executionId)).toBe(true)
    expect(t.faults.processes.recoveredExecutions).toEqual([pending.executionId])
    expect(await t.f.receipts()).toHaveLength(0)
    await t.assertNoNativeAcknowledgement(pending.id)
    const records = await t.recoveryRows()
    await t.runtime.engine.start(t.runId)
    expect(await t.recoveryRows()).toEqual(records)
  }, 90000)
})
