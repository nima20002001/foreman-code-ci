import { expect, it } from 'vitest'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { isTransientExecutionError } from '../runs/executionRetryPolicy.js'
import { DomainError } from '../errors.js'
import { serializeError } from '../diagnostics/logger.js'
import { HarnessExecutionError } from '../harnesses/errors.js'

it.each(['40P01', 'ECONNRESET'])('retains the retry classification of a redacted %s failure', code => {
  const secret = `opm_${'x'.repeat(43)}`
  const cause = Object.assign(new Error(`Database failure with ${secret}`), { code })
  const failure = new Error(`Native failure with ${secret}`, { cause })
  const redacted = nativePersistenceRedactor([secret]).error(failure)
  expect(redacted).toMatchObject({ cause: { code, message: 'Database failure with [REDACTED]' } })
  expect(isTransientExecutionError(redacted)).toBe(true)
  expect(redacted).not.toBe(failure)
  expect(JSON.stringify(redacted)).not.toContain(secret)
})

it('preserves a sanitized harness cause and its explicit permanent classification', () => {
  const secret = 'harness-test-token'
  const cause = Object.assign(new Error(`Socket failed with ${secret}`), { code: 'ECONNRESET', token: secret })
  const failure = new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', `Sign in with ${secret}`, false, { cause })
  const redacted = nativePersistenceRedactor([secret]).error(failure)
  expect(redacted).toBeInstanceOf(HarnessExecutionError)
  expect(serializeError(redacted)).toMatchObject({
    message: 'Sign in with [REDACTED]', cause: { code: 'ECONNRESET', message: 'Socket failed with [REDACTED]' },
  })
  expect((redacted as Error).cause).not.toBe(cause)
  expect((redacted as Error).cause).not.toHaveProperty('token')
  expect(JSON.stringify(serializeError(redacted))).not.toContain(secret)
  expect(isTransientExecutionError(redacted)).toBe(false)
  expect(failure.cause).toBe(cause)
})

it('retains and redacts the original credential failure through domain error logging', () => {
  const secret = 'test-scoped-token'
  const databaseError = Object.assign(new Error(`Read failed with ${secret}`), { code: '55P03' })
  const original = new DomainError('DATABASE_READ_TIMEOUT', `Timed out with ${secret}`, 503, { retryable: true })
  original.cause = databaseError
  const failure = new DomainError('WORKER_CREDENTIAL_EXPIRING', 'Credential maintenance stopped', 409)
  failure.cause = original
  const redacted = nativePersistenceRedactor([secret]).error(failure)
  expect(redacted).toBeInstanceOf(DomainError)
  expect(serializeError(redacted)).toMatchObject({
    code: 'WORKER_CREDENTIAL_EXPIRING',
    cause: { code: 'DATABASE_READ_TIMEOUT', message: 'Timed out with [REDACTED]',
      cause: { code: '55P03', message: 'Read failed with [REDACTED]' } },
  })
  expect(JSON.stringify(serializeError(redacted))).not.toContain(secret)
  expect(original.cause).toBe(databaseError)
})

it('preserves explicit remote retryability and its code while redacting the message', () => {
  const secret = 'scoped-test-token'
  const failure = Object.assign(new Error(`Remote failure with ${secret}`), {
    code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', retryable: true, environment: { token: secret },
  })
  const redacted = nativePersistenceRedactor([secret]).error(failure)
  expect(redacted).toMatchObject({ code: failure.code, retryable: true,
    message: 'Remote failure with [REDACTED]' })
  expect(redacted).not.toHaveProperty('environment')
  expect(isTransientExecutionError(redacted)).toBe(true)
})
