import { expect, it } from 'vitest'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { describeNativeFailure, nativeFailureSummary } from './nativeFailureEvidence.js'

it('retains the native failure reason and nested causes without exposing credentials or error fields', () => {
  const token = `opm_${'a'.repeat(43)}`
  const providerSecret = 'provider-credential-fixture'
  const native = new HarnessExecutionError('CODEX_MODEL_UNAVAILABLE',
    `Model unavailable; diagnostic ${token} ${providerSecret}`)
  Object.assign(native, { environment: { credential: providerSecret } })
  const error = new AggregateError([native], 'Native cleanup failed.', { cause: native })
  const result = describeNativeFailure(error, [providerSecret])
  expect(result).toMatchObject({ name: 'AggregateError', message: 'Native cleanup failed.',
    causes: [{ name: 'HarnessExecutionError', code: 'CODEX_MODEL_UNAVAILABLE',
      message: 'Model unavailable; diagnostic [REDACTED] [REDACTED]' }] })
  expect(result.causes).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain(token)
  expect(JSON.stringify(result)).not.toContain(providerSecret)
  expect(JSON.stringify(result)).not.toContain('environment')
})

it('bounds cyclic causes and long native messages before writing failure evidence', () => {
  const error = new Error('x'.repeat(3000))
  error.cause = error
  const result = describeNativeFailure(error, [])
  expect(result.message).toHaveLength(2048)
  expect(result.causes?.[0]?.causes?.[0]?.causes?.[0]?.causes).toBeUndefined()
  expect(() => JSON.stringify(result)).not.toThrow()
})

it('keeps actionable failed-execution codes in the run log and redacts issued credentials', () => {
  const credential = 'issued-native-credential-fixture'
  const summary = nativeFailureSummary({
    scenario: 'native-restart',
    error: describeNativeFailure(new Error('No native start.'), []),
    failureExecutions: [{ state: 'failed', result: { outcome: 'failed',
      error: { code: 'CODEX_DIAGNOSTIC_OWNER_REQUIRED', message: `Refresh failed ${credential}` },
      environment: { token: 'unknown-cold-credential' }, output: 'private-native-output' } }],
    environment: { credential },
    runtimeTimeline: ['unrelated'],
  }, [credential])
  expect(JSON.parse(summary)).toMatchObject({ scenario: 'native-restart',
    failureExecutions: [{ result: { error: { code: 'CODEX_DIAGNOSTIC_OWNER_REQUIRED',
      message: 'Refresh failed [REDACTED]' } } }] })
  expect(summary).not.toContain(credential)
  expect(summary).not.toContain('environment')
  expect(summary).not.toContain('unknown-cold-credential')
  expect(summary).not.toContain('private-native-output')
  expect(summary).not.toContain('unrelated')
  expect(JSON.parse(nativeFailureSummary({ error: 'x'.repeat(100_000) }, [])).error).toHaveLength(2_048)
})
