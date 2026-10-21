import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { DeviceResourceLimitsSchema, DeviceExecutionAdmissionFields, HistoricalDeviceExecutionAdmissionFields,
  DeviceSafeIntegerSchema, DeviceRevisionSchema, DEVICE_RESOURCE_CONTROL_RESERVE, validateHistoricalDeviceExecutionAdmission } from './deviceResources.js'
import { JobPolicySchema, JobTargetSchema, JobRuntimeLimitsSchema } from './jobs.js'
export { JobRuntimeLimitsSchema } from './jobs.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
const Digest=z.string().regex(/^[a-f0-9]{64}$/)
export const JOB_RUNTIME_WORKSPACE_LAYOUT='source-inputs-private-git-scheduler-v1' as const
// Missing/unsupported layout stays readable in immutable history. Never default
// it to the current layout: admission uses the Current schemas/issue below.
const HistoricalWorkspaceLayout=z.string().min(1).max(200).optional()
export const JobRuntimeQualificationSpoolBytesSchema=z.number().int().min(131072).max(67108864)
/** Policy metadata refers to an existing authorized root, never a caller filesystem path. */
export const JobRuntimeProfileInputSchema=z.object({rootId:z.uuid(),bindingRevision:z.number().int().positive(),limits:JobRuntimeLimitsSchema,
  policy:JobPolicySchema.omit({isolationPolicyId:true,isolationPolicyRevision:true}).extend({maxWorkerSpoolBytes:JobRuntimeQualificationSpoolBytesSchema}),
}).strict().superRefine((value,ctx)=>{
  if(value.policy.network!=='none'||value.policy.environmentScopeRefs.length)ctx.addIssue({code:'custom',path:['policy'],message:'This qualified noninteractive profile requires no network or credential environment.'})
  if(value.policy.maxWorkerSpoolBytes>value.limits.diskBytes||value.policy.maxOutputBytes>value.limits.diskBytes)ctx.addIssue({code:'custom',path:['policy'],message:'Declared spool/output budgets exceed the qualified filesystem limit.'})
})
export const JOB_RUNTIME_PROVISIONING_SUITE = 'rootless-podman-ext4-project-quota-private-git-v3' as const
/** Host volume geometry and mutable quota are distinct; diskBytes is an admitted Job reservation. */
export const JobRuntimeProjectQuotaSchema = z.object({
  volumeId: z.uuid(), mountIdentityDigest: Digest, volumeCapacityBytes: DeviceSafeIntegerSchema.positive(),
  growthMode: z.enum(['extendable-volume', 'sparse-volume', 'filesystem-project-quota']), reservedHostBytes: DeviceSafeIntegerSchema,
  controlProjectId: DeviceRevisionSchema.max(4294967295), workloadProjectId: DeviceRevisionSchema.max(4294967295),
  controlHardLimitBytes: DeviceSafeIntegerSchema.positive().multipleOf(1048576), controlUsageBytes: DeviceSafeIntegerSchema,
  workloadHardLimitBytes: DeviceSafeIntegerSchema.positive().multipleOf(1048576), workloadUsageBytes: DeviceSafeIntegerSchema,
  controlHardInodes: DeviceRevisionSchema, controlUsedInodes: DeviceSafeIntegerSchema,
  workloadHardInodes: DeviceRevisionSchema, workloadUsedInodes: DeviceSafeIntegerSchema,
  quotaRevision: DeviceRevisionSchema, quotaDigest: Digest,
  accountingEnabled: z.literal(true), enforcementEnabled: z.literal(true), inheritanceVerified: z.literal(true), rootlessAccountingVerified: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.controlProjectId === value.workloadProjectId
    || value.controlHardLimitBytes + value.workloadHardLimitBytes > value.volumeCapacityBytes
    || value.controlUsageBytes > value.controlHardLimitBytes || value.workloadUsageBytes > value.workloadHardLimitBytes
    || value.controlUsedInodes > value.controlHardInodes || value.workloadUsedInodes > value.workloadHardInodes)
    ctx.addIssue({ code: 'custom', message: 'Project quota identities and readback must fit actual approved volume geometry.' })
})
const ProvisionedRuntimeFields = { ...DeviceExecutionAdmissionFields, provisioningSuite: z.literal(JOB_RUNTIME_PROVISIONING_SUITE),
  deviceLimits: DeviceResourceLimitsSchema, quota: JobRuntimeProjectQuotaSchema, aggregateCgroupIdentityDigest: Digest,
  imageManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageConfigDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}
