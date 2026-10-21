import { DEVICE_GIB, DeviceCapacitySchema, DeviceResourcePolicySchema, DeviceResourceReadResultSchema } from './deviceResources.js'

// Deterministic contract fixtures, not measurements, credentials, or proof of a real prepared computer.
const id = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const installationId = '33333333-3333-4333-8333-333333333333'
const operationId = '44444444-4444-4444-8444-444444444444'
const digest = 'a'.repeat(64)
const observedAt = '2026-10-02T18:00:00.000Z', expiresAt = '2026-10-02T18:01:30.000Z'
export const deviceProvisioningTargetFixture = { hostRef: { kind: 'device' as const, mainId: id, deviceId },
  applicationInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 }
export const deviceResourceLimitsFixture = { cpuLimit: 8, memoryBytes: 16 * DEVICE_GIB, diskBytes: 64 * DEVICE_GIB, pidsLimit: 1024 }
export const deviceCapacityFixture = DeviceCapacitySchema.parse({ schemaVersion: 1, target: deviceProvisioningTargetFixture,
  generation: 1, observedAt, expiresAt, resourceSettingsSupported: true,
  onlineCpuCount: 16, allowedCpuCount: 16, ancestorCpuLimit: null, physicalMemoryBytes: 32 * DEVICE_GIB,
  ancestorMemoryBytes: null, hostMemoryReserveBytes: 4 * DEVICE_GIB, parentPidsLimit: 4096,
  storage: { volumeId: operationId, filesystem: 'ext4', mountIdentityDigest: digest, volumeCapacityBytes: 256 * DEVICE_GIB,
    usableBytes: 240 * DEVICE_GIB, hostFreeBytes: 512 * DEVICE_GIB, reservedHostBytes: 64 * DEVICE_GIB,
    projectUsageBytes: 4 * DEVICE_GIB, protectedHeadroomBytes: DEVICE_GIB, setupHeadroomBytes: 8 * DEVICE_GIB,
    imageExpandedBytes: 4 * DEVICE_GIB, consentCeilingBytes: 240 * DEVICE_GIB, growable: true,
    growthMode: 'extendable-volume', shrinkReclaimsHostSpace: false },
  minimum: { cpuLimit: 0.25, memoryBytes: 512 * 2 ** 20, diskBytes: 8 * DEVICE_GIB, pidsLimit: 64 },
  maximum: { cpuLimit: 16, memoryBytes: 28 * DEVICE_GIB, diskBytes: 240 * DEVICE_GIB, pidsLimit: 4096 },
})
export const deviceResourcePolicyFixture = DeviceResourcePolicySchema.parse({ schemaVersion: 1, target: deviceProvisioningTargetFixture,
  revision: 1, policyDigest: digest, desired: deviceResourceLimitsFixture, effective: deviceResourceLimitsFixture,
  effectiveRevision: 1, effectivePolicyDigest: digest, applyState: 'applied', applyMode: 'when-idle', capacityGeneration: 1,
  activeJobCount: 0, activeOperationCount: 0, updatedAt: observedAt, appliedAt: observedAt, errorCode: null })
const pendingPolicy = DeviceResourcePolicySchema.parse({ ...deviceResourcePolicyFixture, revision: 2, policyDigest: 'b'.repeat(64),
  desired: { ...deviceResourceLimitsFixture, cpuLimit: 6 }, applyState: 'pending', activeJobCount: 2, activeOperationCount: 3 })
export const deviceProvisioningResourceFixtures = {
  applied: DeviceResourceReadResultSchema.parse({ policy: deviceResourcePolicyFixture, capacity: deviceCapacityFixture }),
  unconfigured: DeviceResourceReadResultSchema.parse({ policy: null, capacity: deviceCapacityFixture }),
  pending: DeviceResourceReadResultSchema.parse({ policy: pendingPolicy, capacity: deviceCapacityFixture }),
  unsupportedMain: DeviceResourceReadResultSchema.parse({ policy: null, capacity: null }),
}
