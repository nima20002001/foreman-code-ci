import { describe, expect, it } from 'vitest'
import {
  JobVerificationProfileInputSchema, JobVerificationRuntimeMeasurementSchema,
  JobRuntimeMeasurementRecordSchema, JobRuntimeFingerprintRecordSchema,
  JOB_VERIFICATION_BASE_CHECKS, JOB_VERIFICATION_EGRESS_CHECKS,
} from './jobVerificationRuntime.js'
import { verificationFixture, verificationMeasurementFixture, verificationId, verificationDigest }
  from '../tests/helpers/jobVerification.js'

describe('verification profile qualification contracts', () => {
  it('keeps save input separate from human review and worker-produced measurements', () => {
    const { spec, resources } = verificationFixture()
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = spec.policy
    expect(isolationPolicyId).toBe('profile')
    expect(isolationPolicyRevision).toBe(1)
    const input = { rootId: verificationId, bindingRevision: 1, resources, policy,
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: 3_600_000 } }
    expect(JobVerificationProfileInputSchema.parse(input)).toEqual(input)
    for (const field of ['ready', 'measurement', 'approvedByPrincipalId']) {
      expect(JobVerificationProfileInputSchema.safeParse({ ...input, [field]: true }).success).toBe(false)
    }
    expect(JobVerificationProfileInputSchema.safeParse({ ...input, suites: ['unit', 'unit'] }).success).toBe(false)
    expect(JobVerificationProfileInputSchema.safeParse({ ...input,
      policy: { ...policy, environmentScopeRefs: ['owner-login'] } }).success).toBe(false)
  })
  it('requires the extended checks and preserves bounded validity for ordinary verification', () => {
    const measurement = verificationMeasurementFixture()
    expect(JobVerificationRuntimeMeasurementSchema.parse(measurement)).toEqual(measurement)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      checks: measurement.checks.filter(check => check.id !== 'failure-publication') }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      identity: { ...measurement.identity, qualificationExpiresAt: '2026-10-04T14:00:00.000Z' } }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      fingerprint: { ...measurement.fingerprint, approvalConfig: {
        ...measurement.fingerprint.approvalConfig, review: null,
      } } }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement, suites: [{
      ...measurement.suites[0], coldCachePeakInodes: measurement.fingerprint.resources.mutableInodes + 1,
    }] }).success).toBe(false)
  })
  it('requires every egress bypass check and the same mode in the approved fingerprint', () => {
    const measurement = verificationMeasurementFixture()
    const network = { schemaVersion: 2, mode: 'registry-only', enforcement: {
      implementation: 'reviewed-worker-component', version: '1', destinationPolicyDigest: verificationDigest,
    } }
    const checkIds = [...JOB_VERIFICATION_BASE_CHECKS, ...JOB_VERIFICATION_EGRESS_CHECKS, 'registry-allowlist']
    const egress = { ...measurement, identity: { ...measurement.identity, network },
      fingerprint: { ...measurement.fingerprint, network },
      checks: checkIds.map(id => ({ id, passed: true, evidenceDigest: verificationDigest })) }
    expect(JobVerificationRuntimeMeasurementSchema.safeParse(egress).success).toBe(true)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      checks: egress.checks.filter(check => check.id !== 'main-device-denied') }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      fingerprint: measurement.fingerprint }).success).toBe(false)
    const publicNetwork = { ...network, mode: 'public-egress' }
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      identity: { ...egress.identity, network: publicNetwork },
      fingerprint: { ...egress.fingerprint, network: publicNetwork },
    }).success).toBe(false)
  })
  it('cannot qualify native or browser suites by relabeling an ordinary runtime', () => {
    const measurement = verificationMeasurementFixture()
    for (const suite of ['integration', 'browser', 'native-acceptance']) {
      expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
        suites: [{ ...measurement.suites[0], suite }] }).success).toBe(false)
    }
  })
  it('qualifies native acceptance with Codex and Claude and rejects a retired binary', () => {
    const measurement = verificationMeasurementFixture()
    const tools = [
      { kind: 'postgresql', executable: '/tools/postgres', version: '17.6', binarySha256: verificationDigest },
      { kind: 'codex', executable: '/tools/codex', version: 'codex-fixture', binarySha256: verificationDigest },
      { kind: 'claude', executable: '/tools/claude', version: 'claude-fixture', binarySha256: verificationDigest },
    ]
    const native = {
      ...measurement,
      fingerprint: { ...measurement.fingerprint, tools },
      checks: [
        ...measurement.checks,
        ...['postgres-isolation', 'native-containment', 'credential-redaction']
          .map(id => ({ id, passed: true, evidenceDigest: verificationDigest })),
      ],
      suites: [{ ...measurement.suites[0], suite: 'native-acceptance' }],
    }
    expect(JobVerificationRuntimeMeasurementSchema.parse(native)).toEqual(native)
    for (const harness of ['codex', 'claude']) {
      expect(JobVerificationRuntimeMeasurementSchema.safeParse({
        ...native, fingerprint: { ...native.fingerprint, tools: tools.filter(tool => tool.kind !== harness) },
      }).success).toBe(false)
    }
    const historical = {
      ...native, fingerprint: { ...native.fingerprint,
        tools: tools.map(tool => tool.kind === 'claude' ? { ...tool, kind: 'opencode' } : tool) },
    }
    expect(JobVerificationRuntimeMeasurementSchema.safeParse(historical).success).toBe(false)
    expect(JobRuntimeMeasurementRecordSchema.parse(historical)).toEqual(historical)
    expect(JobRuntimeFingerprintRecordSchema.parse(historical.fingerprint)).toEqual(historical.fingerprint)
  })
})
