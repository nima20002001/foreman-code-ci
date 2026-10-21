import { describe, expect, it } from 'vitest'
import { ConfiguredHarnessInstanceSchema, HarnessHostReferenceSchema } from './harnessRegistry.js'

describe('public harness registry contracts', () => {
  it('uses canonical main/device references and does not accept an independent host UUID', () => {
    const mainId = '00000000-0000-4000-8000-000000000001'
    expect(HarnessHostReferenceSchema.parse({ kind: 'main', mainId })).toEqual({ kind: 'main', mainId })
    expect(HarnessHostReferenceSchema.safeParse({ hostId: mainId }).success).toBe(false)
  })
  it('keeps unavailable instances visible without exposing opaque configurations', () => {
    const record = { instanceId: 'unknown', instanceRevision: '1', driverId: 'unsupported', enabled: true, availability: 'unknown-driver', configuration: null }
    expect(ConfiguredHarnessInstanceSchema.parse(record)).toEqual(record)
    expect(ConfiguredHarnessInstanceSchema.safeParse({ ...record, configuration: { credential: 'secret' } }).success).toBe(false)
  })
})
