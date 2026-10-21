import { afterEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import {
  EXECUTION_MAX_ATTEMPTS, executionRetryDelayMs, isTransientExecutionError, isTransientExecutionResult, transientExecutionFailure,
} from '../src/modules/runs/executionRetryPolicy.js'

const testBackoff = process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
afterEach(() => {
  if (testBackoff === undefined) delete process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
  else process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS = testBackoff
})

describe('execution failure classification', () => {
  it.each([
    new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Dispatch may have occurred.', 409),
    new DomainError('EXECUTION_INTERRUPTED', 'interrupted', 409),
    new HarnessExecutionError('CODEX_APP_MCP_NOT_READY', 'MCP did not start'),
    new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'closed'),
    new DomainError('DEVICE_TRANSPORT_ERROR', 'link lost', 503),
    new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'no route', 503),
    new DomainError('WORKER_CREDENTIAL_EXPIRING', 'renewal failed', 409),
    new DomainError('DATABASE_READ_TIMEOUT', 'slow', 503),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new Error('Query read timeout'),
    new Error('Native process is gone'),
    new Error('Native process is gone', { cause: 'process disconnected' }),
  ])('retries infrastructure failure %#', (error) => {
    expect(isTransientExecutionError(error)).toBe(true)
  })

  it.each([
    new DomainError('WORK_RESULT_INVALID', 'contract', 409),
    new DomainError('WORKFLOW_EXECUTION_BUDGET_EXHAUSTED', 'budget', 409),
    new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'active budget', 409),
    new DomainError('AUTH_REVOKED', 'revoked by the owner', 401),
    new DomainError('GRAPH_STOP_CONFLICT', 'stopped', 409),
    new HarnessExecutionError('CODEX_TURN_FAILED', 'the Agent failed'),
    new ZodError([]),
    new AggregateError([new DomainError('WORK_RESULT_INVALID', 'contract', 409)], 'task failed'),
  ])('does not retry task failure %#', (error) => {
    expect(isTransientExecutionError(error)).toBe(false)
  })

  it('records the original infrastructure code as a retryable cause', () => {
    expect(transientExecutionFailure(new HarnessExecutionError('CODEX_APP_MCP_NOT_READY', 'MCP did not start')))
      .toEqual({ outcome: 'failed', error: { code: 'CODEX_APP_MCP_NOT_READY', message: 'MCP did not start', retryable: true } })
    expect(transientExecutionFailure(new Error('Query read timeout')))
      .toEqual({ outcome: 'failed', error: { code: 'EXECUTION_START_INTERRUPTED', message: 'Query read timeout', retryable: true } })
  })

  it('backs off 10 s, 30 s, then 60 s and allows three attempts', () => {
    delete process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS
    expect(EXECUTION_MAX_ATTEMPTS).toBe(3)
    expect([1, 2, 3, 4].map(executionRetryDelayMs)).toEqual([10_000, 30_000, 60_000, 60_000])
    process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS = '5,7'
    expect([1, 2, 3].map(executionRetryDelayMs)).toEqual([5, 7, 7])
  })
})

describe('wrapped infrastructure failures', () => {
  it.each([
    new HarnessExecutionError('PROVIDER_TEMPORARY_FAILURE', 'Try again', true),
    new NativeDeliveryError('turn_submission', 'unknown', Object.assign(new Error('Lock unavailable'), { code: '55P03' })),
    new DomainError('DATABASE_RETRY_DEADLINE_EXCEEDED', 'Retry the operation', 503, { retryable: true }),
    new Error('Turn acknowledgement failed', { cause: Object.assign(new Error('Database disconnected'), { code: '08006' }) }),
    Object.assign(new Error('Temporary wrapper'), { code: 'ACK_FAILED', cause: Object.assign(new Error('Lock unavailable'), { code: '55P03' }) }),
  ])('preserves retryability through the error and recorded result %#', error => {
    expect(isTransientExecutionError(error)).toBe(true)
    expect(isTransientExecutionResult(transientExecutionFailure(error))).toBe(true)
  })

  it('accepts explicitly retryable provider results without an infrastructure allowlist entry', () => {
    expect(isTransientExecutionResult({ outcome: 'failed', error: {
      code: 'PROVIDER_TEMPORARY_FAILURE', message: 'Try again', retryable: true,
    } })).toBe(true)
  })

  it('handles a cyclic cause without treating a coded task failure as infrastructure', () => {
    const error = new DomainError('WORK_RESULT_INVALID', 'Invalid result', 409)
    error.cause = error
    expect(isTransientExecutionError(error)).toBe(false)
  })
})

it('retries aggregate cleanup failures while preserving a permanent child failure', () => {
  const transient = new DomainError('DEVICE_TRANSPORT_ERROR', 'link lost', 503)
  expect(isTransientExecutionError(new AggregateError([transient], 'closure pending'))).toBe(true)
  expect(isTransientExecutionError(new AggregateError([new Error('close failed')], 'closure pending'))).toBe(true)
  expect(isTransientExecutionError(new AggregateError([
    transient, new DomainError('WORK_RESULT_INVALID', 'contract', 409),
  ], 'mixed failure'))).toBe(false)
})
