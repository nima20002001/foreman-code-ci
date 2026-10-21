import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { DeviceDigestSchema, DeviceSafeIntegerSchema } from './deviceResources.js'
import { JobTargetSchema, JobComputerSelectionSchema, JobRuntimeLimitsSchema,
  JobValidationSchema, JobInitiatingAgentSchema } from './jobs.js'
import { JobDefinitionRecordSchema, JobDefinitionSpecRecordSchema, JobExecutionRecordSchema } from './jobVerification.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { JobWorkflowAdmissionReferenceSchema } from './jobWorkflow.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { ManagementPrincipalSchema } from './management/principals.js'

const PositiveInteger = DeviceSafeIntegerSchema.positive()
const JobPlacementIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto') }).strict(),
  z.object({ kind: z.literal('explicit'), target: JobTargetSchema }).strict(),
  /** Auto placement that tries this computer first (an Agent's own computer), then the others in build order. */
  z.object({ kind: z.literal('prefer'), hostRef: JobTargetSchema.shape.hostRef }).strict(),
])
export type JobPlacementIntent = z.infer<typeof JobPlacementIntentSchema>
export const JobQueuedStartSchema = z.object({
  commandId: optionalCommandId(IdSchema),
  definitionId: IdSchema,
  expectedRevision: PositiveInteger,
  placementOverride: JobPlacementIntentSchema.optional(),
}).strict()
export const JobLaunchValidationInputSchema = JobQueuedStartSchema.omit({ commandId: true })
/** A request can wait in the queue even when no computer can run it now. */
export const JobLaunchValidationSchema = JobValidationSchema.extend({ canQueue: z.boolean() }).strict()

/** Priority belongs to computers. Tickets are FIFO among eligible requests, with bounded backfill. */
export const JOB_QUEUE_ORDER = 'fifo-among-eligible' as const
export const JOB_COMPUTER_ORDER = 'build-priority-descending-then-computer-root-profile' as const
export const JobComputerEligibilityReasonSchema = z.enum([
  'incompatible', 'disabled', 'busy', 'offline', 'setup_required', 'executor_unavailable',
  'remote_execution_disabled', 'authorization_revoked', 'workspace_denied', 'computer_denied',
  'source_unavailable', 'root_changed', 'runtime_setup_required', 'runtime_unqualified', 'qualification_expired',
  'suite_unqualified', 'network_unavailable', 'network_approval_required', 'credentials_unavailable',
  'credential_approval_required', 'request_exceeds_maximum', 'draining', 'eligibility_check_failed',
  'memory_unavailable', 'memory_headroom_required', 'dependencies_changed',
])
export const JobComputerEligibilitySchema = z.object({
  target: JobTargetSchema,
  compatible: z.boolean(),
  eligible: z.boolean(),
  available: z.boolean(),
  reasons: z.array(JobComputerEligibilityReasonSchema).max(32),
  diagnosticCodes: z.array(z.string().min(1).max(200)).max(32).optional(),
  buildPriority: z.number().int().min(0).max(100),
  settingsRevision: DeviceSafeIntegerSchema,
  rootId: z.uuid(),
  bindingRevision: PositiveInteger,
  profileId: IdSchema,
  profileRevision: PositiveInteger,
}).strict().superRefine((value, context) => {
  const waitingReasons = new Set(['busy', 'offline'])
  const hasBlockingReason = value.reasons.some(reason => !waitingReasons.has(reason))
  if ((value.available && (!value.eligible || value.reasons.length))
    || (value.eligible && (!value.compatible || hasBlockingReason))
    || (!value.available && value.reasons.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Computer availability cannot bypass eligibility or capacity checks.' })
  }
})

/** Supplied to the existing selector by Jobs; never supplied by a UI/MCP caller as readiness claims. */
export const JobComputerSelectionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: IdSchema,
  principalId: IdSchema,
  definitionId: IdSchema,
  definitionRevision: PositiveInteger,
  definitionVersionId: IdSchema,
  executionId: IdSchema,
  attemptId: IdSchema,
  operationId: IdSchema,
  spec: JobDefinitionSpecRecordSchema,
  placement: JobPlacementIntentSchema,
  resources: JobResourceRequestSchema,
  queueOrder: z.literal(JOB_QUEUE_ORDER),
  computerOrder: z.literal(JOB_COMPUTER_ORDER),
}).strict().superRefine((value, context) => validateRequestedResources(value.spec, value.resources, context))

