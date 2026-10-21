import { describe, expect, it } from 'vitest'
import { TelemetryCollectedBatchSchema, TelemetryReadResultSchema, TelemetrySelectorSchema, telemetrySelectorKey } from './resourceTelemetry.js'
import { resourceTelemetryFixtures, telemetryOwnedFixture } from './resourceTelemetryFixtures.js'
describe('ResourceTelemetry v1 CP1', () => {
  it('validates every normative presentation fixture', () => {
    for (const fixture of Object.values(resourceTelemetryFixtures)) expect(TelemetryReadResultSchema.safeParse(fixture).success).toBe(true)
  })
  it('rejects unknown versions/fields, nonfinite and unsafe metric values', () => {
    expect(TelemetrySelectorSchema.safeParse({ ...telemetryOwnedFixture, schemaVersion: 2 }).success).toBe(false)
    const fixture = structuredClone(resourceTelemetryFixtures.freshZero!)
    if (fixture.kind !== 'sample' || fixture.sample.cpu.state !== 'fresh') throw new Error('fixture')
    fixture.sample.cpu.value.hostCapacityPercent = Infinity
    expect(TelemetryReadResultSchema.safeParse(fixture).success).toBe(false)
    expect(TelemetrySelectorSchema.safeParse({ ...telemetryOwnedFixture, pid: 123 }).success).toBe(false)
  })
  it('keys exact attempt, attribution, boot, host and collector generations', () => {
    const key = telemetrySelectorKey(telemetryOwnedFixture)
    expect(key).not.toBe(telemetrySelectorKey({ ...telemetryOwnedFixture, attributionRevision: '2' }))
    expect(key).not.toBe(telemetrySelectorKey({ ...telemetryOwnedFixture, host: { ...telemetryOwnedFixture.host, collectorGeneration: '2' } }))
    expect(key).toBe(telemetrySelectorKey(Object.fromEntries(Object.entries(telemetryOwnedFixture).reverse()) as typeof telemetryOwnedFixture))
  })
  it('rejects cached prechallenge capture and oversized or uint64-overflow batches', () => {
    const selector = telemetryOwnedFixture
    const valid = { schemaVersion: 1, identity: { mainId: selector.mainId, host: selector.host }, challengeId: 'challenge-1', sequence: '1',
      collectedAtUnixMs: 1000, challengeReceivedMonoNs: '2', captureStartMonoNs: '2', captureEndMonoNs: '3', logicalCpuCount: 8,
      host: null, owned: [], diagnostics: [], truncated: false }
    expect(TelemetryCollectedBatchSchema.safeParse(valid).success).toBe(true)
    expect(TelemetryCollectedBatchSchema.safeParse({ ...valid, captureStartMonoNs: '1' }).success).toBe(false)
    expect(TelemetryCollectedBatchSchema.safeParse({ ...valid, sequence: '18446744073709551616' }).success).toBe(false)
    expect(TelemetryCollectedBatchSchema.safeParse({ ...valid, owned: Array(65).fill({}) }).success).toBe(false)
  })
})