const HistoricalProvisionedRuntimeFields = { ...HistoricalDeviceExecutionAdmissionFields,
  provisioningSuite: z.literal(JOB_RUNTIME_PROVISIONING_SUITE).optional(), deviceLimits: DeviceResourceLimitsSchema.optional(),
  quota: JobRuntimeProjectQuotaSchema.optional(), aggregateCgroupIdentityDigest: Digest.optional(),
  imageManifestDigest: ProvisionedRuntimeFields.imageManifestDigest.optional(), imageConfigDigest: ProvisionedRuntimeFields.imageConfigDigest.optional(),
}
export function validateProvisionedRuntime(value: { cpuLimit: number; memoryBytes: number; pidsLimit: number; diskBytes: number;
  imageDigest: string } & Partial<z.infer<typeof zProvisionedFields>>, ctx: z.RefinementCtx): void {
  if (!value.deviceLimits || !value.quota) return
  const reserve = DEVICE_RESOURCE_CONTROL_RESERVE
  if (value.cpuLimit > value.deviceLimits.cpuLimit - reserve.cpuLimit || value.memoryBytes > value.deviceLimits.memoryBytes - reserve.memoryBytes
    || value.pidsLimit > value.deviceLimits.pidsLimit - reserve.pidsLimit || value.diskBytes > value.quota.workloadHardLimitBytes
    || value.quota.controlHardLimitBytes < reserve.diskBytes
    || value.quota.controlHardLimitBytes + value.quota.workloadHardLimitBytes > value.deviceLimits.diskBytes
    || value.imageDigest !== value.imageConfigDigest)
    ctx.addIssue({ code: 'custom', message: 'Job reservation and quota must fit the enforced device allowance and retain control headroom.' })
}
const zProvisionedFields = z.object(ProvisionedRuntimeFields)
function validateHistoricalProvisionedRuntime(value: Partial<z.infer<typeof zProvisionedFields>>, ctx: z.RefinementCtx): void {
  validateHistoricalDeviceExecutionAdmission(value, ctx)
  if (Object.keys(ProvisionedRuntimeFields).some(field => value[field as keyof typeof ProvisionedRuntimeFields] !== undefined)
    && !zProvisionedFields.safeParse(value).success)
    ctx.addIssue({ code: 'custom', message: 'Provisioned history retains the complete quota-v3 policy, approval, image and enforcement facts.' })
}
export const QualifiedJobRuntimeSchema=JobRuntimeLimitsSchema.extend({...HistoricalProvisionedRuntimeFields,policyId:IdSchema,policyRevision:z.number().int().positive(),imageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),toolchainDigest:Digest,
  runtimeVersion:z.string().min(1).max(200),ociRuntimeVersion:z.string().min(1).max(200),kernelVersion:z.string().min(1).max(200),qualificationId:IdSchema,
  rootless:z.literal(true),cgroupV2:z.literal(true),filesystemBounded:z.literal(true),descendantContainment:z.literal(true),network:z.literal('none'),
  workspaceLayout:HistoricalWorkspaceLayout,
}).strict().superRefine(validateHistoricalProvisionedRuntime)
export const CurrentQualifiedJobRuntimeSchema=QualifiedJobRuntimeSchema.safeExtend({workspaceLayout:z.literal(JOB_RUNTIME_WORKSPACE_LAYOUT)}).strict()
export const JobRuntimeFingerprintSchema=z.object({...HistoricalProvisionedRuntimeFields,schemaVersion:z.union([z.literal(1),z.literal(2)]),profileId:IdSchema,profileRevision:z.number().int().positive(),specDigest:Digest,
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,mainInstallationId:IdSchema,bootId:z.uuid(),
  root:SourceRootRecordSchema,runtimeExecutable:z.string().startsWith('/'),runtimeBinarySha256:Digest,ociExecutable:z.string().startsWith('/'),ociBinarySha256:Digest,configurationDigest:Digest,
  imageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),toolchainDigest:Digest,limits:JobRuntimeLimitsSchema,
  workspaceLayout:HistoricalWorkspaceLayout,
}).strict().superRefine((value, ctx) => {
  validateHistoricalProvisionedRuntime(value, ctx)
  if ((value.schemaVersion === 2) !== (value.provisioningSuite !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Quota-v3 fingerprints require their own complete version 2 shape.' })
})
export const CurrentJobRuntimeFingerprintSchema=JobRuntimeFingerprintSchema.safeExtend({workspaceLayout:z.literal(JOB_RUNTIME_WORKSPACE_LAYOUT)}).strict()
/** The exact captured candidate a CI qualification runs against. A paired, authorized computer is a build
 * machine: capture is followed directly by qualification, with no approval step. Rows written before approval
 * was removed may still carry 'awaiting-approval'/'approved' and approver fields; they read as captured. */
export const JobRuntimeApprovalSchema=z.object({schemaVersion:z.literal(1),id:z.uuid(),qualificationId:z.uuid(),workspaceId:IdSchema,profileId:IdSchema,profileRevision:z.number().int().positive(),
  fingerprint:JobRuntimeFingerprintSchema,fingerprintDigest:Digest,requestedByPrincipalId:IdSchema,
  status:z.enum(['captured','awaiting-approval','approved','qualifying','complete','failed','cancelled','recovery-required']),
  approvedByPrincipalId:IdSchema.nullable().optional(),approvedAt:TimestampSchema.nullable().optional(),expiresAt:TimestampSchema,
}).strict()
/** Trusted admission retained on the original captured qualification row.
 * A diagnostic is its own subject; it never borrows a workflow grant or Job ID.
 * Public profile/request inputs do not accept this internal authority. */
const JobRuntimeNativeAdmissionFieldsSchema=z.object({...HistoricalDeviceExecutionAdmissionFields,schemaVersion:z.union([z.literal(1),z.literal(2)]),kind:z.literal('job-runtime-qualification'),
  approvalId:z.uuid(),qualificationId:z.uuid(),operationId:z.uuid(),workspaceId:IdSchema,profileId:IdSchema,profileRevision:z.number().int().positive(),
  fingerprintDigest:Digest,leaseId:z.uuid(),runCommandId:IdSchema,runPrincipalId:IdSchema,approvedByPrincipalId:IdSchema.optional(),
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,mainInstallationId:IdSchema,bootId:z.uuid(),
  connection:DeviceSessionBindingSchema.nullable(),admittedAt:TimestampSchema,expiresAt:TimestampSchema,
}).strict()
export const JobRuntimeNativeAdmissionSchema=JobRuntimeNativeAdmissionFieldsSchema.superRefine((value,ctx)=>{
  validateHistoricalDeviceExecutionAdmission(value,ctx)
  if ((value.schemaVersion === 2) !== (value.resourcePolicyRevision !== undefined))
    ctx.addIssue({code:'custom',message:'Provisioned diagnostic admission requires its complete version 2 policy and approval.'})
  validateJobRuntimeNativeContext(value,ctx)
})
export function validateJobRuntimeNativeContext(
  value: Omit<z.infer<typeof JobRuntimeNativeAdmissionFieldsSchema>, 'schemaVersion'>,
  ctx: z.RefinementCtx,
): void {
  if(value.operationId!==value.qualificationId||value.hostRef.mainId!==value.mainInstallationId)
    ctx.addIssue({code:'custom',message:'Admission must retain the original qualification and Main installation.'})
  if(Date.parse(value.expiresAt)<=Date.parse(value.admittedAt))
    ctx.addIssue({code:'custom',message:'Admission must expire after reservation.'})
  if(value.hostRef.kind==='main') {
    if(value.registration!==null||value.connection!==null)
      ctx.addIssue({code:'custom',message:'Main-local admission cannot carry worker authority.'})
  } else if(!value.registration||!value.connection||value.connection.mainId!==value.mainInstallationId||value.connection.deviceId!==value.hostRef.deviceId||
    value.connection.workerInstallationId!==value.registration.workerInstallationId||value.connection.keyRevision!==value.registration.keyRevision||
    value.connection.authorizationRevision!==value.registration.authorizationRevision||value.connection.bootId!==value.bootId)
    ctx.addIssue({code:'custom',message:'Admission must retain the exact authenticated worker binding.'})
}
export const CurrentJobRuntimeNativeAdmissionSchema=JobRuntimeNativeAdmissionSchema.safeExtend({schemaVersion:z.literal(2),...DeviceExecutionAdmissionFields})
export type JobRuntimeNativeAdmission=z.infer<typeof JobRuntimeNativeAdmissionSchema>
/** A host producer supplies actual measured evidence. Public save input admits no ready/approval/proof fields. */
export const JobRuntimeMeasurementSchema=z.object({schemaVersion:z.literal(1),qualificationId:z.uuid(),profileId:IdSchema,profileRevision:z.number().int().positive(),specDigest:Digest,
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,root:SourceRootRecordSchema,
  runtime:QualifiedJobRuntimeSchema,runtimeBinarySha256:Digest,ociBinarySha256:Digest,runtimeExecutable:z.string().startsWith('/'),
  environment:z.record(z.enum(['PATH','XDG_RUNTIME_DIR','LANG']),z.string()),
  fingerprint:JobRuntimeFingerprintSchema,fingerprintDigest:Digest,approvalId:z.uuid(),
  origin:z.literal('real-runtime'),checkedAt:TimestampSchema,expiresAt:TimestampSchema,
  checks:z.array(z.object({id:z.enum(['rootless','cgroup-v2','filesystem-quota','descendant-containment','network-none','image-toolchain','credential-isolation']),passed:z.boolean(),evidenceDigest:Digest}).strict()).min(7).max(7),
}).strict().superRefine((value,ctx)=>{
  if(Date.parse(value.expiresAt)<=Date.parse(value.checkedAt))ctx.addIssue({code:'custom',path:['expiresAt'],message:'Qualification evidence must expire after its actual check.'})
  if(new Set(value.checks.map(check=>check.id)).size!==7||value.checks.some(check=>!check.passed))ctx.addIssue({code:'custom',path:['checks'],message:'Every exact real-runtime qualification check must pass.'})
  if(value.runtime.policyId!==value.profileId||value.runtime.policyRevision!==value.profileRevision||value.runtime.qualificationId!==value.qualificationId)ctx.addIssue({code:'custom',message:'Qualification identity differs from its actual profile.'})
  if(value.runtime.workspaceLayout!==value.fingerprint.workspaceLayout)ctx.addIssue({code:'custom',message:'Runtime and approved fingerprint workspace layouts differ.'})
})
export const CurrentJobRuntimeMeasurementSchema=JobRuntimeMeasurementSchema.safeExtend({
  runtime:CurrentQualifiedJobRuntimeSchema,fingerprint:CurrentJobRuntimeFingerprintSchema,
})
export const JobRuntimeProfileSchema=z.object({schemaVersion:z.literal(1),id:IdSchema,workspaceId:IdSchema,revision:z.number().int().positive(),name:z.string().trim().min(1).max(200),
  root:SourceRootRecordSchema,policy:JobPolicySchema,limits:JobRuntimeLimitsSchema,specDigest:Digest,
  status:z.enum(['unqualified','captured','awaiting-approval','qualifying','qualified','failed','revoked','recovery-required']),
  measurement:JobRuntimeMeasurementSchema.nullable(),createdAt:TimestampSchema,updatedAt:TimestampSchema,
  activeQualificationId:z.uuid().optional(),
}).strict()
/** Scoped metadata read; listing pending approvals performs no qualification or repair. */
export const JobRuntimeProfileListSchema = z.object({
  profiles: z.array(z.object({ profile: JobRuntimeProfileSchema, ready: z.boolean(), reasons: z.array(z.string()), sideEffects: z.literal(false) }).strict()),
  approvals: z.array(JobRuntimeApprovalSchema),
}).strict()
export const JobRuntimeProfileSaveSchema=z.object({commandId:optionalCommandId(IdSchema),id:IdSchema.optional(),expectedRevision:z.number().int().positive().nullable(),name:z.string().trim().min(1).max(200),spec:JobRuntimeProfileInputSchema}).strict()
export const JobRuntimeQualificationRequestSchema=z.object({commandId:optionalCommandId(IdSchema),profileId:IdSchema,expectedRevision:z.number().int().positive()}).strict()
export type JobRuntimeProfile=z.infer<typeof JobRuntimeProfileSchema>
export type JobRuntimeMeasurement=z.infer<typeof JobRuntimeMeasurementSchema>
type QualifiedJobRuntime=z.infer<typeof QualifiedJobRuntimeSchema>

export type JobRuntimeFingerprint=z.infer<typeof JobRuntimeFingerprintSchema>
export type JobRuntimeApproval=z.infer<typeof JobRuntimeApprovalSchema>
/** Readiness/admission can explain stale history without reparsing it as a new layout or mutating saved facts. */
export function jobRuntimeWorkspaceLayoutIssue(runtime:Pick<QualifiedJobRuntime,'workspaceLayout'>,
  fingerprint:Pick<JobRuntimeFingerprint,'workspaceLayout'>):'unsupported_workspace_layout'|null {
  return runtime.workspaceLayout===JOB_RUNTIME_WORKSPACE_LAYOUT&&fingerprint.workspaceLayout===JOB_RUNTIME_WORKSPACE_LAYOUT
    ?null:'unsupported_workspace_layout'
}

export const JobRuntimeQualificationReadSchema=z.object({approval:JobRuntimeApprovalSchema,nativeAdmission:JobRuntimeNativeAdmissionSchema.nullable(),measurement:JobRuntimeMeasurementSchema.nullable(),profile:JobRuntimeProfileSchema,readiness:z.object({ready:z.boolean(),reasons:z.array(z.string()),sideEffects:z.literal(false)}).strict()}).strict()
export const JobRuntimeQualificationCommandSchema=z.object({commandId:optionalCommandId(IdSchema)}).strict()
const QualificationPath=z.string().startsWith('/').refine(value=>!value.includes('\0')&&!value.includes('\n')&&!value.includes(','))
const QualificationEnvironment=z.object({PATH:z.string().min(1),XDG_RUNTIME_DIR:QualificationPath,LANG:z.literal('C.UTF-8')}).strict()
export const InstalledJobRuntimeDescriptorSchema=z.object({
  target:z.object({hostRef:JobRuntimeFingerprintSchema.shape.hostRef,registration:JobRuntimeFingerprintSchema.shape.registration,
    mainInstallationId:JobRuntimeFingerprintSchema.shape.mainInstallationId}).strict(),
  runtimeExecutable:QualificationPath,ociExecutable:QualificationPath,findmntExecutable:QualificationPath,findmntBinarySha256:Digest,
  runtimeRoot:QualificationPath,backingFile:QualificationPath,controllerEnvironment:QualificationEnvironment,
}).strict()
export type InstalledJobRuntimeDescriptor=z.infer<typeof InstalledJobRuntimeDescriptorSchema>
export const JobQualificationCandidateSchema=z.object({qualificationId:z.uuid(),operationId:z.uuid(),approvalId:z.uuid(),
  fingerprint:JobRuntimeFingerprintSchema,findmntBinary:QualificationPath,findmntBinarySha256:Digest,
  backingFile:QualificationPath,backingBytes:z.number().int().positive(),controllerEnvironment:QualificationEnvironment,
  sourceParent:QualificationPath,runtimeRoot:QualificationPath,spoolBytes:JobRuntimeQualificationSpoolBytesSchema,
  ttlSeconds:z.number().int().positive().max(86400),
}).strict().superRefine((value,ctx)=>{
  if(value.fingerprint.root.binding.accessMode!=='exclusive-write'||value.sourceParent!==value.fingerprint.root.binding.canonicalPath)
    ctx.addIssue({code:'custom',message:'Qualification requires the exact existing exclusive-write root binding.'})
})
export type JobQualificationCandidate=z.infer<typeof JobQualificationCandidateSchema>
export const JobRuntimeQualificationResultSchema=z.discriminatedUnion('outcome',[
  z.object({outcome:z.literal('qualified'),measurement:JobRuntimeMeasurementSchema}).strict(),
  z.object({outcome:z.literal('denied'),closure:z.enum(['not_started','confirmed','unconfirmed']),reasons:z.array(z.string().max(500)).max(128)}).strict(),
])
export const JobRuntimeQualificationRpcRequestSchema=z.discriminatedUnion('operation',[
  z.object({version:z.literal(1),operation:z.literal('inspect'),profile:JobRuntimeProfileSchema}).strict(),
  z.object({version:z.literal(1),operation:z.enum(['run','authorize']),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema}).strict(),
])
export const JobRuntimeQualificationRpcResponseSchema=z.discriminatedUnion('operation',[
  z.object({version:z.literal(1),operation:z.literal('inspect'),descriptor:InstalledJobRuntimeDescriptorSchema,fingerprint:JobRuntimeFingerprintSchema}).strict(),
  z.object({version:z.literal(1),operation:z.literal('run'),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema,result:JobRuntimeQualificationResultSchema}).strict(),
  z.object({version:z.literal(1),operation:z.literal('authorize'),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema,
    approval:z.object({status:z.literal('approved'),fingerprint:Digest,expiresAt:TimestampSchema}).strict()}).strict(),
])
export const JOB_RUNTIME_QUALIFICATION_EXTENSION=Object.freeze({namespace:'job-runtime-qualification-v1',version:1 as const,maxJsonBytes:1048576,maxBinaryBytes:1048576})

/** Current layout schemas above also parse saved v2 history. New provisioned entry uses these required v3 schemas. */
export const ProvisionedQualifiedJobRuntimeSchema = CurrentQualifiedJobRuntimeSchema.safeExtend(ProvisionedRuntimeFields)
  .superRefine(validateProvisionedRuntime)
export const ProvisionedJobRuntimeFingerprintSchema = CurrentJobRuntimeFingerprintSchema.safeExtend({
  schemaVersion: z.literal(2), ...ProvisionedRuntimeFields,
}).superRefine((value, ctx) => validateProvisionedRuntime({ ...value.limits, ...value }, ctx))
export const ProvisionedJobRuntimeMeasurementSchema = JobRuntimeMeasurementSchema.safeExtend({
  runtime: ProvisionedQualifiedJobRuntimeSchema, fingerprint: ProvisionedJobRuntimeFingerprintSchema,
}).superRefine((value, ctx) => {
  const runtime = value.runtime, fingerprint = value.fingerprint
  if (Object.keys(ProvisionedRuntimeFields).some(field => JSON.stringify(runtime[field as keyof typeof ProvisionedRuntimeFields])
    !== JSON.stringify(fingerprint[field as keyof typeof ProvisionedRuntimeFields])))
    ctx.addIssue({ code: 'custom', message: 'Actual runtime and approved fingerprint must retain identical quota-v3 admission facts.' })
})
export const ProvisionedInstalledJobRuntimeDescriptorSchema = z.object({ ...InstalledJobRuntimeDescriptorSchema.shape,
  backingFile: QualificationPath.nullable(), volumeCapacityBytes: DeviceSafeIntegerSchema.positive(),
  quota: JobRuntimeProjectQuotaSchema, ...DeviceExecutionAdmissionFields, aggregateCgroupIdentityDigest: Digest,
}).strict().superRefine((value, ctx) => {
  if (value.volumeCapacityBytes !== value.quota.volumeCapacityBytes || value.backingFile === null && value.quota.growthMode !== 'filesystem-project-quota')
    ctx.addIssue({ code: 'custom', message: 'Installed geometry must match the approved storage mode and quota volume.' })
})
export const ProvisionedJobQualificationCandidateSchema = z.object({ ...JobQualificationCandidateSchema.shape,
  fingerprint: ProvisionedJobRuntimeFingerprintSchema, backingFile: QualificationPath.nullable(),
  backingBytes: DeviceSafeIntegerSchema.positive().nullable(), volumeCapacityBytes: DeviceSafeIntegerSchema.positive(),
}).strict().superRefine((value, ctx) => {
  if (value.fingerprint.root.binding.accessMode !== 'exclusive-write' || value.sourceParent !== value.fingerprint.root.binding.canonicalPath)
    ctx.addIssue({ code: 'custom', message: 'Qualification requires the exact existing exclusive-write root binding.' })
  if (value.volumeCapacityBytes !== value.fingerprint.quota.volumeCapacityBytes
    || (value.backingFile === null) !== (value.backingBytes === null)
    || value.backingFile === null && value.fingerprint.quota.growthMode !== 'filesystem-project-quota'
    || value.backingBytes !== null && value.backingBytes !== value.volumeCapacityBytes)
    ctx.addIssue({ code: 'custom', message: 'Quota-v3 geometry validates volume capacity independently from the Job disk reservation.' })
})
const ProvisionedJobRuntimeQualificationResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('qualified'), measurement: ProvisionedJobRuntimeMeasurementSchema }).strict(),
  JobRuntimeQualificationResultSchema.options[1],
])
export const ProvisionedJobRuntimeQualificationRpcRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(2), operation: z.literal('inspect'), profile: JobRuntimeProfileSchema }).strict(),
  z.object({ version: z.literal(2), operation: z.enum(['run', 'authorize']), admission: CurrentJobRuntimeNativeAdmissionSchema,
    candidate: ProvisionedJobQualificationCandidateSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.operation === 'inspect') return
  if (value.admission.qualificationId !== value.candidate.qualificationId || value.admission.operationId !== value.candidate.operationId
    || value.admission.approvalId !== value.candidate.approvalId
    || Object.keys(DeviceExecutionAdmissionFields).some(field => value.admission[field as keyof typeof DeviceExecutionAdmissionFields]
      !== value.candidate.fingerprint[field as keyof typeof DeviceExecutionAdmissionFields]))
    ctx.addIssue({ code: 'custom', message: 'Qualification wire entry must retain original diagnostic, policy and device approval authority.' })
})
export const ProvisionedJobRuntimeQualificationRpcResponseSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(2), operation: z.literal('inspect'), descriptor: ProvisionedInstalledJobRuntimeDescriptorSchema,
    fingerprint: ProvisionedJobRuntimeFingerprintSchema }).strict(),
  z.object({ version: z.literal(2), operation: z.literal('run'), admission: CurrentJobRuntimeNativeAdmissionSchema,
    candidate: ProvisionedJobQualificationCandidateSchema, result: ProvisionedJobRuntimeQualificationResultSchema }).strict(),
  z.object({ version: z.literal(2), operation: z.literal('authorize'), admission: CurrentJobRuntimeNativeAdmissionSchema,
    candidate: ProvisionedJobQualificationCandidateSchema,
    approval: z.object({ status: z.literal('approved'), fingerprint: Digest, expiresAt: TimestampSchema }).strict() }).strict(),
])
export const JOB_RUNTIME_PROVISIONED_QUALIFICATION_EXTENSION = Object.freeze({ namespace: 'job-runtime-qualification-v2',
  version: 2 as const, maxJsonBytes: 1048576, maxBinaryBytes: 0 })