function validateRequestedResources(
  spec: z.infer<typeof JobDefinitionSpecRecordSchema>,
  resources: z.infer<typeof JobResourceRequestSchema>,
  context: z.RefinementCtx,
): void {
  if (('limits' in spec && JSON.stringify(spec.limits) !== JSON.stringify(resources.limits))
    || ('verification' in spec && JSON.stringify(spec.verification.resources) !== JSON.stringify(resources))) {
    context.addIssue({ code: 'custom', path: ['resources'], message: 'Admission retains the saved resource request.' })
  }
}

export const JobQueueTicketSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  workspaceId: IdSchema,
  revision: PositiveInteger,
  commandId: IdSchema,
  commandDigest: DeviceDigestSchema,
  principalId: IdSchema,
  definition: JobDefinitionRecordSchema,
  runtimePreparation: ManagementPrincipalSchema.optional(),
  executionId: IdSchema,
  attemptId: IdSchema,
  operationId: IdSchema,
  workflow: JobWorkflowAdmissionReferenceSchema.nullable(),
  initiatingAgent: JobInitiatingAgentSchema.optional(),
  gateId: IdSchema.nullable(),
  placement: JobPlacementIntentSchema,
  placementOverride: JobPlacementIntentSchema.nullable(),
  resources: JobResourceRequestSchema,
  enqueueSequence: z.string().regex(/^[1-9][0-9]*$/),
  enqueuedAt: TimestampSchema,
  deadlineAt: TimestampSchema,
  state: z.enum(['waiting', 'blocked', 'claimed', 'accepted', 'terminal']),
  waitingReasons: z.array(JobComputerEligibilityReasonSchema).max(32),
  sourceCapacityWait: z.object({
    attempts: PositiveInteger,
    waitedMs: DeviceSafeIntegerSchema,
    startedAt: TimestampSchema,
    retryAt: TimestampSchema,
  }).strict().optional(),
  compatibleTargetCount: DeviceSafeIntegerSchema,
  queuePosition: PositiveInteger.nullable(),
  estimatedStartAt: TimestampSchema.nullable(),
  reservationId: z.uuid().nullable(),
  cancelRequestedAt: TimestampSchema.nullable(),
  terminalReason: z.enum(['cancelled', 'timed_out', 'authorization_revoked', 'request_exceeds_maximum', 'completed']).nullable(),
  finishedAt: TimestampSchema.nullable(),
  cleanupStatus: z.enum(['none', 'pending', 'complete']).optional(),
  selectedComputer: z.object({
    target: JobTargetSchema,
    rootId: z.uuid(), bindingRevision: PositiveInteger,
    profileId: IdSchema, profileRevision: PositiveInteger,
  }).strict().nullable().optional(),
}).strict().superRefine((value, context) => {
  const spec = value.definition.spec
  if (value.runtimePreparation && (value.runtimePreparation.id !== value.principalId
    || value.runtimePreparation.audience !== 'operator')) {
    context.addIssue({ code: 'custom', path: ['runtimePreparation'], message: 'Preparation retains the ticket’s author.' })
  }
  validateRequestedResources(spec, value.resources, context)
  if (value.workspaceId !== value.definition.workspaceId
    || Date.parse(value.deadlineAt) - Date.parse(value.enqueuedAt) !== spec.policy.queueTimeoutMs) {
    context.addIssue({ code: 'custom', message: 'Ticket scope and deadline retain the original definition and enqueue time.' })
  }
  const expectedPlacement = value.placementOverride
    ?? ('kind' in spec.target ? { kind: 'auto' } : { kind: 'explicit', target: spec.target })
  if (JSON.stringify(value.placement) !== JSON.stringify(expectedPlacement)) {
    context.addIssue({ code: 'custom', path: ['placement'], message: 'Placement records the saved default or explicit Start override.' })
  }
  if (value.sourceCapacityWait && (value.state !== 'waiting' || value.reservationId === null
    || !value.waitingReasons.includes('busy'))) {
    context.addIssue({ code: 'custom', message: 'Source capacity waits retain the claimed reservation and busy reason.' })
  }
  const terminal = value.state === 'terminal'
  if (terminal !== (value.terminalReason !== null) || terminal !== (value.finishedAt !== null)
    || (value.terminalReason === 'cancelled' && value.cancelRequestedAt === null)
    || (value.terminalReason === 'completed' && value.reservationId === null)
    || (['claimed', 'accepted'].includes(value.state) && value.reservationId === null)
    || (['waiting', 'blocked'].includes(value.state) && value.reservationId !== null
      && !(value.state === 'waiting' && value.sourceCapacityWait))) {
    context.addIssue({ code: 'custom', message: 'Ticket state must retain claim, cancellation and terminal facts.' })
  }
  if (['waiting', 'blocked'].includes(value.state)
    && value.waitingReasons.some(reason => reason === 'authorization_revoked' || reason === 'request_exceeds_maximum')) {
    context.addIssue({ code: 'custom', message: 'Revoked authority and oversized requests terminate admission instead of waiting.' })
  }
  if (value.workflow && value.workflow.workspaceId !== value.workspaceId) {
    context.addIssue({ code: 'custom', message: 'Workflow ownership must remain in the ticket workspace.' })
  }
})
export const JobPendingAdmissionSchema = z.object({
  kind: z.literal('pending-admission'),
  ticket: JobQueueTicketSchema.refine(ticket => ticket.state !== 'accepted', 'Accepted tickets refer to a concrete execution.'),
}).strict()
export const JobAdmissionResultSchema = z.discriminatedUnion('kind', [
  JobPendingAdmissionSchema,
  z.object({ kind: z.literal('accepted'), ticketId: z.uuid(), executionId: IdSchema }).strict(),
  z.object({ kind: z.literal('retained-execution'), execution: JobExecutionRecordSchema }).strict(),
])
export const JobQueueCancelSchema = z.object({
  commandId: optionalCommandId(IdSchema), ticketId: z.uuid(), expectedRevision: PositiveInteger,
}).strict()

