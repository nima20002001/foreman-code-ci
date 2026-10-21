import { describe, expect, it } from 'vitest'
import { HarnessCompatibilityListSchema, HarnessCompatibilityRetryParamsSchema } from './harnessCompatibility.js'

describe('compatibility diagnostic contracts', () => {
  it('accepts observed versions and verification results without release paperwork', () => {
    const report = {
      harness: 'codex', checkId: '11111111-1111-4111-8111-111111111111', installedVersion: '99.0.0',
      status: 'probe-passed', checkedAt: '2026-10-01T00:00:00.000Z', source: 'local-probe',
      checkerRevision: 'diagnostic-revision', reason: null, schemaSha256: 'a'.repeat(64),
      cacheWarning: null, scope: 'protocol-settings-diagnostic-only',
    }
    const response = { canRetry: false, harnesses: [report] }
    expect(HarnessCompatibilityListSchema.parse(response)).toEqual(response)
  })
  it('does not accept caller-selected commands or binary paths on retries', () => {
    expect(HarnessCompatibilityRetryParamsSchema.safeParse({ harness: 'codex' }).success).toBe(true)
    const selectedBinary = { harness: 'codex', binary: '/arbitrary', forceQualification: true }
    expect(HarnessCompatibilityRetryParamsSchema.safeParse(selectedBinary).success).toBe(false)
  })
  it('does not accept an incomplete catalog as an empty success', () => {
    expect(HarnessCompatibilityListSchema.safeParse({ canRetry: false, harnesses: [] }).success).toBe(false)
  })
  it('accepts the supported diagnostic report and rejects duplicate entries', () => {
    const report = {
      harness: 'codex', checkId: '11111111-1111-4111-8111-111111111111', installedVersion: null,
      status: 'not-checked', checkedAt: null, source: 'none', checkerRevision: 'diagnostic-revision',
      reason: null, schemaSha256: null, cacheWarning: null, scope: 'protocol-settings-diagnostic-only',
    }
    const response = { canRetry: false, harnesses: [report] }
    expect(HarnessCompatibilityListSchema.parse(response)).toEqual(response)
    expect(HarnessCompatibilityListSchema.safeParse({ ...response, harnesses: [report, report] }).success).toBe(false)
    expect(HarnessCompatibilityListSchema.safeParse({
      ...response, harnesses: [{ ...report, harness: 'opencode' }],
    }).success).toBe(false)
  })
})
