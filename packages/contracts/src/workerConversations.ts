import { z } from 'zod'
import { DeviceJsonContinuationRequestSchema, DeviceJsonContinuationSchema } from './deviceApplication.js'
import { HarnessProfileSelectionSchema } from './harnessProfileSelection.js'
import { HostHarnessInstallationSchema, HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema } from './harnessRegistry.js'
import { HarnessQualificationSchema } from './harnessQualification.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { NativeMessageSubmissionSchema } from './claude.js'
import {
  AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema, AgentHarnessSchema,
  NativeSessionReferenceSchema, NativeHarnessEventSchema, PendingNativeInteractionSchema,
  ExecutionResultSchema, ApprovalResponseOptionSchema, ApprovalResponseSemanticSchema,
} from './index.js'
import { RemoteNativeIdentitySchema } from './remoteExecution.js'
import { CompactionStateSchema, SessionModeSchema, SessionPreferencesSchema } from './sessionControls.js'
import { PairedMcpEndpointSchema } from './mcpDetection.js'
import { AgentChatDirectoryBindingSchema } from './agentChat.js'
import { FileMediaTypeSchema, MAX_FILE_BYTES, MessageAttachmentRefsSchema } from './files.js'
import { PromptSettingSnapshotSchema } from './prompts.js'
import { AcceptedNodePlacementSchema } from './nodePlacement.js'
import { VerifiedSourceWorkingTreeSchema } from './sourceAdmission.js'
import { AcceptedProviderAccountBindingSchema } from './providerAccounts.js'

const id = z.string().min(1).max(1024)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const directory = z.string().startsWith('/').max(4096).refine(value => !value.includes('\0'))
const owner = { conversationId: id, configurationVersionId: id, configurationHash: digest }
const WorkerConversationOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ ...owner, kind: z.literal('operator'), operatorId: id }).strict(),
  z.object({ ...owner, kind: z.literal('agent'), agentId: id, workspaceId: id,
    workflowId: id, workflowNodeId: id }).strict(),
])
export const WorkerConversationBindingSchema = z.object({
  generation: z.uuid().optional(),
  // Preview journals include this spelling in native ownership hashes. Keep those facts intact.
  sessionGeneration: id.optional(),
  accountBinding: AcceptedProviderAccountBindingSchema.optional(),
  owner: WorkerConversationOwnerSchema,
  directoryBinding: AgentChatDirectoryBindingSchema.optional(),
  systemPrompt: PromptSettingSnapshotSchema.optional(),
  sourceExecution: z.object({ executionId: id, placement: z.lazy(() => AcceptedNodePlacementSchema),
    workingTree: VerifiedSourceWorkingTreeSchema }).strict().optional(),
  sourceConfigurationVersionId: id.optional(),
  harness: z.lazy(() => AgentHarnessSchema),
  profile: HarnessProfileSelectionSchema,
  workingDirectory: directory,
  appMcpAccess: z.enum(['scoped', 'none']),
}).strict().superRefine((value, context) => {
  if ((value.generation || value.sessionGeneration) && value.owner.kind !== 'agent') {
    context.addIssue({ code: 'custom', message: 'Replacement generations belong only to Agent chat.' })
  }
  if (value.generation && value.sessionGeneration) {
    context.addIssue({ code: 'custom', message: 'A conversation has one generation identity.' })
  }
  if (value.profile.target.hostRef.kind !== 'device') {
    context.addIssue({ code: 'custom', message: 'A worker conversation requires its selected device profile.' })
  }
  if (value.owner.kind === 'agent' && value.appMcpAccess !== 'none') {
    context.addIssue({ code: 'custom', message: 'Agent chat cannot receive management MCP access.' })
  }
  if (value.owner.kind === 'operator' && value.directoryBinding) {
    context.addIssue({ code: 'custom', message: 'Saved node directories belong only to Agent chat.' })
  }
  if (value.owner.kind === 'operator' && value.systemPrompt) {
    context.addIssue({ code: 'custom', message: 'The Operator does not receive the app-wide System prompt.' })
  }
  if (value.sourceExecution) {
    const placement = value.sourceExecution.placement
    const payload = placement.payload
    const owner = value.owner
    const target = value.profile.target
    const host = target.hostRef
    if (value.workingDirectory !== value.sourceExecution.workingTree.canonicalCwd
      || owner.kind !== 'agent' || payload.kind !== 'agent'
      || payload.agentId !== owner.agentId
      || payload.agentConfigurationVersionId !== (value.sourceConfigurationVersionId ?? owner.configurationVersionId)
      || value.sourceConfigurationVersionId === owner.configurationVersionId
      || placement.nodeId !== owner.workflowNodeId
      || !value.sourceConfigurationVersionId && (payload.driverId !== value.harness
        || value.profile.instanceId !== payload.instanceId || value.profile.instanceRevision !== payload.instanceRevision
        || target.harnessInstallationId !== payload.harnessInstallationId
        || target.installationFingerprint !== payload.installationFingerprint)
      || host.kind !== 'device' || placement.hostRef.kind !== 'device'
      || host.mainId !== placement.hostRef.mainId || host.deviceId !== placement.hostRef.deviceId
      || target.applicationInstallationId !== placement.registration?.workerInstallationId) {
      context.addIssue({ code: 'custom', message: 'The chat profile must match its accepted Agent execution placement.' })
    }
  }
  if (value.sourceConfigurationVersionId && !value.sourceExecution) {
    context.addIssue({ code: 'custom', message: 'A continued configuration requires its original Run working tree.' })
  }
})
export type WorkerConversationBinding = z.infer<typeof WorkerConversationBindingSchema>

