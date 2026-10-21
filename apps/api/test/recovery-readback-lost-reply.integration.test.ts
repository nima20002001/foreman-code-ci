import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, recoveryFixture } from './helpers/eng06DRecovery.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: provider-only history behind a lost reply is not an accepted result; the node retries after restart', async (form) => {
    let first = true
    const f = await recoveryFixture(form, () => { if (first) { first = false; return 'durable_reply_gap' } return 'success' })
    try {
      f.launch(); const before = await parked(f), original = before.details[0]!.execution.executionId
      // This is provider durability, NOT an application result/acceptance COMMIT.
      // d32a361 deliberately does not cold-attach to fetch that provider history.
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      await f.restart({ mode: 'crash' })
      // The restart abandons the attempt for its lost session; its provider history is not
      // read back or accepted, and the Run is not fenced.
      const during = await readback(f), counts = { ...f.provider.counts }
      expect(during.record).toEqual(before.record)
      expect(during.details[0]!.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
      expect(during.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(f.provider.recoveryCalls).toEqual([])
      await f.settled()
      const after = await readback(f)
      const recovered = after.details.find((detail) => detail.execution.executionId === original)!
      expect(after.record).toMatchObject({ run: { executionState: 'completed', outcome: 'succeeded' },
        cleanupPending: false, stopRequested: false })
      expect(recovered.execution).toMatchObject({ executionId: original, attempt: 1, state: 'completed' })
      expect(recovered.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
      expect(recovered.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(recovered.acceptedInput).toEqual(before.details[0]!.acceptedInput)
      const retried = after.details.find((detail) => detail.execution.workflowNodeId === recovered.execution.workflowNodeId
        && detail.execution.attempt === 2)!
      expect(retried.acceptedInput).toEqual(recovered.acceptedInput)
      expect(retried.acceptedResult).toMatchObject({ status: 'accepted' })
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      expect(f.provider.counts.starts).toBeGreaterThan(counts.starts)
      expect(f.provider.counts.attaches).toBe(0)
      expect(await readWorkflowClosure(f.base.db.pool, (await f.runtime.runs.getExecution(original))!))
        .toMatchObject({ execution: { id: original }, durableGeneration: expect.stringMatching(/^[1-9][0-9]*$/) })
      expect(after.record.run.agentConfigurationVersionIds).toEqual(before.record.run.agentConfigurationVersionIds)
      expect(after.record.run.executionLocation).toEqual(before.record.run.executionLocation)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
