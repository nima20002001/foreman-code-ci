import { z } from 'zod'
import { DeviceExecutionAdmissionFields, HistoricalDeviceExecutionAdmissionFields, validateHistoricalDeviceExecutionAdmission } from './deviceResources.js'
import { RemoteOperationPhaseSchema } from './remoteOperationPhase.js'
export { RemoteOperationPhaseSchema } from './remoteOperationPhase.js'
import { ExecutionResultSchema, NativeSessionReferenceSchema } from './index.js'
import { DispatchIntentSchema, OwnerControlSchema, PlacementDigestSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { RemoteEntryClosureSchema } from './remoteExecutionEntryClosure.js'

/** Ephemeral exact main-owned worker MCP lease; never journaled or logged. */
export const RemoteApplicationAccessSchema = z.object({
  kind: z.literal('scoped-worker-mcp'), token: z.string().min(1).max(4096),
  executionId: z.string().min(1), agentId: z.string().min(1), operationId: z.string().min(1), attemptId: z.string().min(1), bindingHash: PlacementDigestSchema,
}).strict()
export type RemoteApplicationAccess = z.infer<typeof RemoteApplicationAccessSchema>
export const RemoteNativeIdentitySchema = z.object({
  sessionId: z.string().min(1), turnId: z.string().min(1).optional(),
  processIdentityDigest: PlacementDigestSchema,
}).strict()
export type RemoteNativeIdentity = z.infer<typeof RemoteNativeIdentitySchema>
export const RemoteOwnerControlSchema = OwnerControlSchema.extend({
  native: RemoteNativeIdentitySchema.optional(),
}).superRefine((value, context) => {
  if (value.action.kind === 'respond' && !value.native?.turnId) context.addIssue({ code: 'custom', message: 'Respond requires the exact native session and turn.' })
})
export type RemoteOwnerControl = z.infer<typeof RemoteOwnerControlSchema>
export const WorkflowArtifactValidationFailureSchema = z.object({
  code: z.literal('WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT'),
  reason: z.enum(['invalid_result', 'missing_publication']),
}).strict()
export type WorkflowArtifactValidationFailure = z.infer<typeof WorkflowArtifactValidationFailureSchema>
export const RemoteTerminalEvidenceSchema = z.object({
  kind: z.enum(['completed', 'cancelled', 'not_started', 'failed']),
  /** W11/provider recovery attestation, never PID absence or a missed heartbeat. */
  closureEvidenceDigest: PlacementDigestSchema,
  resultDigest: PlacementDigestSchema.optional(),
  result: z.lazy(() => ExecutionResultSchema).optional(), artifactDigests: z.array(PlacementDigestSchema).max(128).optional(),
  entryClosure: RemoteEntryClosureSchema.optional(),
  artifactValidationError: WorkflowArtifactValidationFailureSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.artifactValidationError && (value.kind !== 'completed' || value.result?.outcome !== 'succeeded'
    || (value.artifactDigests?.length ?? 0) !== 0)) {
    context.addIssue({ code: 'custom', message: 'Artifact validation retains the original successful terminal without adopted digests.' })
  }
})
export type RemoteTerminalEvidence = z.infer<typeof RemoteTerminalEvidenceSchema>
export const RemoteInteractionTargetSchema = z.object({ interactionId: z.string().min(1), interactionRevision: z.string().regex(/^[1-9][0-9]*$/), nativeInteractionId: z.string().min(1), native: RemoteNativeIdentitySchema }).strict()
export type RemoteInteractionTarget = z.infer<typeof RemoteInteractionTargetSchema>
export const RemoteReviewerAssignmentSchema = z.object({
  jobId: z.string().min(1), interactionId: z.string().min(1), reviewerAgentId: z.string().min(1),
  correlationId: z.string().min(1), session: z.lazy(() => NativeSessionReferenceSchema),
}).strict()
export const RemoteReviewerRequestSchema = RemoteReviewerAssignmentSchema.extend({ leaseToken: z.string().min(1) })
export type RemoteReviewerAssignment = z.infer<typeof RemoteReviewerAssignmentSchema>
export type RemoteReviewerRequest = z.infer<typeof RemoteReviewerRequestSchema>
export const RemoteReviewerTurnSchema = z.object({
  assignment: RemoteReviewerAssignmentSchema, promptDigest: PlacementDigestSchema,
  afterSequence: z.number().int().min(-1),
  providerId: z.string().min(1).optional(), entered: z.boolean(), settled: z.boolean(),
  result: z.lazy(() => ExecutionResultSchema).optional(), resultDigest: PlacementDigestSchema.optional(),
  historyDigest: PlacementDigestSchema.optional(),
}).strict()
export const RemoteWorkflowTurnInputSchema = z.object({
  correlationId: z.string().min(1), promptDigest: PlacementDigestSchema,
  sessionMode: z.enum(['regular', 'plan']).default('regular'),
  outputSchemaDigest: PlacementDigestSchema.optional(), deferSettlement: z.literal(true).optional(),
}).strict()
export const RemoteOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1), intent: DispatchIntentSchema,
  ...HistoricalDeviceExecutionAdmissionFields,
  connection: DeviceConnectionIdentitySchema, workerIncarnationId: z.uuid(),
  sequence: z.number().int().positive(), phase: RemoteOperationPhaseSchema,
  interaction: RemoteInteractionTargetSchema.optional(), native: RemoteNativeIdentitySchema.optional(), terminal: RemoteTerminalEvidenceSchema.optional(),
  entryAttempted: z.boolean(), turnEntryAttempted: z.boolean(), turnInput: RemoteWorkflowTurnInputSchema.optional(),
  resultRepairs: z.array(z.object({ previousInput: RemoteWorkflowTurnInputSchema,
    previousTurnId: z.string().min(1), afterSequence: z.number().int().min(-1) }).strict()).max(2).optional(),
  outputValidationComplete: z.literal(true).optional(),
  stopFence: z.boolean(), controls: z.array(RemoteOwnerControlSchema).max(128),
  nativeTurnRetries: z.array(z.object({
    previousTurnId: z.string().min(1), turnId: z.string().min(1),
  }).strict()).optional(),
  uncertainty: z.string().max(500).optional(),
  retainedReviewer: z.object({ agentId: z.string().min(1), expiresAt: z.string().datetime(),
    workflowTurnId: z.string().min(1), result: z.lazy(() => ExecutionResultSchema) }).strict().optional(),
  reviewTurns: z.array(RemoteReviewerTurnSchema).optional(),
}).strict().superRefine((value, context) => {
  validateHistoricalDeviceExecutionAdmission(value, context)
  if (Object.keys(DeviceExecutionAdmissionFields).some(field => value[field as keyof typeof DeviceExecutionAdmissionFields] !== undefined
    && value[field as keyof typeof DeviceExecutionAdmissionFields] !== value.intent[field as keyof typeof DeviceExecutionAdmissionFields]))
    context.addIssue({ code: 'custom', message: 'Receipt retains the original admission policy and device approval.' })
  if (value.native && !value.entryAttempted) context.addIssue({ code: 'custom', message: 'Native evidence requires an entry reservation.' })
  if ((value.phase === 'confirmed_terminal') !== (value.terminal !== undefined)) context.addIssue({ code: 'custom', message: 'Terminal phase requires exact closure evidence.' })
  if (['start_acknowledged', 'running'].includes(value.phase) && !value.native) context.addIssue({ code: 'custom', message: 'Acknowledged/running requires native ownership.' })
  if (value.retainedReviewer && (!value.native?.turnId || value.native.turnId !== value.retainedReviewer.workflowTurnId
    || value.turnInput?.correlationId !== `execution:${value.intent.executionId}${value.resultRepairs?.length
      ? `:result-repair:${value.resultRepairs.length}` : ''}`
    || value.retainedReviewer.result.outcome !== 'succeeded'))
    context.addIssue({ code: 'custom', message: 'Reviewer retention requires its successful original workflow turn.' })
  if (value.reviewTurns?.some(turn => !value.retainedReviewer
    || turn.assignment.reviewerAgentId !== value.retainedReviewer.agentId
    || turn.assignment.session.nativeSessionId !== value.native?.sessionId
    || turn.assignment.correlationId === value.turnInput?.correlationId)
    || new Set(value.reviewTurns?.map(turn => turn.assignment.correlationId)).size !== (value.reviewTurns?.length ?? 0))
    context.addIssue({ code: 'custom', message: 'Review turns retain distinct assignments on the original session.' })
})
export type RemoteOperationReceipt = z.infer<typeof RemoteOperationReceiptSchema>
/** Resolve only submissions established by the original turn and its connected repair journal. */
export function remoteWorkflowTurnId(receipt: RemoteOperationReceipt, correlationId: string): string | undefined {
  const native = receipt.native
  if (!native?.turnId) return undefined
  const initial = `execution:${receipt.intent.executionId}`
  const repairs = receipt.resultRepairs ?? []
  if (!repairs.length) return correlationId === (receipt.turnInput?.correlationId ?? initial) ? native.turnId : undefined
  if (repairs.some((repair, index) => repair.previousInput.correlationId !== initial
    + (index ? `:result-repair:${index}` : '') || !repair.previousInput.deferSettlement)
    || receipt.turnInput?.correlationId !== `${initial}:result-repair:${repairs.length}`) return undefined
  const first = repairs[0]!.previousTurnId
  const retries = receipt.nativeTurnRetries ?? []
  const start = retries.findIndex(retry => retry.previousTurnId === first)
  const submitted = [first]
  for (const retry of retries.slice(start < 0 ? retries.length : start)) {
    if (retry.previousTurnId !== submitted.at(-1) || submitted.includes(retry.turnId)) return undefined
    submitted.push(retry.turnId)
  }
  if (submitted.at(-1) !== native.turnId) return undefined
  let previous = -1
  for (const repair of repairs) {
    const index = submitted.indexOf(repair.previousTurnId)
    if (index <= previous) return undefined
    previous = index
  }
  const preceding = repairs.find(repair => repair.previousInput.correlationId === correlationId)
  if (preceding) return preceding.previousTurnId
  return receipt.turnInput.correlationId === correlationId && native.turnId !== repairs.at(-1)!.previousTurnId
    ? native.turnId : undefined
}

