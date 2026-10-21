import { afterEach, expect, it, vi } from 'vitest'
import { VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { jobCleanupOptions, jobLifecycleSignal } from './lifecycle.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function execution(createdAt: string) {
  const { spec } = verificationRuntimeFixture()
  const policy = { ...spec.policy, cleanupTimeoutMs: 20 }
  return VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
    acceptedSpec: { ...spec, policy, lifecycle: verificationJobLifecycle(createdAt, policy) } })
}

it('keeps the remaining cleanup budget before the original deadline', () => {
  const record = execution(new Date().toISOString())
  const at = Date.parse(record.acceptedSpec.lifecycle.cleanupDeadlineAt) - 10
  vi.spyOn(Date, 'now').mockReturnValue(at)
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const options = jobCleanupOptions(record)
  expect(options.deadlineAt).toBe(record.acceptedSpec.lifecycle.cleanupDeadlineAt)
  expect(options.signal.aborted).toBe(false)
  expect(timeout).toHaveBeenCalledWith(10)
})

it('bounds each recovery attempt and permits another attempt after interruption', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), milliseconds)
    return controller.signal
  })
  const record = execution(new Date(0).toISOString())
  const first = jobCleanupOptions(record)
  expect(first.signal.aborted).toBe(false)
  const aborted = new Promise<void>(resolve => first.signal.addEventListener('abort', () => resolve(), { once: true }))
  await vi.advanceTimersByTimeAsync(record.acceptedSpec.policy.cleanupTimeoutMs)
  await aborted
  expect(first.signal.aborted).toBe(true)
  const retry = jobCleanupOptions(record)
  expect(retry.signal.aborted).toBe(false)
  expect(Date.parse(retry.deadlineAt)).toBeGreaterThan(Date.parse(first.deadlineAt))
  expect(jobLifecycleSignal(record, 'publication').aborted).toBe(true)
  expect(jobLifecycleSignal(record, 'cleanup').aborted).toBe(true)
})
