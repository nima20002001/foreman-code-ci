import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { managedMcpChannelFixture } from '../../../test/helpers/managedMcpChannel.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { RunGraphError } from '../run-graph/errors.js'
import { DomainError } from '../errors.js'
import {
  executionFailureClass, isTransientExecutionCode, isTransientExecutionError, isTransientExecutionResult,
  transientExecutionFailure,
} from './executionRetryPolicy.js'

describe('lost original remote replies', () => {
  it.each([
    { code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', reason: 'not_retained',
      expectedCode: 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', retryable: true },
    { code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', reason: 'process_identity',
      expectedCode: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', retryable: true },
    { code: 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', reason: 'not_retained',
      expectedCode: 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', retryable: true },
    { code: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED', reason: 'not_captured',
      expectedCode: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED', retryable: false },
    { code: 'REMOTE_AUTHORITY_DENIED', reason: 'revoked',
      expectedCode: 'REMOTE_AUTHORITY_DENIED', retryable: false },
  ])('preserves execution retry classification through the device channel: $code ($reason)', async ({
    code, reason, expectedCode, retryable,
  }) => {
    const original = Object.assign(new Error('The original remote reply is unavailable.'), {
      code, details: { reason },
    })
    const channel = managedMcpChannelFixture({
      mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(),
      connectionEpoch: randomUUID(), connectionGeneration: 1,
    }, {
      namespace: 'execution-v1', version: 1, role: 'server', maxJsonBytes: 4096, maxBinaryBytes: 0,
      handle: async () => { throw original },
    })
    try {
      const decoded = await channel.main.request('execution-v1', { method: 'physical-readout' }).catch(error => error)
      expect(decoded).toBeInstanceOf(DeviceApplicationError)
      expect(decoded).not.toBe(original)
      expect(decoded.code).toBe(expectedCode)
      expect(isTransientExecutionError(decoded)).toBe(retryable)
      expect(decoded.retryable).toBe(retryable)
      expect(deviceApplicationFailure(original)).toEqual({
        code: expectedCode, retryable, class: retryable ? 'transient' : 'permanent',
      })
      if (retryable) {
        const failure = transientExecutionFailure(decoded)
        expect(failure).toMatchObject({ outcome: 'failed', error: { code: expectedCode, retryable: true } })
        expect(isTransientExecutionResult(failure)).toBe(true)
      }
    } finally {
      await channel.close()
    }
  })
})

describe('explicit execution retry classification', () => {
  it.each([
    [],
    [new DomainError('DEVICE_CONNECTION_UNAVAILABLE', 'Connection lost.', 503)],
    [new Error('Recover native lifetime', {
      cause: new DomainError('REPEAT_CLEANUP_PENDING', 'Closure is pending.', 409),
    })],
    [new AggregateError([
      new DomainError('APPROVAL_SETTLEMENT_PENDING', 'Approval is pending.', 409),
      Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
    ], 'Cleanup is pending.')],
  ])('keeps temporary cleanup aggregates transient %#', (...errors) => {
    expect(executionFailureClass(new AggregateError(errors, 'Cleanup unconfirmed.'))).toBe('transient')
  })

  it('retains a concrete permanent cause in mixed cleanup failures', () => {
    const error = new AggregateError([
      new DomainError('REPEAT_CLEANUP_PENDING', 'Closure is pending.', 409),
      new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'Native identity changed.', 409),
    ], 'Cleanup failed.')
    expect(executionFailureClass(error)).toBe('permanent')
  })

  it('honors an explicit permanent class on a temporary cleanup aggregate', () => {
    const error = Object.assign(new AggregateError([
      new DomainError('DEVICE_CONNECTION_UNAVAILABLE', 'Connection lost.', 503),
    ], 'Cleanup failed.'), { class: 'permanent' })
    expect(executionFailureClass(error)).toBe('permanent')
  })

  it('retries an uncoded database disconnect wrapped in a graph transaction failure', () => {
    const cause = new Error('Connection terminated unexpectedly')
    const error = new RunGraphError('GRAPH_TRANSACTION_FAILED', { cause })

    expect(executionFailureClass(error)).toBe('transient')
    expect(isTransientExecutionError(error)).toBe(true)
  })

  it.each(['wrapper', 'cause'] as const)(
    'honors an explicit permanent class on the %s of a wrapped database disconnect', target => {
      const cause = new Error('Connection terminated unexpectedly')
      const error = new RunGraphError('GRAPH_TRANSACTION_FAILED', { cause })
      Object.assign(target === 'wrapper' ? error : cause, { class: 'permanent' })

      expect(executionFailureClass(error)).toBe('permanent')
      expect(isTransientExecutionError(error)).toBe(false)
    },
  )

  it.each([
    { code: 'CODEX_APP_SERVER_DISCONNECTED', retryable: false },
    { code: 'ECONNRESET', details: { retryable: false } },
    new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Authentication is required.', false),
    new HarnessExecutionError('CODEX_APP_SERVER_TIMEOUT', 'Do not replay this operation.', false),
    Object.assign(new Error('Permanent failure', { cause: { code: 'ECONNRESET' } }), { retryable: false }),
    { code: 'DATABASE_READ_TIMEOUT', retryable: false },
  ])('honors an explicit permanent classification %#', error => {
    expect(isTransientExecutionError(error)).toBe(false)
  })

  it.each(['CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'CODEX_APP_SERVER_VERSION_UNQUALIFIED',
    'CODEX_APP_SERVER_REQUEST_CANCELED', 'CODEX_APP_SERVER_RESPONSE_INVALID', 'CODEX_APP_SERVER_UNKNOWN'])(
    'does not infer retryability from the Codex prefix: %s', code => {
    expect(isTransientExecutionCode(code)).toBe(false)
    expect(isTransientExecutionError({ code })).toBe(false)
  })

  it.each(['CODEX_APP_SERVER_DISCONNECTED', 'CODEX_APP_SERVER_TIMEOUT', 'CODEX_APP_SERVER_REQUEST_UNCERTAIN'])(
    'retries a known transient code without an explicit classification: %s', code => {
    expect(isTransientExecutionCode(code)).toBe(true)
    expect(isTransientExecutionError({ code })).toBe(true)
  })

  it('honors an explicit transient classification for an unknown provider code', () => {
    expect(isTransientExecutionError(new HarnessExecutionError('PROVIDER_BUSY', 'Try later.', true))).toBe(true)
  })

  it('gives unclassified harness failures the same transient code defaults as execution retries', () => {
    const disconnected = new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Connection lost.')
    expect(disconnected.result.error?.retryable).toBe(true)
    expect(isTransientExecutionError(disconnected)).toBe(true)
    const rejected = new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Sign in again.')
    expect(rejected.result.error?.retryable).toBe(false)
    expect(isTransientExecutionError(rejected)).toBe(false)
  })
})
