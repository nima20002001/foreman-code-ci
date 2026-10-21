import { z } from 'zod'
import type { CanonicalMachineReference } from './deviceIdentity.js'
import { TimestampSchema } from './schemaPrimitives.js'

export const DEVICE_MIB = 2 ** 20
export const DEVICE_GIB = 2 ** 30
export const DEVICE_RESOURCE_DEFAULTS = Object.freeze({ cpuFraction: 0.5, memoryFraction: 0.5,
  pidsLimit: 1024, diskFraction: 0.25, maximumDefaultDiskBytes: 64 * DEVICE_GIB })
export const DEVICE_RESOURCE_HOST_RESERVE = Object.freeze({ minimumMemoryBytes: DEVICE_GIB, memoryFraction: 0.1 })
export const DEVICE_RESOURCE_CONTROL_RESERVE = Object.freeze({ cpuLimit: 0.25, memoryBytes: 512 * DEVICE_MIB,
  pidsLimit: 64, diskBytes: DEVICE_GIB })
export const DeviceSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const DeviceRevisionSchema = DeviceSafeIntegerSchema.min(1)
export const DeviceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const DeviceReasonCodeSchema = z.enum([
  'not_yet_observed', 'stale_observation', 'device_offline', 'device_revoked', 'device_unavailable', 'connection_binding_changed',
  'unsupported_platform', 'unsupported_resource_settings', 'runtime_missing', 'toolchain_missing', 'harness_dependencies_missing',
  'system_packages_missing', 'service_not_running', 'ci_image_missing', 'image_preparing', 'download_failed', 'release_verification_failed',
  'cpu_delegation_missing', 'memory_delegation_missing', 'pids_delegation_missing', 'controller_missing',
  'storage_quota_missing', 'quota_helper_missing', 'local_admin_required', 'human_approval_required', 'runtime_approval_required',
  'runtime_approval_revoked', 'execution_authorization_missing', 'workspace_approval_required', 'workspace_roots_missing',
  'runtime_unqualified', 'harness_unqualified', 'runtime_fingerprint_changed', 'source_root_not_quota_managed',
  'project_dependency_preparation_required', 'resource_policy_unconfigured', 'capacity_changed', 'insufficient_capacity',
  'insufficient_headroom', 'invalid_resource_limits', 'disk_below_usage', 'policy_pending_drain', 'drain_pending', 'stop_unconfirmed',
  'policy_application_failed', 'policy_recovery_required', 'mixed_enforcement', 'reboot_unverified', 'preparation_failed',
  'repair_failed', 'operation_interrupted', 'operation_recovery_required', 'authorization_revoked', 'principal_denied', 'stale_plan', 'command_conflict',
])
export type DeviceReasonCode = z.infer<typeof DeviceReasonCodeSchema>
export const DeviceCommandIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/)
/** Shared canonical host shape, with no dependency on execution or management modules. */
export const DeviceProvisioningHostReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
]) satisfies z.ZodType<CanonicalMachineReference>
export const DeviceProvisioningTargetSchema = z.object({
  hostRef: DeviceProvisioningHostReferenceSchema, applicationInstallationId: z.uuid(),
  keyRevision: DeviceRevisionSchema.nullable(), authorizationRevision: DeviceRevisionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.hostRef.kind === 'main') !== (value.keyRevision === null && value.authorizationRevision === null)
    || (value.hostRef.kind === 'device' && (value.keyRevision === null || value.authorizationRevision === null)))
    ctx.addIssue({ code: 'custom', message: 'Retain the exact Main or paired device authority.' })
})
export type DeviceProvisioningTarget = z.infer<typeof DeviceProvisioningTargetSchema>
export function sameDeviceProvisioningTarget(a: DeviceProvisioningTarget, b: DeviceProvisioningTarget): boolean {
  return a.hostRef.kind === b.hostRef.kind && a.hostRef.mainId === b.hostRef.mainId
    && (a.hostRef.kind !== 'device' || (b.hostRef.kind === 'device' && a.hostRef.deviceId === b.hostRef.deviceId))
    && a.applicationInstallationId === b.applicationInstallationId && a.keyRevision === b.keyRevision
    && a.authorizationRevision === b.authorizationRevision
}
export const DeviceResourceLimitsSchema = z.object({
  cpuLimit: z.number().finite().positive().max(256).multipleOf(0.25),
  memoryBytes: DeviceSafeIntegerSchema.positive().multipleOf(64 * DEVICE_MIB),
  diskBytes: DeviceSafeIntegerSchema.positive().multipleOf(DEVICE_MIB),
  pidsLimit: DeviceSafeIntegerSchema.positive(),
}).strict()
export type DeviceResourceLimits = z.infer<typeof DeviceResourceLimitsSchema>
const DeviceStorageCapacitySchema = z.object({
  volumeId: z.uuid(), filesystem: z.literal('ext4'), mountIdentityDigest: DeviceDigestSchema,
  volumeCapacityBytes: DeviceSafeIntegerSchema.positive(), usableBytes: DeviceSafeIntegerSchema,
  hostFreeBytes: DeviceSafeIntegerSchema, reservedHostBytes: DeviceSafeIntegerSchema,
  projectUsageBytes: DeviceSafeIntegerSchema, protectedHeadroomBytes: DeviceSafeIntegerSchema,
  setupHeadroomBytes: DeviceSafeIntegerSchema, imageExpandedBytes: DeviceSafeIntegerSchema,
  consentCeilingBytes: DeviceSafeIntegerSchema.positive(), growable: z.literal(true),
  growthMode: z.enum(['extendable-volume', 'sparse-volume', 'filesystem-project-quota']),
  shrinkReclaimsHostSpace: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.usableBytes > value.volumeCapacityBytes || value.projectUsageBytes > value.volumeCapacityBytes)
    ctx.addIssue({ code: 'custom', message: 'Storage measurements exceed the approved volume.' })
})
export const DeviceCapacitySchema = z.object({
  schemaVersion: z.literal(1), target: DeviceProvisioningTargetSchema, generation: DeviceRevisionSchema,
  observedAt: TimestampSchema, expiresAt: TimestampSchema, resourceSettingsSupported: z.boolean(),
  onlineCpuCount: DeviceSafeIntegerSchema.positive(), allowedCpuCount: DeviceSafeIntegerSchema.positive(),
  ancestorCpuLimit: z.number().finite().positive().nullable(), physicalMemoryBytes: DeviceSafeIntegerSchema.positive(),
  ancestorMemoryBytes: DeviceSafeIntegerSchema.positive().nullable(), hostMemoryReserveBytes: DeviceSafeIntegerSchema,
  parentPidsLimit: DeviceSafeIntegerSchema.positive().nullable(), storage: DeviceStorageCapacitySchema.nullable(),
  minimum: DeviceResourceLimitsSchema, maximum: DeviceResourceLimitsSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt))
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Capacity must expire after observation.' })
  const cpu = Math.min(value.onlineCpuCount, value.allowedCpuCount, value.ancestorCpuLimit ?? 256, 256)
  const effectiveMemory = Math.min(value.physicalMemoryBytes, value.ancestorMemoryBytes ?? value.physicalMemoryBytes)
  const memory = effectiveMemory - value.hostMemoryReserveBytes
  if (value.resourceSettingsSupported && value.hostMemoryReserveBytes < Math.max(DEVICE_RESOURCE_HOST_RESERVE.minimumMemoryBytes, effectiveMemory * DEVICE_RESOURCE_HOST_RESERVE.memoryFraction))
    ctx.addIssue({ code: 'custom', path: ['hostMemoryReserveBytes'], message: 'Capacity must retain the shared host memory reserve.' })
  if (value.allowedCpuCount > value.onlineCpuCount || value.maximum.cpuLimit > cpu || value.maximum.memoryBytes > memory
    || (value.parentPidsLimit !== null && value.maximum.pidsLimit > value.parentPidsLimit))
    ctx.addIssue({ code: 'custom', path: ['maximum'], message: 'Capacity cannot exceed current host/ancestor ceilings.' })
  if (value.resourceSettingsSupported && !value.storage)
    ctx.addIssue({ code: 'custom', path: ['storage'], message: 'Resource enforcement needs approved growable storage.' })
  if (value.resourceSettingsSupported && value.storage && value.minimum.diskBytes < value.storage.imageExpandedBytes + DEVICE_RESOURCE_CONTROL_RESERVE.diskBytes)
    ctx.addIssue({ code: 'custom', path: ['minimum', 'diskBytes'], message: 'Disk minimum must fit the measured image and control reserve.' })
  if (value.storage && value.maximum.diskBytes > Math.min(value.storage.usableBytes, value.storage.consentCeilingBytes))
    ctx.addIssue({ code: 'custom', path: ['maximum', 'diskBytes'], message: 'Disk ceiling exceeds approved usable storage.' })
  for (const field of ['cpuLimit', 'memoryBytes', 'diskBytes', 'pidsLimit'] as const) {
    if (value.minimum[field] > value.maximum[field] || value.minimum[field] < DEVICE_RESOURCE_CONTROL_RESERVE[field])
      ctx.addIssue({ code: 'custom', path: ['minimum', field], message: 'Minimum must fit capacity and retain the control reserve.' })
  }
})
type DeviceCapacity = z.infer<typeof DeviceCapacitySchema>
/** Defaults are rounded down to supported increments, never capped at the old 4 CPU/6 GiB defaults. */
export function defaultDeviceResourceLimits(input: DeviceCapacity): DeviceResourceLimits | null {
  const capacity = DeviceCapacitySchema.parse(input)
  if (!capacity.resourceSettingsSupported || !capacity.storage) return null
  const limits = {
    cpuLimit: Math.floor(Math.min(capacity.maximum.cpuLimit,
      Math.min(capacity.allowedCpuCount, capacity.ancestorCpuLimit ?? 256) * DEVICE_RESOURCE_DEFAULTS.cpuFraction) * 4) / 4,
    memoryBytes: Math.floor(Math.min(capacity.maximum.memoryBytes,
      Math.min(capacity.physicalMemoryBytes, capacity.ancestorMemoryBytes ?? capacity.physicalMemoryBytes) * DEVICE_RESOURCE_DEFAULTS.memoryFraction) / (64 * DEVICE_MIB)) * 64 * DEVICE_MIB,
    diskBytes: Math.floor(Math.min(capacity.maximum.diskBytes, DEVICE_RESOURCE_DEFAULTS.maximumDefaultDiskBytes,
      capacity.storage.hostFreeBytes * DEVICE_RESOURCE_DEFAULTS.diskFraction) / DEVICE_MIB) * DEVICE_MIB,
    pidsLimit: Math.min(DEVICE_RESOURCE_DEFAULTS.pidsLimit, capacity.maximum.pidsLimit),
  }
  return deviceResourceLimitIssues(limits, capacity).length ? null : DeviceResourceLimitsSchema.parse(limits)
}
const DeviceResourceFieldSchema = z.enum(['cpuLimit', 'memoryBytes', 'diskBytes', 'pidsLimit'])
type DeviceResourceFieldIssue = {
  field: z.infer<typeof DeviceResourceFieldSchema>
  code: 'invalid_increment' | 'below_minimum' | 'over_capacity' | 'below_retained_usage'
  remedy: 'choose_supported_increment' | 'raise_limit' | 'lower_limit' | 'free_managed_data'
}
export function deviceResourceLimitIssues(limits: DeviceResourceLimits, capacity: DeviceCapacity): DeviceResourceFieldIssue[] {
  const issues: DeviceResourceFieldIssue[] = []
  for (const field of DeviceResourceFieldSchema.options) {
    if (!DeviceResourceLimitsSchema.shape[field].safeParse(limits[field]).success)
      issues.push({ field, code: 'invalid_increment', remedy: 'choose_supported_increment' })
    else if (limits[field] < capacity.minimum[field]) issues.push({ field, code: 'below_minimum', remedy: 'raise_limit' })
    else if (limits[field] > capacity.maximum[field]) issues.push({ field, code: 'over_capacity', remedy: 'lower_limit' })
  }
  if (capacity.storage && limits.diskBytes < capacity.storage.projectUsageBytes + capacity.storage.protectedHeadroomBytes)
    issues.push({ field: 'diskBytes', code: 'below_retained_usage', remedy: 'free_managed_data' })
  return issues
}
const DeviceResourceApplyModeSchema = z.enum(['when-idle', 'stop-jobs-and-apply'])
export const DeviceResourcePolicySchema = z.object({
  schemaVersion: z.literal(1), target: DeviceProvisioningTargetSchema, revision: DeviceRevisionSchema, policyDigest: DeviceDigestSchema,
  desired: DeviceResourceLimitsSchema, effective: DeviceResourceLimitsSchema.nullable(), effectiveRevision: DeviceRevisionSchema.nullable(),
  effectivePolicyDigest: DeviceDigestSchema.nullable(), applyState: z.enum(['pending', 'draining', 'applying', 'applied', 'failed', 'recovery-required']),
  applyMode: DeviceResourceApplyModeSchema, capacityGeneration: DeviceRevisionSchema,
  activeJobCount: DeviceSafeIntegerSchema, activeOperationCount: DeviceSafeIntegerSchema,
  updatedAt: TimestampSchema, appliedAt: TimestampSchema.nullable(), errorCode: DeviceReasonCodeSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.effective === null) !== (value.effectiveRevision === null) || (value.effective === null) !== (value.effectivePolicyDigest === null)
    || (value.effectiveRevision !== null && value.effectiveRevision > value.revision))
    ctx.addIssue({ code: 'custom', message: 'Effective limits retain one proven revision and digest.' })
  if (value.activeJobCount > value.activeOperationCount)
    ctx.addIssue({ code: 'custom', message: 'Active Jobs are included in the drain count.' })
  if (value.applyState === 'applied' && (value.effectiveRevision !== value.revision || value.effectivePolicyDigest !== value.policyDigest
    || !value.appliedAt || !value.effective || DeviceResourceFieldSchema.options.some(field => value.desired[field] !== value.effective?.[field]) || value.errorCode))
    ctx.addIssue({ code: 'custom', message: 'Applied requires the exact acknowledged desired limits, revision and digest.' })
  if (['failed', 'recovery-required'].includes(value.applyState) && !value.errorCode)
    ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'Failed application needs a safe reason.' })
})
export const DeviceResourceReadResultSchema = z.object({ policy: DeviceResourcePolicySchema.nullable(), capacity: DeviceCapacitySchema.nullable() }).strict()
  .superRefine((value, ctx) => {
    if (value.policy && value.capacity && !sameDeviceProvisioningTarget(value.policy.target, value.capacity.target))
      ctx.addIssue({ code: 'custom', message: 'Resource readback must retain one exact target.' })
  })
