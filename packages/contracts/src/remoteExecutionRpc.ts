import { CompactionStateSchema, SessionModeSchema, SessionPreferencesSchema } from './sessionControls.js'
import { RemoteOperationReceiptSchema, RemoteNativeIdentitySchema } from './remoteExecution.js'
import { z } from 'zod'
import { OutputSchemaSchema } from './wave25/outputContract.js'
import { DeviceExecutionAdmissionFields } from './deviceResources.js'
import { AgentConfigurationVersionSchema, HarnessExecutionRequestSchema, ApprovalResponseOptionSchema,
  NativeSessionReferenceSchema, WorkflowSessionContinuationSchema } from './index.js'
import { NativeExecutionPlacementSchema, AcceptedNodePlacementSchema, DispatchIntentSchema, CurrentAcceptedNodePlacementSchema, CurrentDispatchIntentSchema } from './nodePlacement.js'
import { RemoteOwnerControlSchema, RemoteOwnerReconciliationSchema, RemoteApplicationAccessSchema,
  RemoteReviewerRequestSchema } from './remoteExecution.js'
import { DeviceHistoryRequestFields, DeviceJsonContinuationRequestSchema, DeviceJsonContinuationSchema, DeviceHistoryPageSchema } from './deviceApplication.js'
export * from './workerConversations.js'
export const NativeResponseAvailabilityQuerySchema = z.object({
  nativeRequestId: z.string().min(1),
  nativeRequestType: z.string().min(1),
  expectedNativeTurnId: z.string().min(1).optional(),
  expectedNativeMessageId: z.string().min(1).optional(),
  expectedGeneration: z.string().min(1).optional(),
}).strict()
export type NativeResponseAvailabilityQuery = z.infer<typeof NativeResponseAvailabilityQuerySchema>
export const NativeResponseAvailabilitySchema = z.object({
  nativeSessionId: z.string().min(1),
  nativeRequestId: z.string().min(1),
  nativeRequestType: z.string().min(1),
  nativeTurnId: z.string().min(1).optional(),
  nativeMessageId: z.string().min(1).optional(),
  generation: z.string().min(1).optional(),
  qualified: z.boolean(),
  state: z.enum(['available', 'recovery_required', 'unavailable']),
  path: z.enum(['live_callback', 'qualified_recovery']).nullable(),
  reason: z.enum(['live_callback', 'qualified_recovery', 'request_consumed', 'callback_lost', 'session_closed',
    'unqualified', 'identity_mismatch', 'response_in_flight', 'unsupported']),
}).strict()
export type NativeResponseAvailability = z.infer<typeof NativeResponseAvailabilitySchema>
const binding = { intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, executionPlacement: NativeExecutionPlacementSchema.optional() }
export const RemoteReceiptPageSchema = z.object({
  kind: z.literal('receipt-page'), transferId: z.uuid(), receiptSequence: z.number().int().positive(),
  metadata: DeviceJsonContinuationSchema,
}).strict()
export type RemoteReceiptPage = z.infer<typeof RemoteReceiptPageSchema>
export const RemoteHistoryReceiptIdentitySchema = z.object({
  intent: RemoteOperationReceiptSchema.shape.intent,
  connection: RemoteOperationReceiptSchema.shape.connection,
  workerIncarnationId: RemoteOperationReceiptSchema.shape.workerIncarnationId,
  sequence: RemoteOperationReceiptSchema.shape.sequence,
})
export const RemoteHistoryContinuationSchema = z.object({
  receiptIdentity: RemoteHistoryReceiptIdentitySchema,
  page: DeviceHistoryPageSchema,
}).strict()
export const RemoteExecutionRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('receipt-continuation'), ...binding, transferId: z.uuid(),
    receiptSequence: z.number().int().positive(), metadata: DeviceJsonContinuationRequestSchema,
    forStop: z.literal(true).optional() }).strict(),
  z.object({ method: z.literal('physical-readout'), ...binding, receiptSequence: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), metadata: DeviceJsonContinuationRequestSchema.optional() }).strict(),
  z.object({ method: z.literal('physical-ack'), ...binding, receiptSequence: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), metadata: DeviceJsonContinuationRequestSchema.optional(),
    // Main has committed this execution's matching terminal result, beyond retaining its source.
    retire: z.literal(true).optional() }).strict(),
  z.object({ method: z.literal('prepare'), ...binding, request: z.lazy(() => HarnessExecutionRequestSchema),
    sessionContinuation: z.lazy(() => WorkflowSessionContinuationSchema).optional(),
    applicationAccess: RemoteApplicationAccessSchema.optional(), sessionPreferences: SessionPreferencesSchema.optional() }).strict(),
  z.object({ method: z.literal('reattach'), ...binding, request: z.lazy(() => HarnessExecutionRequestSchema), session: z.lazy(() => NativeSessionReferenceSchema) }).strict(),
  z.object({ method: z.literal('prepare-review'), ...binding, review: RemoteReviewerRequestSchema }).strict(),
  z.object({ method: z.literal('get-application-access'), ...binding, session: z.lazy(() => NativeSessionReferenceSchema) }).strict(),
  z.object({ method: z.literal('start-turn'), ...binding, prompt: z.string().min(1).max(1_000_000),
    correlationId: z.string().min(1), review: RemoteReviewerRequestSchema.optional(),
    sessionMode: SessionModeSchema.optional(), outputSchema: OutputSchemaSchema.optional(),
    deferSettlement: z.literal(true).optional() }).strict(),
  z.object({ method: z.literal('settle-turn'), ...binding,
    correlationId: z.string().min(1), nativeTurnId: z.string().min(1) }).strict(),
  z.object({ method: z.literal('history'), ...binding, ...DeviceHistoryRequestFields,
    correlationId: z.string().min(1).optional(), receiptSequence: z.number().int().positive().optional() }).strict(),
  z.object({ method: z.literal('pending'), ...binding }).strict(),
  z.object({ method: z.literal('status'), ...binding, forStop: z.literal(true).optional() }).strict(),
  z.object({ method: z.literal('inspect-response-availability'), ...binding,
    session: z.lazy(() => NativeSessionReferenceSchema), query: NativeResponseAvailabilityQuerySchema }).strict(),
  z.object({ method: z.enum(['capabilities', 'inspect-mcp']), ...binding, configuration: z.lazy(() => AgentConfigurationVersionSchema) }).strict(),
  z.object({ method: z.literal('reconcile-response'), ...binding, downloadId: z.uuid().optional(), response: z.object({ nativeRequestId: z.string().min(1), nativeRequestType: z.string().min(1), option: z.lazy(() => ApprovalResponseOptionSchema) }).strict() }).strict(),
  z.object({ method: z.literal('session-controls-read'), ...binding, native: RemoteNativeIdentitySchema }).strict(),
  z.object({ method: z.literal('session-preferences-apply'), ...binding, native: RemoteNativeIdentitySchema, preferences: SessionPreferencesSchema }).strict(),
  z.object({ method: z.literal('session-compact'), ...binding, native: RemoteNativeIdentitySchema,
    requestId: z.string().min(8), clientCorrelationId: z.string().min(1) }).strict(),
  z.object({ method: z.literal('session-compact-reconcile'), ...binding, native: RemoteNativeIdentitySchema,
    state: CompactionStateSchema }).strict(),
  z.object({ method: z.literal('renew-owner'), ...binding, transition: RemoteOwnerReconciliationSchema }).strict(),
  z.object({ method: z.literal('control'), ...binding, command: RemoteOwnerControlSchema }).strict(),
  z.object({ method: z.literal('control-delivery'), ...binding, command: RemoteOwnerControlSchema }).strict(),
])
export type RemoteExecutionRpcRequest = z.infer<typeof RemoteExecutionRpcRequestSchema>
/** W07 authenticated extension kind. Frame bounds/operation grant remain carrier-owned. */
export const REMOTE_EXECUTION_EXTENSION = 'execution-v1' as const

/** Preparation revision that preserves the original workflow session continuation. */
export const REMOTE_PREPARATION_EXTENSION = {
  namespace: 'execution-prepare', version: 2, maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
} as const

/** New native entry/turn must use this stricter envelope; historical status and Stop remain supported. */
export const CurrentRemoteExecutionRpcRequestSchema = RemoteExecutionRpcRequestSchema.superRefine((value, ctx) => {
  if (!['prepare', 'start-turn'].includes(value.method)) return
  const placement = CurrentAcceptedNodePlacementSchema.safeParse(value.placement)
  const intent = CurrentDispatchIntentSchema.safeParse(value.intent)
  if (!placement.success || !intent.success || value.intent.bindingHash !== value.placement.bindingHash
    || value.intent.mainId !== value.placement.mainId || value.intent.runId !== value.placement.runId
    || value.intent.nodeId !== value.placement.nodeId || Object.keys(DeviceExecutionAdmissionFields).some(field =>
    value.intent[field as keyof typeof DeviceExecutionAdmissionFields] !== value.placement[field as keyof typeof DeviceExecutionAdmissionFields]))
    ctx.addIssue({ code: 'custom', message: 'Native entry requires the identical original resource policy and device approval.' })
})
