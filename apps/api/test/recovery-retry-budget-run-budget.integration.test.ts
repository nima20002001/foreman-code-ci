import { expect, it } from 'vitest'
import { describeRetryBudget, occurrences } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']

describeRetryBudget('finite technical retry budget: run-budget', () => {
  it.each(forms)('%s: the shared Run execution budget can stop retries before the per-slot ceiling', async (form) => {
    const rounds = form === 'repeat' ? 3 : 1, budget = rounds * 2
    const f = await recoveryFixture(form, (submission) => submission.request.workflowNodeId.endsWith('-1')
      && (submission.occurrenceIndex ?? 1) === rounds ? 'retryable_failure' : 'success', budget)
    try {
      f.launch(); await f.settled()
      const view = await readback(f), rows = await executionRows(f)
      expect(view.record.run.outcome).toBe('failed')
      expect(rows).toHaveLength(budget)
      expect(rows.every((row) => row.execution.attempt === 1)).toBe(true)
      const failed = rows.filter((row) => row.execution.result?.outcome === 'failed')
      expect(failed).toHaveLength(1)
      await assertOriginalFailure(f, failed[0]!.execution.id, true)
      expect(f.provider.counts.starts).toBe(budget)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? rounds : 0)
      expect(f.base.f.version.definition.executionPolicy!.maxNodeExecutions).toBe(budget)
    } finally { await f.close() }
  }, 90000)
})