/** Normalize addressing without rewriting a persisted binding or its native ownership digest. */
export function workerConversationGeneration(binding: WorkerConversationBinding): string | undefined {
  return binding.generation ?? binding.sessionGeneration
}
const WorkerConversationConfigurationSchema = z.union([
  z.lazy(() => OperatorConfigurationVersionSchema), z.lazy(() => AgentConfigurationVersionSchema),
])
export type WorkerConversationConfiguration = z.infer<typeof WorkerConversationConfigurationSchema>

/** Run follow-ups use the accepted execution profile while retaining the Agent configuration. */
export function workerConversationProfileSelection(binding: WorkerConversationBinding,
  configuration: WorkerConversationConfiguration) {
  const parsed = WorkerConversationBindingSchema.parse(binding)
  return parsed.sourceExecution && !parsed.sourceConfigurationVersionId ? parsed.profile : configuration.harnessProfileSelection
}

const WorkerConversationTurnSchema = z.object({
  correlationId: id, inputHash: digest,
  status: z.enum(['reserved', 'submitted', 'completed', 'uncertain', 'rejected']),
  nativeTurnId: id.nullable(), nativeSubmission: NativeMessageSubmissionSchema.optional(),
  sessionMode: SessionModeSchema.optional(),
  creationOperationId: id.optional(),
  result: z.lazy(() => ExecutionResultSchema).optional(),
}).strict()
export const WorkerClaudeCallbackIdentitySchema = z.object({
  ownerPrincipalId: id, attemptId: id, nativeSessionId: id, nativeMessageId: id,
  clientCorrelationId: id, generation: id, toolUseId: id,
  mcpServer: z.object({ name: id, source: id }).strict().optional(),
  nativeTurnId: id.optional(), nativeRequestId: id.optional(), nativeRequestType: z.literal('can_use_tool').optional(),
}).strict()
export const WorkerClaudeCallbackRecordSchema = z.object({
  identity: WorkerClaudeCallbackIdentitySchema, inputHash: digest, toolName: id,
  selectedOptionId: id.optional(), state: z.enum(['submitted', 'uncertain']),
  acknowledged: z.boolean(), retired: z.boolean().optional(),
}).strict()
const WorkerConversationSessionSchema = z.object({
  binding: WorkerConversationBindingSchema,
  connection: DeviceSessionBindingSchema,
  revision: z.number().int().positive(),
  closed: z.boolean(), closing: z.boolean(),
  closedAt: z.iso.datetime().optional(),
  runtimeReleased: z.boolean().optional(),
  replacement: z.object({ operationId: id, inputHash: digest }).strict().optional(),
  creation: z.object({ operationId: id, inputHash: digest, status: z.literal('rejected').optional() }).strict().optional(),
  session: z.lazy(() => NativeSessionReferenceSchema).optional(),
  nativeOwner: RemoteNativeIdentitySchema.optional(),
  ownerTransitions: z.array(z.object({ previous: RemoteNativeIdentitySchema, next: RemoteNativeIdentitySchema })
    .strict()).max(1000).optional(),
  applicationAccessChange: z.object({ operationId: id, inputHash: digest,
    previous: z.enum(['scoped', 'none']), next: z.enum(['scoped', 'none']),
    state: z.enum(['reserved', 'applied']) }).strict().optional(),
  turns: z.array(WorkerConversationTurnSchema).max(1000),
  compactions: z.array(z.object({ inputHash: digest, state: CompactionStateSchema }).strict()).max(1000),
  desiredPreferences: SessionPreferencesSchema.nullable(),
  appliedPreferences: SessionPreferencesSchema.nullable(),
  claudeCallbacks: z.record(digest, WorkerClaudeCallbackRecordSchema).optional(),
}).strict()
export const WorkerConversationReceiptSchema = WorkerConversationSessionSchema.extend({
  sessionHistory: z.array(WorkerConversationSessionSchema).max(1000).optional(),
}).strict()
export type WorkerConversationReceipt = z.infer<typeof WorkerConversationReceiptSchema>