export const JobQueueListInputSchema = z.object({
  workflowId: IdSchema.optional(),
  initiatingExecutionId: IdSchema.optional(),
  historyBeforeSequence: z.string().regex(/^[1-9][0-9]*$/).max(19)
    .refine(value => BigInt(value) <= 9223372036854775807n).optional(),
  historyLimit: z.number().int().min(1).max(100).default(100),
}).strict()
export const JobQueuePageSchema = z.object({
  tickets: z.array(JobQueueTicketSchema),
  nextHistoryCursor: JobQueueListInputSchema.shape.historyBeforeSequence.unwrap().nullable(),
}).strict()

export const JobResourceReservationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(), ticketId: z.uuid(), workspaceId: IdSchema,
  executionId: IdSchema, attemptId: IdSchema, operationId: IdSchema,
  target: JobTargetSchema,
  rootId: z.uuid(), bindingRevision: PositiveInteger,
  profileId: IdSchema, profileRevision: PositiveInteger,
  qualificationId: z.uuid(),
  resources: JobResourceRequestSchema,
  computerSelection: JobComputerSelectionSchema,
  slot: PositiveInteger,
  owner: z.object({ grantId: IdSchema, epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  state: z.enum(['preparing', 'dispatched', 'running', 'execution-uncertain', 'retained', 'released']),
  claimedAt: TimestampSchema,
  deliveryAttemptedAt: TimestampSchema.nullable(),
  closure: z.object({
    kind: z.enum(['non-entry-fenced', 'descendants-closed']), observedAt: TimestampSchema, evidenceDigest: DeviceDigestSchema,
  }).strict().nullable(),
  computeReleasedAt: TimestampSchema.nullable(),
  cleanupCompletedAt: TimestampSchema.nullable(),
  storageReleasedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.computeReleasedAt && !value.closure)
    || (value.storageReleasedAt && (!value.closure || !value.computeReleasedAt || !value.cleanupCompletedAt))
    || (value.state === 'released' && !value.storageReleasedAt)
    || (value.state !== 'released' && value.storageReleasedAt)
    || (value.state === 'retained' && !value.closure)
    || (['preparing', 'dispatched', 'running', 'execution-uncertain'].includes(value.state)
      && (value.closure || value.computeReleasedAt))
    || (['dispatched', 'running', 'execution-uncertain'].includes(value.state) && !value.deliveryAttemptedAt)) {
    context.addIssue({ code: 'custom', message: 'Capacity remains reserved until positive closure, and disk until cleanup.' })
  }
  const times = [value.claimedAt, value.closure?.observedAt, value.computeReleasedAt,
    value.cleanupCompletedAt, value.storageReleasedAt].filter((time): time is string => Boolean(time))
  if (times.some((time, index) => index > 0 && Date.parse(time) < Date.parse(times[index - 1]!))) {
    context.addIssue({ code: 'custom', message: 'Reservation release must follow confirmed closure and cleanup.' })
  }
})
export const JobQueueLimitsSchema = z.object({
  maxPendingPerPrincipal: PositiveInteger,
  maxPendingPerWorkspace: PositiveInteger,
  maxBackfillClaims: DeviceSafeIntegerSchema,
}).strict()
/** Installer/owner configuration only. HTTP/MCP callers cannot submit reviewed envelopes or review metadata. */
const JobBuildQueuePolicySchema = z.object({
  schemaVersion: z.literal(1),
  mainId: z.uuid(),
  revision: PositiveInteger,
  limits: JobQueueLimitsSchema,
  envelopes: z.array(JobResourceRequestSchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  const budgets = value.envelopes.map(envelope => JSON.stringify(envelope.limits))
  if (new Set(budgets).size !== budgets.length) {
    context.addIssue({ code: 'custom', path: ['envelopes'], message: 'Each build resource budget has one reviewed envelope.' })
  }
})
export const JobBuildQueueConfigurationSchema = JobBuildQueuePolicySchema.safeExtend({
  review: z.object({
    reviewedByPrincipalId: IdSchema,
    reviewedAt: z.iso.datetime(),
    decisionDigest: DeviceDigestSchema,
  }).strict(),
})
export type JobBuildQueueConfiguration = z.infer<typeof JobBuildQueueConfigurationSchema>
export type JobQueueTicket = z.infer<typeof JobQueueTicketSchema>
export function jobQueueHasExecution(ticket: JobQueueTicket): boolean {
  return ticket.state === 'accepted' || ticket.state === 'terminal' && ticket.terminalReason === 'completed'
}
export type JobComputerEligibility = z.infer<typeof JobComputerEligibilitySchema>

/** Reuses the measured allowance after control headroom; consumers must not subtract it again. */
export const JobAvailableCapacitySchema = z.object({
  maximum: JobRuntimeLimitsSchema,
  available: JobRuntimeLimitsSchema.extend({
    cpuLimit: z.number().min(0).max(256), memoryBytes: DeviceSafeIntegerSchema,
    pidsLimit: DeviceSafeIntegerSchema, diskBytes: DeviceSafeIntegerSchema,
  }),
  controlReserveApplied: z.literal(true),
  availableHeavySlots: DeviceSafeIntegerSchema,
  maximumMutableInodes: PositiveInteger,
  availableMutableInodes: DeviceSafeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.availableMutableInodes > value.maximumMutableInodes
    || (Object.keys(value.maximum) as (keyof typeof value.maximum)[])
      .some(field => value.available[field] > value.maximum[field])) {
    context.addIssue({ code: 'custom', message: 'Available resources cannot exceed the measured allowance after control reserve.' })
  }
})
