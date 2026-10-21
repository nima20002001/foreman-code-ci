import { describe, expect, it } from 'vitest'
import { DevicePresenceSchema, DeviceSessionBindingSchema } from './deviceConnection.js'
const binding = {
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', bootId: '44444444-4444-4444-8444-444444444444',
  connectionEpoch: '55555555-5555-4555-8555-555555555555', keyRevision: 2, authorizationRevision: 3, connectionGeneration: 4,
}
const presence = { binding, phase: 'ready', dispatch: false, transfer: false, appVersion: 'worker-observed-build', protocolVersion: 1, lastSeenAt: '2026-10-01T06:00:00.000Z' }
describe('canonical authenticated device presence', () => {
  it('serializes the complete observed binding without replacing its distinct revisions', () => {
    expect(DevicePresenceSchema.parse(JSON.parse(JSON.stringify(presence)))).toEqual(presence)
    expect(DeviceSessionBindingSchema.parse(binding)).toEqual(binding)
  })
  it('requires observed app/wire/time facts and rejects private or fabricated fallback fields', () => {
    for (const field of ['appVersion', 'protocolVersion', 'lastSeenAt']) {
      const missing = { ...presence }; delete (missing as Record<string, unknown>)[field]
      expect(DevicePresenceSchema.safeParse(missing).success).toBe(false)
    }
    expect(DevicePresenceSchema.safeParse({ ...presence, protocolVersion: 0 }).success).toBe(false)
    expect(DevicePresenceSchema.safeParse({ ...presence, lastSeenAt: new Date() }).success).toBe(false)
    expect(DevicePresenceSchema.safeParse({ ...presence, credential: 'secret' }).success).toBe(false)
    expect(DevicePresenceSchema.safeParse({ ...presence, binding: { ...binding, connectionGeneration: 0 } }).success).toBe(false)
  })
})