export const WorkerConversationHistorySchema = z.object({
  correlationId: id.optional(), nativeTurnId: id.optional(), nativeMessageId: id.optional(),
  nativeSubmission: NativeMessageSubmissionSchema.optional(),
  nonSubmission: z.object({ nativeSessionId: id, clientCorrelationId: id,
    result: z.lazy(() => ExecutionResultSchema) }).strict().optional(),
  nextCursor: id.optional(), firstRetainedSequence: z.number().int().nonnegative().optional(),
  nextSequence: z.number().int().nonnegative().optional(),
  events: z.array(z.lazy(() => NativeHarnessEventSchema)),
  pendingInteractions: z.array(z.lazy(() => PendingNativeInteractionSchema)),
  pendingInteraction: z.lazy(() => PendingNativeInteractionSchema).optional(),
  terminalResult: z.lazy(() => ExecutionResultSchema).optional(),
  terminalTurn: z.object({ correlationId: id, providerId: id, result: z.lazy(() => ExecutionResultSchema) }).optional(),
  interactionDeliveries: z.array(z.object({ nativeRequestId: id,
    state: z.enum(['pending', 'submitting', 'submitted', 'uncertain']), selectedOptionId: id.optional() }).strict()).optional(),
  responseDeliveries: z.array(z.object({ source: z.enum(['provider_acknowledgement', 'provider_history']),
    harness: z.lazy(() => AgentHarnessSchema), providerVersion: id, nativeSessionId: id,
    nativeRequestId: id, nativeRequestType: id, optionId: id,
    semantic: z.lazy(() => ApprovalResponseSemanticSchema),
    nativeIdentity: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('turn'), nativeTurnId: id }).strict(),
      z.object({ kind: z.literal('message'), nativeMessageId: id, generation: id }).strict(),
    ]).optional(),
    responseDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).optional(),
  canceledRequestIds: z.array(id).optional(),
}).passthrough()

