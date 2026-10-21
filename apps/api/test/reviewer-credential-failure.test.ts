import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { serializeError } from '../src/modules/diagnostics/logger.js'
import { isTransientExecutionError } from '../src/modules/runs/executionRetryPolicy.js'
import { now, reviewerFixture, session } from './helpers/reviewerAudit.js'

it.each(['preflight', 'renewal'] as const)('preserves the cause of reviewer credential %s failure', async phase => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    await fixture.attach()
    const failure = new DomainError('AUTH_REVOKED', 'Reviewer authority was revoked.', 401)
    if (phase === 'preflight') fixture.hooks.validate = async () => { throw failure }
    else fixture.hooks.renew = async () => { throw failure }
    const maintenance = await fixture.runtime.maintainReviewCredential(
      fixture.execution.id, session, new AbortController().signal, async () => {},
    )
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(maintenance.signal.aborted).toBe(true)
      expect(maintenance.signal.reason).toMatchObject({ code: 'REVIEWER_CREDENTIAL_LOST', cause: failure })
      expect(maintenance.signal.reason.cause).toBe(failure)
      expect(serializeError(maintenance.signal.reason)).toMatchObject({ cause: { code: 'AUTH_REVOKED' } })
    } finally {
      await maintenance.stop()
      await maintenance.invalidate()
    }
  } finally { vi.useRealTimers() }
})

it('retains the database cause when reviewer renewal exhausts its safety deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    await fixture.attach()
    const failure = Object.assign(new Error('Database connection reset'), { code: 'ECONNRESET' })
    fixture.hooks.renew = async () => { throw failure }
    const maintenance = await fixture.runtime.maintainReviewCredential(
      fixture.execution.id, session, new AbortController().signal, async () => {},
    )
    try {
      await vi.advanceTimersByTimeAsync(55_001)
      expect(maintenance.signal.aborted).toBe(true)
      expect(serializeError(maintenance.signal.reason)).toMatchObject({
        code: 'REVIEWER_CREDENTIAL_LOST', cause: { cause: { code: 'ECONNRESET' } },
      })
      expect(isTransientExecutionError(maintenance.signal.reason)).toBe(true)
    } finally {
      await maintenance.stop()
      await maintenance.invalidate()
    }
  } finally { vi.useRealTimers() }
})
