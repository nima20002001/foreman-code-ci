import { z } from 'zod'
import {
  DeviceExecutionAdmissionFields,
  HistoricalDeviceExecutionAdmissionFields,
  validateHistoricalDeviceExecutionAdmission,
} from './deviceResources.js'
import { JobExecutionSchema, CurrentJobExecutionSchema, JobLogChunkSchema, type JobExecution } from './jobs.js'
import { PlacementDigestSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { RemoteOperationPhaseSchema } from './remoteOperationPhase.js'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from './sourceAdmission.js'
import { JobExecutionRecordSchema, VerificationJobExecutionSchema, type JobExecutionRecord } from './jobVerification.js'

/** New job envelopes use genuine subjects; existing workflow dispatch contracts are unchanged. */
const RemoteExecutionSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow-node'), workspaceId: z.string().min(1), workflowId: z.string().min(1),
    runId: z.string().min(1), nodeId: z.string().min(1), nodeExecutionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('manual-job'), workspaceId: z.string().min(1), jobExecutionId: z.string().min(1), definitionId: z.string().min(1) }).strict(),
])
export const RemoteJobDispatchIntentSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), mainId: z.uuid(), subject: RemoteExecutionSubjectSchema,
  executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1),
  ...HistoricalDeviceExecutionAdmissionFields,
  bindingHash: PlacementDigestSchema, inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  owner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
}).strict().superRefine((intent, context) => {
  validateHistoricalDeviceExecutionAdmission(intent, context)
  if (intent.subject.kind === 'manual-job' && intent.subject.jobExecutionId !== intent.executionId) context.addIssue({ code: 'custom', message: 'Manual job subject must name its actual execution.' })
})
export const CurrentRemoteJobDispatchIntentSchema = RemoteJobDispatchIntentSchema.safeExtend(DeviceExecutionAdmissionFields)
export type RemoteJobDispatchIntent = z.infer<typeof RemoteJobDispatchIntentSchema>
export const RemoteJobNativeIdentitySchema = z.object({
  containerId: z.string().min(1), supervisorIdentity: z.string().min(1), processIdentityDigest: PlacementDigestSchema, startedAt: z.string().datetime().optional(),
}).strict()
export type RemoteJobNativeIdentity = z.infer<typeof RemoteJobNativeIdentitySchema>
export const RemoteJobOwnerControlSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), commandId: z.string().min(1),
  operationId: z.string().min(1), attemptId: z.string().min(1), executionId: z.string().min(1), bindingHash: PlacementDigestSchema,
  subject: RemoteExecutionSubjectSchema, owner: RemoteJobDispatchIntentSchema.shape.owner,
  action: z.object({ kind: z.literal('stop') }).strict(), native: RemoteJobNativeIdentitySchema.optional(),
}).strict()
export type RemoteJobOwnerControl = z.infer<typeof RemoteJobOwnerControlSchema>
export const RemoteJobTerminalEvidenceSchema = z.object({
  finishedAt: z.string().datetime(), closureEvidenceDigest: PlacementDigestSchema, outcome: z.enum(['succeeded','build_failed','spawn_failed','preparation_failed','cancelled','timed_out']),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), processStopped: z.literal(true),
  resultDigest: PlacementDigestSchema, logGapPossible: z.boolean(), logsTruncated: z.boolean(),
  outputCollectionError: z.boolean(), artifactDigests: z.array(PlacementDigestSchema).max(128),
}).strict()
export type RemoteJobTerminalEvidence = z.infer<typeof RemoteJobTerminalEvidenceSchema>
// Installed Jobs retain the full authenticated epoch. Original historical
// receipts without an epoch remain readable for status/control, never rewritten.
export const RemoteJobConnectionIdentitySchema = z.union([DeviceSessionBindingSchema, DeviceConnectionIdentitySchema, z.object({ kind: z.literal('main'), mainId: z.uuid(), mainInstallationId: z.string().min(1), bootId: z.uuid() }).strict()])
export type RemoteJobConnectionIdentity = z.infer<typeof RemoteJobConnectionIdentitySchema>
export const RemoteJobOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('job'), intent: RemoteJobDispatchIntentSchema, execution: z.lazy(() => JobExecutionSchema),
  connection: RemoteJobConnectionIdentitySchema, workerIncarnationId: z.uuid(), sequence: z.number().int().positive(), observedAt: z.string().datetime(), phase: RemoteOperationPhaseSchema,
  entryAttempted: z.boolean(), stopFence: z.boolean(), native: RemoteJobNativeIdentitySchema.optional(),
  controls: z.array(RemoteJobOwnerControlSchema).max(128), terminal: RemoteJobTerminalEvidenceSchema.optional(), publication: z.enum(['pending','process_recorded','collecting','complete','failed']), uncertainty: z.string().max(500).optional(),
}).strict()
export type RemoteJobOperationReceipt = z.infer<typeof RemoteJobOperationReceiptSchema>
export type RemoteJobOperationStatus = { status: 'known'; receipt: RemoteJobOperationReceipt } | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }
export interface RemoteJobDispatchPort {
  deliver(intent: RemoteJobDispatchIntent, execution: JobExecution): Promise<RemoteJobOperationStatus>
  reconcile(intent: RemoteJobDispatchIntent): Promise<RemoteJobOperationStatus>
  control(command: RemoteJobOwnerControl): Promise<RemoteJobOperationStatus>
}

const RemoteJobExecutionRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('job-dispatch'), intent: RemoteJobDispatchIntentSchema, execution: z.lazy(() => JobExecutionSchema) }).strict(),
  z.object({ method: z.literal('job-status'), intent: RemoteJobDispatchIntentSchema }).strict(),
  z.object({ method: z.literal('job-control'), intent: RemoteJobDispatchIntentSchema, command: RemoteJobOwnerControlSchema }).strict(),
])