const binding = { binding: WorkerConversationBindingSchema, admissionId: z.uuid().optional() }
const native = { ...binding, session: z.lazy(() => NativeSessionReferenceSchema) }
const prompt = {
  // Attachment text/images are prepared on Worker after this request is validated.
  prompt: z.string().max(1_000_000), correlationId: id,
  sessionMode: SessionModeSchema.optional(), preferences: SessionPreferencesSchema.optional(),
}
const applicationAccess = z.object({ kind: z.literal('operator-chat-mcp'), token: z.string().min(1).max(16384) }).strict()
const copyIdentity = { transferId: z.uuid(), executionHostId: id }
export const WorkerConversationFileCopySchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('validate'), executionHostId: id }).strict(),
  z.object({ phase: z.literal('begin'), ...copyIdentity, filename: z.string().min(1).max(1024),
    mediaType: FileMediaTypeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().min(0).max(MAX_FILE_BYTES) }).strict(),
  z.object({ phase: z.literal('chunk'), ...copyIdentity, offset: z.number().int().min(0).max(MAX_FILE_BYTES),
    contentBase64: z.string().max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ phase: z.literal('finish'), ...copyIdentity }).strict(),
  z.object({ phase: z.literal('close'), executionHostId: id }).strict(),
])
export type WorkerConversationFileCopy = z.infer<typeof WorkerConversationFileCopySchema>
export const WorkerConversationRegisteredCopySchema = z.object({ registrationId: z.uuid(), executionHostId: id,
  executionPath: directory, writable: z.literal(false), byteSize: z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const WorkerConversationFileActionSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('prepare'), executionHostId: id }).strict(),
  z.object({ phase: z.literal('input'), prompt: z.string().max(1_000_000) }).strict(),
  z.object({ phase: z.literal('activate'), nativeTurnId: id }).strict(),
  z.object({ phase: z.literal('call'), call: z.object({ threadId: id, turnId: id,
    tool: id, arguments: z.unknown(), namespace: z.string().nullable().optional() }).strict() }).strict(),
  z.object({ phase: z.literal('publications') }).strict(),
  z.object({ phase: z.literal('close') }).strict(),
])
export type WorkerConversationFileAction = z.infer<typeof WorkerConversationFileActionSchema>
export const WorkerConversationFilePreparationSchema = z.object({
  allowedTools: z.array(z.enum(['files.list', 'files.read', 'files.create_working_copy',
    'files.publish_result', 'files.write_working_copy', 'files.apply_format_edit'])).max(6),
}).strict()
export const WorkerConversationFileInputSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), text_elements: z.tuple([]) }).strict(),
  z.object({ type: z.literal('localImage'), path: directory }).strict(),
]))
export const WorkerConversationFileResultSchema = z.object({ success: z.boolean(),
  contentItems: z.array(z.object({ type: z.literal('inputText'), text: z.string() }).strict()),
}).strict()
export const WorkerConversationFilePublicationsSchema = MessageAttachmentRefsSchema
const WorkerResponseAvailabilityQuerySchema = z.object({
  nativeRequestId: id, nativeRequestType: id, expectedNativeTurnId: id.optional(),
  expectedNativeMessageId: id.optional(), expectedGeneration: id.optional(),
}).strict()
export const WorkerResponseAvailabilitySchema = z.object({
  nativeSessionId: id, nativeRequestId: id, nativeRequestType: id, nativeTurnId: id.optional(),
  nativeMessageId: id.optional(), generation: id.optional(), qualified: z.boolean(),
  state: z.enum(['available', 'recovery_required', 'unavailable']),
  path: z.enum(['live_callback', 'qualified_recovery']).nullable(),
  reason: z.enum(['live_callback', 'qualified_recovery', 'request_consumed', 'callback_lost', 'session_closed',
    'unqualified', 'identity_mismatch', 'response_in_flight', 'unsupported']),
}).strict()
export const WORKER_CONVERSATION_RESPONSE_BYTES = 32 * 1024 * 1024
export const WorkerConversationResponsePageSchema = z.object({
  kind: z.literal('conversation-response-page'), transferId: z.uuid(),
  metadata: DeviceJsonContinuationSchema.extend({
    byteSize: z.number().int().safe().positive().max(WORKER_CONVERSATION_RESPONSE_BYTES),
  }),
}).strict()
export const WorkerConversationRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('conversation.response-continuation'), ...binding, transferId: z.uuid(),
    metadata: DeviceJsonContinuationRequestSchema }).strict(),
  z.object({ method: z.literal('conversation.file-copy'), ...binding, admissionId: z.uuid(),
    copy: WorkerConversationFileCopySchema }).strict(),
  z.object({ method: z.literal('conversation.status'), ...binding }).strict(),
  z.object({ method: z.literal('conversation.open'), ...binding, operationId: id,
    configuration: WorkerConversationConfigurationSchema, mode: z.enum(['create', 'attach', 'fork']),
    previousBinding: WorkerConversationBindingSchema.optional(),
    previousConfiguration: WorkerConversationConfigurationSchema.optional(),
    source: z.lazy(() => NativeSessionReferenceSchema).optional(), preferences: SessionPreferencesSchema.optional(),
    applicationAccess: applicationAccess.optional(),
  }).strict(),
  z.object({ method: z.literal('conversation.initial-turn'), ...binding, ...prompt, operationId: id,
    configuration: WorkerConversationConfigurationSchema,
    previousBinding: WorkerConversationBindingSchema.optional(),
    previousConfiguration: WorkerConversationConfigurationSchema.optional(),
    applicationAccess: applicationAccess.optional() }).strict(),
  z.object({ method: z.literal('conversation.start-turn'), ...native, ...prompt,
    fileInputs: z.boolean().optional() }).strict(),
  z.object({ method: z.literal('conversation.refresh-mcp'), ...binding,
    configuration: WorkerConversationConfigurationSchema, applicationAccess }).strict(),
  z.object({ method: z.literal('conversation.release-preparation'), ...binding }).strict(),
  z.object({ method: z.enum(['conversation.history', 'conversation.reconcile']), ...native,
    correlationId: id.optional(), before: id.optional(), afterSequence: z.number().int().min(-1).optional(),
    waitForEvents: z.boolean().optional(),
    sessionMode: SessionModeSchema.optional() }).strict(),
  z.object({ method: z.literal('conversation.recover-files'), ...native,
    configuration: WorkerConversationConfigurationSchema, correlationId: id,
    sessionMode: SessionModeSchema.optional() }).strict(),
  z.object({ method: z.enum(['conversation.capabilities', 'conversation.inspect-mcp']), ...binding,
    configuration: WorkerConversationConfigurationSchema }).strict(),
  z.object({ method: z.literal('conversation.inspect-entry'), ...binding,
    configuration: WorkerConversationConfigurationSchema, inspection: z.object({
      harness: z.lazy(() => AgentHarnessSchema), runnerId: id, workingDirectory: directory, serverName: id,
      phase: z.enum(['configuration', 'health']).optional(),
    }).strict() }).strict(),
  z.object({ method: z.enum(['conversation.pending', 'conversation.controls-read', 'conversation.close', 'conversation.release-runtime']),
    ...native }).strict(),
  z.object({ method: z.literal('conversation.cancel'), ...native, nativeTurnId: id.optional() }).strict(),
  z.object({ method: z.literal('conversation.retire-turn'), ...native, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.respond'), ...native, nativeRequestId: id,
    option: z.lazy(() => ApprovalResponseOptionSchema) }).strict(),
  z.object({ method: z.literal('conversation.response-availability'), ...native,
    query: WorkerResponseAvailabilityQuerySchema }).strict(),
  z.object({ method: z.literal('conversation.response-reconcile'), ...native, response: z.object({
    nativeRequestId: id, nativeRequestType: id, option: z.lazy(() => ApprovalResponseOptionSchema),
  }).strict() }).strict(),
  z.object({ method: z.literal('conversation.preferences'), ...native, preferences: SessionPreferencesSchema }).strict(),
  z.object({ method: z.literal('conversation.compact'), ...native, requestId: id, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.compact-reconcile'), ...native, state: CompactionStateSchema }).strict(),
  z.object({ method: z.literal('conversation.compact-read'), ...native, state: CompactionStateSchema,
    configuration: WorkerConversationConfigurationSchema, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.steer'), ...native, prompt: prompt.prompt.min(1),
    correlationId: id, expectedTurnId: id }).strict(),
  z.object({ method: z.literal('conversation.reconcile-steers'), ...native,
    inputs: z.array(z.object({ clientCorrelationId: id, expectedTurnId: id }).strict()).max(1000) }).strict(),
]).superRefine((request, context) => {
  if (request.method === 'conversation.open' || request.method === 'conversation.initial-turn') {
    const configurationChange = request.previousConfiguration !== undefined
    if (configurationChange && (!request.previousBinding
      || request.binding.owner.kind !== 'agent' || request.previousBinding.owner.kind !== 'agent'
      || request.method === 'conversation.open' && request.mode === 'fork')) {
      context.addIssue({ code: 'custom', message: 'A configuration transition requires its previous Agent binding.' })
    }
    if (request.previousBinding && !configurationChange && (request.method !== 'conversation.open'
      || request.mode !== 'attach' || request.binding.owner.kind !== 'operator'
      || request.previousBinding.owner.kind !== 'operator'
      || request.previousBinding.appMcpAccess === request.binding.appMcpAccess)) {
      context.addIssue({ code: 'custom', message: 'App MCP changes attach the same Operator conversation.' })
    }
  }
  if ('applicationAccess' in request && request.applicationAccess
    && (request.binding.owner.kind !== 'operator' || request.binding.appMcpAccess !== 'scoped')) {
    context.addIssue({ code: 'custom', message: 'Management MCP credentials require a scoped Operator conversation.' })
  }
})
export type WorkerConversationRpcRequest = z.infer<typeof WorkerConversationRpcRequestSchema>

