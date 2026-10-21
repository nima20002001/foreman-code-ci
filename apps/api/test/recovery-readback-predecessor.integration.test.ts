import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executionRows, readback, recoveryFixture } from './helpers/eng06DRecovery.js'
import { forms } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: an already accepted predecessor result survives the restart retry of its unfinished successor', async (form) => {
    let parkedOnce = false
    const f = await recoveryFixture(form, (submission) => {
      if (parkedOnce || !submission.request.workflowNodeId.endsWith('-1')) return 'success'
      parkedOnce = true
      return 'park'
    })
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).filter((row) => f.provider.atBarrier(row.execution.id)).length,
        { timeout: 20000, interval: 50 }).toBe(1)
      const before = await readback(f), accepted = before.details.find((item) => item.acceptedResult.status === 'accepted')!
      const waiting = before.details.find((item) => item.execution.state === 'running')!
      expect(before.details).toHaveLength(2)
      expect(accepted).toBeDefined(); expect(waiting).toBeDefined()
      expect(accepted.acceptedResult).toMatchObject({ status: 'accepted', value: accepted.reportedResult })
      await f.restart({ mode: 'crash' }); await f.settled()
      const after = await readback(f), retained = after.details.find((item) => item.execution.executionId === accepted.execution.executionId)!
      expect(after.record.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(retained.execution).toEqual(accepted.execution)
      expect(retained.acceptedInput).toEqual(accepted.acceptedInput)
      expect(retained.reportedResult).toEqual(accepted.reportedResult)
      expect(retained.acceptedResult).toEqual(accepted.acceptedResult)
      const interrupted = after.details.find((item) => item.execution.executionId === waiting.execution.executionId)!
      expect(interrupted.reportedResult).toMatchObject({ outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
      expect(interrupted.acceptedInput).toEqual(waiting.acceptedInput)
      expect(interrupted.acceptedResult).toEqual({ status: 'not_accepted' })
      // The successor continues in a fresh attempt with the same accepted input.
      const retried = after.details.find((item) => item.execution.workflowNodeId === waiting.execution.workflowNodeId
        && item.execution.attempt === 2)!
      expect(retried.acceptedInput).toEqual(waiting.acceptedInput)
      expect(retried.acceptedResult).toMatchObject({ status: 'accepted' })
      expect(f.provider.counts.attaches).toBe(0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