export function remoteWorkflowHasTurn(receipt: RemoteOperationReceipt, sessionId: string, turnId: string): boolean {
  const native = receipt.native
  if (native?.sessionId !== sessionId || !native.turnId) return false
  const initial = `execution:${receipt.intent.executionId}`
  const correlations = [initial,
    ...(receipt.resultRepairs ?? []).map((_, index) => `${initial}:result-repair:${index + 1}`)]
  if (!correlations.some(correlation => remoteWorkflowTurnId(receipt, correlation) !== undefined)) return false
  const retries = receipt.nativeTurnRetries ?? []
  const submitted = [retries[0]?.previousTurnId ?? native.turnId]
  for (const retry of retries) {
    if (retry.previousTurnId !== submitted.at(-1) || submitted.includes(retry.turnId)) return false
    submitted.push(retry.turnId)
  }
  return submitted.at(-1) === native.turnId && submitted.includes(turnId)
}
export function remoteActiveNative(receipt: RemoteOperationReceipt): RemoteNativeIdentity | undefined {
  const turn = receipt.reviewTurns?.at(-1)
  if (!receipt.native || !turn) return receipt.native
  if (!turn.providerId) return { sessionId: receipt.native.sessionId, processIdentityDigest: receipt.native.processIdentityDigest }
  return { ...receipt.native, turnId: turn.providerId }
}
/** A changed turn belongs to the same process only through its append-only retry journal. */
export function remoteNativeContinues(original: RemoteNativeIdentity, receipt: RemoteOperationReceipt,
  previousRetries: NonNullable<RemoteOperationReceipt['nativeTurnRetries']> = []): boolean {
  const observed = receipt.native
  if (!observed || original.sessionId !== observed.sessionId
    || original.processIdentityDigest !== observed.processIdentityDigest) return false
  const retries = receipt.nativeTurnRetries ?? []
  if (previousRetries.some((retry, index) => retry.previousTurnId !== retries[index]?.previousTurnId
    || retry.turnId !== retries[index]?.turnId)) return false
  let turnId = original.turnId
  for (const retry of retries.slice(previousRetries.length)) {
    if (turnId !== undefined && retry.previousTurnId !== turnId) return false
    turnId = retry.turnId
  }
  return original.turnId === undefined && retries.length === 0 || turnId === observed.turnId
}
export const RemoteOperationStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), receipt: RemoteOperationReceiptSchema }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.literal('journal_absence_requires_reconciliation') }).strict(),
])
export type RemoteOperationStatus = z.infer<typeof RemoteOperationStatusSchema>
/** Grant renewal is for this original physical execution, never another start. */
export const RemoteOwnerReconciliationSchema = z.object({
  commandId: z.string().min(1), operationId: z.string().min(1),
  previousOwner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  nextOwner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  native: RemoteNativeIdentitySchema, evidenceDigest: PlacementDigestSchema,
}).strict()
export type RemoteOwnerReconciliation = z.infer<typeof RemoteOwnerReconciliationSchema>