export const WorkerConversationProfileFactsSchema = z.object({
  installation: z.lazy(() => HostHarnessInstallationSchema),
  override: z.lazy(() => HostHarnessOverrideSchema),
  profile: z.lazy(() => HostHarnessProfileEvidenceSchema),
  qualification: HarnessQualificationSchema.nullable(),
}).strict()
export type WorkerConversationProfileFacts = z.infer<typeof WorkerConversationProfileFactsSchema>

const callback = { admissionId: z.uuid(), binding: WorkerConversationBindingSchema }
const WorkerClaudeAuthorityRequestSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('admission') }).strict(),
  z.object({ phase: z.literal('file'), identity: WorkerClaudeCallbackIdentitySchema,
    operation: z.enum(['files.list', 'files.read', 'files.create_working_copy', 'files.write_working_copy',
      'files.apply_format_edit', 'files.publish_result']), args: z.unknown() }).strict(),
  z.object({ phase: z.literal('validate'), identity: WorkerClaudeCallbackIdentitySchema }).strict(),
  z.object({ phase: z.literal('pending'), identity: WorkerClaudeCallbackIdentitySchema,
    pending: z.lazy(() => PendingNativeInteractionSchema) }).strict(),
  z.object({ phase: z.literal('response'), identity: WorkerClaudeCallbackIdentitySchema,
    answer: z.object({ outcome: z.enum(['allow_once', 'deny', 'cancel', 'expired']), reason: z.string().optional() }).strict() }).strict(),
])
export type WorkerClaudeAuthorityRequest = z.infer<typeof WorkerClaudeAuthorityRequestSchema>
export const WorkerClaudeCallbackAuthoritySchema = z.object({ ownerPrincipalId: id, attemptId: id }).strict()
export const WorkerClaudeAuthorizationSchema = z.object({ authorized: z.literal(true) }).strict()
export const WorkerConversationCallbackSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('conversation.files'), ...callback,
    session: z.lazy(() => NativeSessionReferenceSchema), correlationId: id,
    action: WorkerConversationFileActionSchema }).strict(),
  z.object({ method: z.literal('conversation.file-copy-authorize'), ...callback,
    copy: WorkerConversationFileCopySchema }).strict(),
  z.object({ method: z.literal('conversation.authorize'), ...callback, request: WorkerConversationRpcRequestSchema }).strict(),
  z.object({ method: z.literal('conversation.profile'), ...callback }).strict(),
  z.object({ method: z.literal('conversation.claude-authority'), ...callback,
    request: WorkerClaudeAuthorityRequestSchema }).strict(),
  z.object({ method: z.literal('conversation.session-observed'), ...callback,
    session: z.lazy(() => NativeSessionReferenceSchema) }).strict(),
  z.object({ method: z.literal('conversation.submitted'), ...callback, correlationId: id,
    identity: z.object({ nativeTurnId: id.optional(), nativeSubmission: NativeMessageSubmissionSchema.optional() }).strict()
      .refine(value => Boolean(value.nativeTurnId || value.nativeSubmission), 'A provider submission identity is required') }).strict(),
  z.object({ method: z.literal('conversation.settings-applied'), ...callback, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.terminal-observed'), ...callback,
    observation: z.object({ submission: NativeMessageSubmissionSchema,
      result: z.lazy(() => ExecutionResultSchema), nativeMessageId: id.optional(),
      history: WorkerConversationHistorySchema.optional() }).strict() }).strict(),
])

