import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']

describeRetryBudget('finite technical retry budget: permanent-failure', () => {
  it.each(forms)('%s: a non-retryable original failure cannot spend a technical retry', async (form) => {
    const f = await recoveryFixture(form, () => 'permanent_failure')
    try {
      f.launch(); await f.settled()
      const view = await readback(f), rows = await executionRows(f)
      expect(view.record.run.outcome).toBe('failed')
      expect(attempts(rows)).toEqual([1]); expect(f.provider.counts.starts).toBe(1)
      await assertOriginalFailure(f, rows[0]!.execution.id, false)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
    } finally { await f.close() }
  }, 90000)
})