export const DeviceResourceUpdateSchema = z.object({ target: DeviceProvisioningTargetSchema, commandId: DeviceCommandIdSchema,
  expectedRevision: DeviceSafeIntegerSchema, expectedCapacityGeneration: DeviceRevisionSchema,
  limits: DeviceResourceLimitsSchema, applyMode: DeviceResourceApplyModeSchema,
}).strict()
export const DeviceResourceUpdateResultSchema = z.object({ policy: DeviceResourcePolicySchema, operationId: z.uuid().nullable() }).strict()
  .superRefine((value, ctx) => {
    if (value.operationId === null && value.policy.applyState !== 'applied')
      ctx.addIssue({ code: 'custom', message: 'Unapplied policy requires a durable application operation.' })
  })
/** Apply the already saved revision; does not silently resubmit or replace a draft. Requires settings:update + jobs:cancel. */
export const DeviceResourceApplyNowSchema = z.object({ target: DeviceProvisioningTargetSchema, commandId: DeviceCommandIdSchema,
  expectedRevision: DeviceRevisionSchema, expectedCapacityGeneration: DeviceRevisionSchema, stopJobs: z.literal(true),
}).strict()
/** Immutable acceptance facts. Optional historical pairs must never be interpreted as enforced policy. */
export const DeviceResourceAdmissionSchema = z.object({ resourcePolicyRevision: DeviceRevisionSchema, resourcePolicyDigest: DeviceDigestSchema }).strict()