export const RemoteJobMainRpcRequestSchema = z.discriminatedUnion('method', [
 z.object({ method: z.literal('job-report'), receipt: RemoteJobOperationReceiptSchema }).strict(),
 z.object({ method: z.literal('job-log'), intent: RemoteJobDispatchIntentSchema, chunk: JobLogChunkSchema }).strict(),
 z.object({ method: z.literal('job-authorize'), intent: RemoteJobDispatchIntentSchema, action: z.enum(['start','read','control','publish']) }).strict(),
 z.object({ method: z.literal('job-source'), intent: RemoteJobDispatchIntentSchema }).strict(),
])

/** Original accepted Main metadata; this is not physical source or host qualification. */
const RemoteJobAcceptedSourceReadoutSchema = z.object({
 execution: z.lazy(() => JobExecutionSchema), materialization: SourceMaterializationRecordSchema,
 root: SourceRootRecordSchema, diskQuotaBytes: z.number().int().positive(),
}).strict()
export type RemoteJobAcceptedSourceReadout = z.infer<typeof RemoteJobAcceptedSourceReadoutSchema>

/** Required at new Job dispatch. Control/status of original historical Jobs remain readable/stoppable. */
export const CurrentRemoteJobDispatchRequestSchema = z.object({ method: z.literal('job-dispatch'),
  intent: CurrentRemoteJobDispatchIntentSchema, execution: CurrentJobExecutionSchema,
}).strict().superRefine((value, ctx) => {
  const spec = value.execution.acceptedSpec
  if (value.intent.mainId !== spec.target.mainId || value.intent.subject.workspaceId !== value.execution.workspaceId
    || value.intent.executionId !== value.execution.id || value.intent.operationId !== value.execution.operationId
    || value.intent.attemptId !== value.execution.attemptId || value.intent.bindingHash !== spec.bindingHash
    || Object.keys(DeviceExecutionAdmissionFields).some(field =>
      value.intent[field as keyof typeof DeviceExecutionAdmissionFields] !== spec[field as keyof typeof DeviceExecutionAdmissionFields]))
    ctx.addIssue({ code: 'custom', message: 'Job dispatch must retain original execution and resource/approval admission.' })
})

export const RemoteJobOperationReceiptRecordSchema = z.object({
  ...RemoteJobOperationReceiptSchema.shape,
  execution: JobExecutionRecordSchema,
}).strict()
export type RemoteJobOperationReceiptRecord = z.infer<typeof RemoteJobOperationReceiptRecordSchema>
export type RemoteJobOperationStatusRecord = { status: 'known'; receipt: RemoteJobOperationReceiptRecord }
  | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }
export const RemoteJobExecutionRpcRequestRecordSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('job-dispatch'), intent: RemoteJobDispatchIntentSchema,
    execution: JobExecutionRecordSchema }).strict(),
  RemoteJobExecutionRpcRequestSchema.options[1],
  RemoteJobExecutionRpcRequestSchema.options[2].extend({ execution: JobExecutionRecordSchema.optional() }),
])
export const RemoteJobMainRpcRequestRecordSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('job-report'), receipt: RemoteJobOperationReceiptRecordSchema }).strict(),
  ...RemoteJobMainRpcRequestSchema.options.slice(1),
])
export const RemoteJobAcceptedSourceReadoutRecordSchema = z.object({
  ...RemoteJobAcceptedSourceReadoutSchema.shape,
  execution: JobExecutionRecordSchema,
}).strict()
export type RemoteJobAcceptedSourceReadoutRecord = z.infer<typeof RemoteJobAcceptedSourceReadoutRecordSchema>
export const RemoteVerificationJobDispatchRequestSchema = z.object({
  method: z.literal('job-dispatch'), intent: CurrentRemoteJobDispatchIntentSchema,
  execution: VerificationJobExecutionSchema,
}).strict().superRefine((value, context) => {
  const { intent, execution } = value
  const spec = execution.acceptedSpec
  const subject = intent.subject
  const expectedSubject = execution.workflow ? { kind: 'workflow-node', workspaceId: execution.workspaceId,
    ...execution.workflow } : { kind: 'manual-job', workspaceId: execution.workspaceId,
    jobExecutionId: execution.id, definitionId: spec.definitionId }
  if (intent.mainId !== spec.target.mainId || intent.subject.workspaceId !== execution.workspaceId
    || intent.executionId !== execution.id || intent.operationId !== execution.operationId
    || intent.attemptId !== execution.attemptId || intent.bindingHash !== spec.bindingHash
    || intent.inputDigest !== `sha256:${spec.specDigest}`
    || JSON.stringify(intent.owner) !== JSON.stringify(execution.owner)
    || Object.entries(expectedSubject).some(([field, expected]) => Reflect.get(subject, field) !== expected)
    || Object.keys(DeviceExecutionAdmissionFields).some(field => Reflect.get(intent, field) !== Reflect.get(spec, field))) {
    context.addIssue({ code: 'custom', message: 'Verification dispatch retains its complete original subject and admission.' })
  }
})
export interface RemoteJobDispatchRecordPort {
  deliver(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord): Promise<
    { status: 'known'; receipt: RemoteJobOperationReceiptRecord }
    | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }>
  reconcile(intent: RemoteJobDispatchIntent): ReturnType<RemoteJobDispatchRecordPort['deliver']>
  control(command: RemoteJobOwnerControl): ReturnType<RemoteJobDispatchRecordPort['deliver']>
}
