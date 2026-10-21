import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { reconciliationReporter } from './helpers/reconciliationReporter.mjs'

it('reports pending physical closure while preserving unexpected reconciliation failures', () => {
  const pending = vi.fn()
  const failure = vi.fn()
  const report = reconciliationReporter({ pending, failure })
  const unfinished = new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'Original closure is pending', 409)
  const broken = new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original identity changed', 409)
  report(unfinished)
  expect(pending).toHaveBeenCalledWith(unfinished)
  expect(failure).not.toHaveBeenCalled()
  report(broken)
  expect(failure).toHaveBeenCalledWith(broken)
})

it('does not classify arbitrary error text or untyped reports as pending closure', () => {
  const pending = vi.fn()
  const failure = vi.fn()
  const report = reconciliationReporter({ pending, failure })
  report(new Error('SOURCE_EXECUTION_UNCERTAIN'))
  report({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  expect(pending).not.toHaveBeenCalled()
  expect(failure).toHaveBeenCalledTimes(2)
})
