import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']

describeRetryBudget('finite technical retry budget: exhaustion', () => {
  it.each(forms)('%s: a retryable original failure exhausts at attempt three, including after restart', async (form) => {
    const f = await recoveryFixture(form, () => 'retryable_failure')
    try {
      f.launch(); await f.settled()
      const before = await readback(f), rows = await executionRows(f)
      expect(before.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed', result: { outcome: 'failed' } })
      expect(before.record.cleanupPending).toBe(false)
      expect(rows).toHaveLength(3); expect(attempts(rows)).toEqual([1, 2, 3]); sameSlot(rows)
      expect(rows.every((row) => row.execution.workflowNodeId === f.base.f.version.entryNodeId)).toBe(true)
      for (const row of rows) await assertOriginalFailure(f, row.execution.id, true)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.provider.counts.starts).toBe(3)
      const submitted = f.provider.submissions.map((item) => item.request.executionId)
      await f.restart()
      // Repeated recovery ticks cannot reset the technical counter, silently
      // create a new Run, or replace the saved business repeat policy.
      for (let tick = 0; tick < 3; tick++) await f.runtime.engine.reconcile((error) => f.errors.push(error))
      await f.settled()
      expect(await readback(f)).toEqual(before)
      expect(f.provider.submissions.map((item) => item.request.executionId)).toEqual(submitted)
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.base.f.scope.workflowId])).rows).toHaveLength(1)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