export const DeviceExecutionAdmissionSchema = DeviceResourceAdmissionSchema.extend({
  runtimeApprovalId: z.uuid(), runtimeApprovalRevision: DeviceRevisionSchema,
}).strict()
export const DeviceExecutionAdmissionFields = DeviceExecutionAdmissionSchema.shape
export const HistoricalDeviceExecutionAdmissionFields = {
  resourcePolicyRevision: DeviceRevisionSchema.optional(), resourcePolicyDigest: DeviceDigestSchema.optional(),
  runtimeApprovalId: z.uuid().optional(), runtimeApprovalRevision: DeviceRevisionSchema.optional(),
}
type DeviceExecutionAdmission = z.infer<typeof DeviceExecutionAdmissionSchema>
type HistoricalDeviceExecutionAdmission = {
  [Field in keyof DeviceExecutionAdmission]?: DeviceExecutionAdmission[Field] | undefined
}
export function validateHistoricalDeviceExecutionAdmission(
  value: HistoricalDeviceExecutionAdmission, ctx: z.RefinementCtx,
): void {
  const fields = Object.keys(DeviceExecutionAdmissionFields) as (keyof DeviceExecutionAdmission)[]
  if (fields.some(field => value[field] !== undefined) && fields.some(field => value[field] === undefined))
    ctx.addIssue({ code: 'custom', message: 'Historical admission is absent or retains a complete policy and device approval reference.' })
}
