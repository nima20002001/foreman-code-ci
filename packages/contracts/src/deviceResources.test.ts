import { describe, expect, it } from 'vitest'
import { DEVICE_GIB, DEVICE_MIB, DEVICE_RESOURCE_DEFAULTS, DeviceResourceLimitsSchema, DeviceCapacitySchema,
  DeviceProvisioningTargetSchema, DeviceResourcePolicySchema, DeviceResourceReadResultSchema, DeviceResourceUpdateSchema,
  DeviceResourceApplyNowSchema, DeviceResourceUpdateResultSchema, defaultDeviceResourceLimits, deviceResourceLimitIssues } from './deviceResources.js'
import { deviceCapacityFixture as capacity, deviceResourceLimitsFixture as limits, deviceResourcePolicyFixture as policy,
  deviceProvisioningTargetFixture as target, deviceProvisioningResourceFixtures } from './deviceProvisioningFixtures.js'

describe('device resource limits, automatic defaults and growable capacity', () => {
  it('applies half CPU/RAM, pids 1024 and at most 64 GiB, without the obsolete CPU/RAM caps', () => {
    expect(defaultDeviceResourceLimits(capacity)).toEqual(limits)
    expect(DEVICE_RESOURCE_DEFAULTS.pidsLimit).toBe(1024)
    expect(defaultDeviceResourceLimits({ ...capacity, storage: { ...capacity.storage!, hostFreeBytes: 80 * DEVICE_GIB } }))
      .toEqual({ ...limits, diskBytes: 20 * DEVICE_GIB })
  })
  it('rounds defaults down and reports insufficient capacity rather than inventing readiness', () => {
    const available = { ...capacity, ancestorCpuLimit: 5.9, ancestorMemoryBytes: 15 * DEVICE_GIB + DEVICE_MIB,
      hostMemoryReserveBytes: 2 * DEVICE_GIB, maximum: { ...capacity.maximum, cpuLimit: 5.75, memoryBytes: 13 * DEVICE_GIB } }
    expect(defaultDeviceResourceLimits(available)?.cpuLimit).toBe(2.75)
    expect(defaultDeviceResourceLimits(available)?.memoryBytes).toBe(7.5 * DEVICE_GIB)
    expect(defaultDeviceResourceLimits({ ...capacity, storage: { ...capacity.storage!, hostFreeBytes: 4 * DEVICE_GIB } })).toBeNull()
    expect(defaultDeviceResourceLimits({ ...capacity, resourceSettingsSupported: false, storage: null })).toBeNull()
  })
  it.each([
    { cpuLimit: 0 }, { cpuLimit: 0.3 }, { cpuLimit: 257 }, { cpuLimit: Infinity }, { cpuLimit: NaN },
    { memoryBytes: 1 }, { memoryBytes: -1 }, { diskBytes: DEVICE_MIB + 1 }, { diskBytes: Number.MAX_SAFE_INTEGER + 1 },
    { pidsLimit: 1.5 }, { pidsLimit: 0 }, { shell: 'sudo anything' },
  ])('rejects invalid or invented limits %j', change => {
    expect(DeviceResourceLimitsSchema.safeParse({ ...limits, ...change }).success).toBe(false)
  })
  it.each([
    { maximum: { ...capacity.maximum, cpuLimit: 17 } }, { maximum: { ...capacity.maximum, memoryBytes: 32 * DEVICE_GIB } },
    { maximum: { ...capacity.maximum, diskBytes: 256 * DEVICE_GIB } }, { maximum: { ...capacity.maximum, pidsLimit: 4097 } },
    { expiresAt: capacity.observedAt }, { generation: 0 }, { storage: { ...capacity.storage, growable: false } },
    { storage: { ...capacity.storage, path: '/arbitrary' } }, { storage: null },
  ])('rejects fabricated capacity or nongrowable storage %j', change => {
    expect(DeviceCapacitySchema.safeParse({ ...capacity, ...change }).success).toBe(false)
  })
  it('validates submitted values without clamping and protects retained disk usage', () => {
    expect(deviceResourceLimitIssues(limits, capacity)).toEqual([])
    expect(deviceResourceLimitIssues({ ...limits, cpuLimit: 17 }, capacity)).toContainEqual({ field: 'cpuLimit', code: 'over_capacity', remedy: 'lower_limit' })
    expect(deviceResourceLimitIssues({ ...limits, diskBytes: 8 * DEVICE_GIB }, { ...capacity,
      storage: { ...capacity.storage!, projectUsageBytes: 10 * DEVICE_GIB } })).toContainEqual({ field: 'diskBytes', code: 'below_retained_usage', remedy: 'free_managed_data' })
    expect(limits.cpuLimit).toBe(8)
  })
  it('rejects targets with fabricated or partial registration authority', () => {
    expect(DeviceProvisioningTargetSchema.safeParse({ ...target, keyRevision: null }).success).toBe(false)
    expect(DeviceProvisioningTargetSchema.safeParse({ ...target, hostRef: { kind: 'main', mainId: target.hostRef.mainId } }).success).toBe(false)
    expect(DeviceProvisioningTargetSchema.parse({ ...target, hostRef: { kind: 'main', mainId: target.hostRef.mainId }, keyRevision: null, authorizationRevision: null })).toBeTruthy()
  })
})
describe('revisioned desired/effective resource readback and apply now', () => {
  it('parses fixtures, including successful persistence while the original limits remain active', () => {
    for (const fixture of Object.values(deviceProvisioningResourceFixtures)) expect(DeviceResourceReadResultSchema.parse(fixture)).toEqual(fixture)
    const pending = deviceProvisioningResourceFixtures.pending.policy!
    expect(pending.revision).toBe(2)
    expect(pending.effectiveRevision).toBe(1)
    expect(DeviceResourceUpdateResultSchema.parse({ policy: pending, operationId: target.hostRef.mainId })).toBeTruthy()
    expect(DeviceResourceUpdateResultSchema.safeParse({ policy: pending, operationId: null }).success).toBe(false)
  })
  it.each([
    { effectiveRevision: 2 }, { effectivePolicyDigest: 'b'.repeat(64) }, { effective: { ...limits, cpuLimit: 7 } },
    { appliedAt: null }, { effective: null }, { errorCode: 'apply_failed' }, { activeJobCount: 1 },
  ])('rejects mixed or unacknowledged applied evidence %j', change => {
    expect(DeviceResourcePolicySchema.safeParse({ ...policy, ...change }).success).toBe(false)
  })
  it('requires exact target readback', () => {
    expect(DeviceResourceReadResultSchema.safeParse({ policy, capacity: { ...capacity, target: { ...target, authorizationRevision: 2 } } }).success).toBe(false)
  })
  it('supports absent-row initialization and explicitly confirmed stop-and-apply', () => {
    const update = { target, commandId: 'resource-command-1', expectedRevision: 0, expectedCapacityGeneration: 1, limits, applyMode: 'when-idle' }
    expect(DeviceResourceUpdateSchema.parse(update)).toEqual(update)
    expect(DeviceResourceUpdateSchema.parse({ ...update, applyMode: 'stop-jobs-and-apply' }).applyMode).toBe('stop-jobs-and-apply')
    expect(DeviceResourceUpdateSchema.safeParse({ ...update, applyMode: 'immediate-unbounded' }).success).toBe(false)
    const apply = { target, commandId: 'resource-command-2', expectedRevision: 2, expectedCapacityGeneration: 1, stopJobs: true }
    expect(DeviceResourceApplyNowSchema.parse(apply)).toEqual(apply)
    expect(DeviceResourceApplyNowSchema.safeParse({ ...apply, stopJobs: false }).success).toBe(false)
    expect(DeviceResourceApplyNowSchema.safeParse({ ...apply, expectedRevision: 0 }).success).toBe(false)
    expect(DeviceResourceApplyNowSchema.safeParse({ ...apply, limits }).success).toBe(false)
  })
})