export const WorkerMcpInspectionSchema = z.object({
  harness: z.lazy(() => AgentHarnessSchema), providerVersion: id, runnerId: id,
  workingDirectory: directory, inspectedAt: z.iso.datetime(), generation: id.optional(), authorizationScope: id.optional(),
  entry: z.object({ name: id, transport: z.enum(['streamable-http', 'sse', 'stdio', 'unknown']),
    automaticEndpoint: z.boolean().optional(), endpoint: z.string().optional(), enabled: z.boolean().optional(),
    pairedEndpoint: PairedMcpEndpointSchema.optional(),
    credentialEnvironmentVariable: id.optional(),
    credentialArrangement: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('environment_variable'), environmentVariable: id }).strict(),
      z.object({ kind: z.literal('unknown') }).strict(),
      z.object({ kind: z.literal('scoped_http_header'), acknowledgement: z.object({
        source: z.literal('sdk_set_mcp_servers'), serverName: id, endpoint: z.string(), generation: id, authorizationScope: id,
      }).strict() }).strict(),
    ]).optional(),
    status: z.enum(['connected', 'disabled', 'authentication_required', 'broken', 'status_unavailable']).optional(),
    detail: z.string().optional(), enabledTools: z.array(id).optional(), disabledTools: z.array(id).optional(),
    nativeFilterDiagnostics: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict()
