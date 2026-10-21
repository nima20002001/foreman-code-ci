import { assertWorkerSteerAuthority } from './workerSteerAuthority.js'
import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { NativeSessionReferenceSchema, withAdvancedDefaults, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { AgentConfigurationVersion, NativeSessionReference, PromptSettingSnapshot } from '@foreman-code/contracts'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { WorkerConversationBindingSchema, WorkerConversationReceiptSchema, type WorkerConversationConfiguration,
  WorkerConversationProfileFactsSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { requireAuthorization } from '../access/policy.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { createAdmittedNativeManager } from '../harnesses/admittedManager.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { HarnessQualificationRepository } from '../harnesses/qualification/repository.js'
import { readInstalledCodexQualification } from '../harnesses/installedCodexInspection.js'
import type { AcceptedHarnessProfile, AcceptedHarnessProfileAdmission, AcceptedProfileSelector } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import type { ClaudeDomainBinding } from '../harnesses/claudeSdk/domainAuthority.js'

import { PostgresClaudeInteractionAuthority } from '../harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeCallbackIdentity } from '../harnesses/claudeSdk/interactions.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import type { PostgresAgentChatRepository } from './agentChatRepository.js'
import { nativeCorrelation } from './operatorChatRepository.js'
import { agentChatCorrelation } from './agentChatRepository.js'
import { WorkerConversationManager, type WorkerConversationManagerOptions } from './workerManager.js'
import type { AcceptedChatInput } from './nativeChatInput.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { DomainError } from '../errors.js'
import { MainWorkerConversationMcp, type WorkerConversationAgentMcp } from './mainWorkerMcp.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { SelectedMainMcpForward } from '../placement/workerMcpRelay.js'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { AgentChatDirectoryBindingSchema } from '@foreman-code/contracts/agent-chat'
import { revalidateAgentChatDirectory } from './agentChatDirectory.js'
import type { PrepareWorkerFiles } from './mainWorkerFiles.js'
import { createMainWorkerClaudeFiles } from './mainWorkerClaudeFiles.js'
import type { AgentFileToolService } from '../files/tools/service.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { sameOperatorExecutionConfiguration, workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import { readAgentChatConfigurationTransition, readRunChatSkillsTransition } from './workerRunChatBinding.js'
import { validWorkerConfigurationTransition } from './workerConfigurationTransition.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { definedProperties } from '../definedProperties.js'
import { readExecutionPlacement, readNativePlacement } from '../placement/persistence.js'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import { legacyProviderAccountBinding, readProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'

type ConversationClaudeOwner = Extract<ClaudeDomainBinding, { kind: 'operator' | 'agent' }>

const reads = new Set(['conversation.status', 'conversation.history', 'conversation.reconcile', 'conversation.pending',
  'conversation.controls-read', 'conversation.compact-reconcile', 'conversation.reconcile-steers',
  'conversation.capabilities', 'conversation.inspect-mcp', 'conversation.inspect-entry', 'conversation.compact-read',
  'conversation.response-reconcile', 'conversation.response-availability'])
reads.add('conversation.release-preparation')
reads.add('conversation.response-continuation')
interface OwnerRow {
  id: string; kind: 'operator' | 'agent'; workspace_id: string | null; workflow_id: string | null
  workflow_node_id: string | null; agent_id: string | null; owner_principal_id: string | null
  operator_configuration_version_id: string | null; agent_configuration_version_id: string | null
  active_request_id: string | null; active_native_turn_id: string | null; native_session_id: string | null; deleted_at: unknown
  harness: NativeSessionReference['harness']; provider_version: string | null
  record: { status?: string; directoryBinding?: unknown; systemPrompt?: PromptSettingSnapshot;
    workerGeneration?: string; workerSessionGeneration?: string;
    sourceConfigurationVersionId?: string;
    origin?: { kind: string; runId?: string; executionId?: string; sourceNativeSessionId?: string } }
  payload: { ownerPrincipalId?: string } | null
  worker_conversation_binding: unknown
}
function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}

export interface ProductionWorkerConversationsInput {
  pool: pg.Pool
  endpoint(): Pick<DeviceEndpoint, 'captureRequest'>
  profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  claudeProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  operators: PostgresOperatorConversationRepository
  agents: PostgresAgentChatRepository
  registry: ProductionHarnessRegistry
  qualifications: Pick<HarnessQualificationRepository, 'findInstalled'>
  suiteRevisions: Partial<Record<'codex', string>>
  access: Pick<PostgresAccessService, 'authenticate'>
  mcpForward(): SelectedMainMcpForward
  agentMcp?: WorkerConversationAgentMcp
  files?(conversationId: string, configuration: WorkerConversationConfiguration, workingDirectory: string): PrepareWorkerFiles
  fileService?(): AgentFileToolService
}

export interface WorkerConversationOptions {
  conversationId: string
  configuration: WorkerConversationConfiguration
  lifecycle?: 'owner' | 'observer'
  workingDirectory: string
  appMcpAccess: 'scoped' | 'none'
  fileInputs?: boolean
  observationPrincipalId?: string
  profileSelection?: AcceptedProfileSelector
  sourceExecution?: WorkerConversationBinding['sourceExecution']
  applicationAccess?: import('./workerManager.js').WorkerConversationManagerOptions['applicationAccess']
}

async function authorizeWorkerConversationRequest(pool: pg.Pool, live: OwnerRow,
  request: WorkerConversationRpcRequest, context: {
    caller: string | undefined
    requestCallers: WeakMap<WorkerConversationRpcRequest, string>
    changingAccess: boolean | string | null
    originalBinding: WorkerConversationBinding
  }, agents: Pick<PostgresAgentChatRepository, 'turnPrincipalId' | 'turn' | 'turnContent'>) {
  let currentCaller = context.requestCallers.get(request)
  if (!currentCaller) {
    const messageOperation = request.method === 'conversation.start-turn'
      || request.method === 'conversation.initial-turn' || request.method === 'conversation.open'
    if ((request.method === 'conversation.retire-turn' || request.method === 'conversation.steer') && live.kind === 'agent') {
      const prefix = agentChatCorrelation(live.id, '')
      if (!request.correlationId.startsWith(prefix)) unavailable('The addressed turn belongs to another conversation.')
      currentCaller = await agents.turnPrincipalId(live.id, request.correlationId.slice(prefix.length))
    } else {
      currentCaller = messageOperation ? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
        : context.caller ?? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
    }
    if (currentCaller) context.requestCallers.set(request, currentCaller)
  }
  if (!currentCaller || live.kind === 'operator' && live.owner_principal_id !== currentCaller) {
    unavailable('The original conversation caller changed.')
  }
  if (context.changingAccess && request.method === 'conversation.open'
    && (!live.active_request_id || request.mode !== 'attach'
      || request.operationId !== (live.kind === 'agent' ? agentChatCorrelation(live.id, live.active_request_id)
        : nativeCorrelation(live.id, live.active_request_id))
      || !isDeepStrictEqual(request.previousBinding, context.originalBinding))) {
    unavailable('The native access change differs from the admitted Operator message.')
  }
  if (context.changingAccess && request.method === 'conversation.refresh-mcp' && !live.active_request_id) {
    unavailable('A scoped native access change requires its admitted Operator message.')
  }
  const principal = (await currentOperatorAuthority(pool, currentCaller)).principal
  const scope = live.kind === 'agent' ? { workspaceId: live.workspace_id!, workflowId: live.workflow_id!,
    ...(live.record.origin?.runId ? { runId: live.record.origin.runId } : {}) } : {}
  const prefix = live.kind === 'operator' ? 'operator_chat' : 'agent_chat'
  requireAuthorization(principal, `${prefix}:read`, scope)
  if (!reads.has(request.method)) {
    let action: 'operator_chat:cancel' | 'agent_chat:cancel' | 'operator_chat:respond' | 'agent_chat:respond'
      | 'operator_chat:write' | 'agent_chat:write' = `${prefix}:write`
    if (request.method === 'conversation.cancel') action = `${prefix}:cancel`
    if (request.method === 'conversation.respond') action = `${prefix}:respond`
    requireAuthorization(principal, action, scope)
  }
  if (request.method === 'conversation.steer') {
    await assertWorkerSteerAuthority(pool, live, request, currentCaller)
  }
  if (request.method === 'conversation.start-turn' || request.method === 'conversation.initial-turn') {
    const correlation = live.kind === 'operator' ? nativeCorrelation(live.id, live.active_request_id ?? '')
      : agentChatCorrelation(live.id, live.active_request_id ?? '')
    if (!live.active_request_id || request.correlationId !== correlation) unavailable('The admitted chat message changed.')
  }
  if ('session' in request && live.native_session_id && live.native_session_id !== request.session.nativeSessionId) {
    unavailable('The addressed native session changed.')
  }
  if (request.method === 'conversation.open' && request.mode === 'fork') {
    const source = live.record.origin
    if (source?.kind !== 'run_execution' || !source.executionId || !source.runId || !request.source
      || source.sourceNativeSessionId !== request.source.nativeSessionId) unavailable('The Run source does not belong to this chat.')
    const stored = (await pool.query<{ reference: unknown }>(`select s.reference from execution_native_sessions s
      join harness_executions e on e.id=s.execution_id where s.execution_id=$1 and e.run_id=$2`,
    [source.executionId, source.runId])).rows[0]
    if (!stored || !isDeepStrictEqual(NativeSessionReferenceSchema.parse(stored.reference), request.source)) {
      unavailable('The original Run native source is unavailable.')
    }
  }
  return currentCaller
}

async function assertConversationSource(pool: pg.Pool,
  sourceExecution: WorkerConversationOptions['sourceExecution'], live: OwnerRow) {
  if (!sourceExecution) return
  if (live.kind !== 'agent' || live.record.origin?.kind !== 'run_execution'
    || live.record.origin.executionId !== sourceExecution.executionId
    || live.record.origin.runId !== sourceExecution.placement.runId
    || !isDeepStrictEqual(await readExecutionPlacement(pool, sourceExecution.executionId),
      sourceExecution.placement)
    || !isDeepStrictEqual((await readNativePlacement(pool, sourceExecution.executionId))?.workingTree,
      sourceExecution.workingTree)) unavailable('The original Run chat placement changed.')
}

async function readConversationSource(pool: pg.Pool, row: OwnerRow) {
  if (!row.record.sourceConfigurationVersionId) return undefined
  const retained = row.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(row.worker_conversation_binding).sourceExecution : undefined
  if (retained) return retained
  const origin = row.record.origin
  if (origin?.kind !== 'run_execution' || !origin.executionId) unavailable('The original Run chat source is unavailable.')
  const placement = await readExecutionPlacement(pool, origin.executionId)
  const native = await readNativePlacement(pool, origin.executionId)
  if (!placement || !native) unavailable('The original Run chat placement is unavailable.')
  return { executionId: origin.executionId, placement, workingTree: native.workingTree }
}

async function readWorkerConversationProfileFacts(input: ProductionWorkerConversationsInput,
  configuration: WorkerConversationConfiguration, accepted: AcceptedHarnessProfile) {
  const installation = input.registry.pinOverride(accepted.override).installation
  let qualification: HarnessQualification | null = null
  const harness = configuration.harness.harness
  const binary = installation.launcher.resolvedLauncher
  const sha256 = installation.launcher.payloadFingerprints?.find(value => value.path === binary)?.fingerprint
  const revision = harness === 'codex' ? input.suiteRevisions.codex : undefined
  if (harness !== 'claude' && sha256 && revision) {
    qualification = await readInstalledCodexQualification(input.qualifications,
      { target: accepted.override.target, binarySha256: sha256, installation }, revision)
  }
  return WorkerConversationProfileFactsSchema.parse({
    installation: qualification ? { ...installation, observedVersion: qualification.version } : installation,
    override: accepted.override,
    profile: accepted.persistedProof, qualification })
}

function currentWorkerConversationChannel(input: Pick<ProductionWorkerConversationsInput, 'endpoint'>,
  deviceId: string, expected: Readonly<DeviceSessionBinding>) {
  const actual = input.endpoint().captureRequest(deviceId, 'execution-v1')
  if (!actual) unavailable('The selected paired worker channel is unavailable.')
  for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
    if (actual.binding[field] !== expected[field]) unavailable('The original paired worker authority changed.')
  }
  return actual
}

function conversationClaudeAuthority(pool: pg.Pool, owner: ConversationClaudeOwner,
  files: ReturnType<typeof createMainWorkerClaudeFiles> | undefined): NonNullable<WorkerConversationManagerOptions['claudeAuthority']> {
  return async (request, signal) => {
    signal.throwIfAborted()
    const context = request.phase === 'admission' ? undefined : request.identity
    const authority = new PostgresClaudeInteractionAuthority(pool, owner, {
      nativeCallbackContext: (sessionId, toolUseId) => context
        && context.nativeSessionId === sessionId && context.toolUseId === toolUseId ? context : undefined,
    })
    if (request.phase === 'admission') return authority.callbackAdmission()
    const { nativeTurnId, nativeRequestId, nativeRequestType, ...required } = request.identity
    const identity: ClaudeCallbackIdentity = { ...definedProperties(required),
      ...(nativeTurnId !== undefined ? { nativeTurnId } : {}),
      ...(nativeRequestId !== undefined ? { nativeRequestId } : {}),
      ...(nativeRequestType !== undefined ? { nativeRequestType } : {}),
    }
    if (request.phase === 'pending') await authority.publishPending(identity, request.pending)
    else if (request.phase === 'response') await authority.validateResponse(identity, {
      outcome: request.answer.outcome,
      ...(request.answer.reason !== undefined ? { reason: request.answer.reason } : {}),
    })
    else await authority.validate(identity)
    signal.throwIfAborted()
    if (request.phase === 'file') {
      if (!files || identity.nativeTurnId !== undefined) unavailable('This native file callback is unavailable.')
      return files.call(request, identity, signal)
    }
    return { authorized: true }
  }
}

async function admitWorkerConversation(input: ProductionWorkerConversationsInput,
  options: WorkerConversationOptions, context: {
    configuration: WorkerConversationConfiguration
    selector: AcceptedProfileSelector
    owner: ConversationClaudeOwner
    profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
    kind: 'operator' | 'agent'
    bridge: MainWorkerConversationBridge
    caller(): string | undefined
    row(conversationId: string, method?: WorkerConversationRpcRequest['method']): Promise<OwnerRow>
  }, signal: AbortSignal) {
  const { configuration, selector, owner, profiles, kind, bridge, row } = context
  const original = await row(options.conversationId)
  const savedBinding = original.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(original.worker_conversation_binding) : undefined
  const sourceExecution = options.sourceExecution
    ?? await readConversationSource(input.pool, original)
  const assertSource = (live: OwnerRow) => assertConversationSource(input.pool, sourceExecution, live)
  await assertSource(original)
  const directoryBinding = original.kind === 'agent' && original.record.directoryBinding
    ? AgentChatDirectoryBindingSchema.parse(original.record.directoryBinding) : undefined
  if ('agentId' in configuration && directoryBinding) {
    await revalidateAgentChatDirectory(input.pool, configuration, directoryBinding, options.workingDirectory)
  }
  const principalId = context.caller() ?? original.payload?.ownerPrincipalId ?? original.owner_principal_id
  if (!principalId) unavailable('The chat has no admitted sender or control caller.')
  const profileOwner = { ...owner, ...(options.observationPrincipalId
    ? { observationPrincipalId: principalId } : { controlPrincipalId: principalId }), admissionSignal: signal }
  const admissionMethod = options.observationPrincipalId ? 'admitObservation' : 'admit'
  const accepted = await profiles[admissionMethod](profileOwner, selector)
  if (!isDeepStrictEqual(withAdvancedDefaults(accepted.override.configuration), withAdvancedDefaults(configuration.harness))) {
    unavailable('The worker profile differs from this saved chat configuration.')
  }
  const host = selector.target.hostRef
  if (host.kind !== 'device') unavailable('The accepted host is not a device.')
  const channel = input.endpoint().captureRequest(host.deviceId, 'execution-v1')
  if (!channel || channel.binding.mainId !== host.mainId
    || channel.binding.workerInstallationId !== selector.target.applicationInstallationId) {
    unavailable('The selected paired worker channel is unavailable.')
  }
  const currentChannel = () => currentWorkerConversationChannel(input, host.deviceId, channel.binding)
  const ownerFields = 'operatorId' in configuration
    ? { kind: 'operator', operatorId: configuration.operatorId }
    : { kind: 'agent', workspaceId: configuration.workspaceId, agentId: configuration.agentId,
      workflowId: original.workflow_id, workflowNodeId: original.workflow_node_id }
  let executionConfiguration = configuration
  if (savedBinding && savedBinding.owner.configurationVersionId !== configuration.id
    && savedBinding.owner.kind === 'operator' && 'operatorId' in configuration) {
    const previous = await input.operators.configuration(savedBinding.owner.configurationVersionId)
    executionConfiguration = workerExecutionConfiguration(savedBinding, configuration, previous)
  }
  const sessionGeneration = savedBinding?.sessionGeneration ?? original.record.workerSessionGeneration
  const requestedBinding = WorkerConversationBindingSchema.parse({
    ...(original.kind === 'agent' && original.record.workerGeneration ? { generation: original.record.workerGeneration } : {}),
    ...(original.kind === 'agent' && !original.record.workerGeneration && sessionGeneration
      ? { sessionGeneration } : {}),
    owner: { ...ownerFields,
    conversationId: options.conversationId, configurationVersionId: executionConfiguration.id,
    configurationHash: commandInputHash(executionConfiguration) }, harness: configuration.harness.harness,
    profile: selector, workingDirectory: options.workingDirectory, appMcpAccess: options.appMcpAccess,
    accountBinding: await readProviderAccountBinding(input.pool,
      original.kind === 'agent' ? 'agent-conversation' : 'operator-command',
      original.kind === 'agent' ? original.id : `${original.id}:session`)
      ?? legacyProviderAccountBinding(executionConfiguration.harness, executionConfiguration.harnessProfileSelection),
    ...(original.kind === 'agent' && original.record.systemPrompt ? { systemPrompt: original.record.systemPrompt } : {}),
    ...(sourceExecution ? { sourceExecution } : {}),
    ...(sourceExecution && original.record.sourceConfigurationVersionId
      ? { sourceConfigurationVersionId: original.record.sourceConfigurationVersionId } : {}),
    ...(directoryBinding ? { directoryBinding } : {}) })
  if (requestedBinding.owner.kind === 'operator') {
    const rootChannel = input.endpoint().captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
    if (!rootChannel || !isDeepStrictEqual(rootChannel.binding, channel.binding)) {
      unavailable('The selected worker’s approved runtime root is unavailable.')
    }
    const reply = await rootChannel.request({ version: 1, operation: 'workspace-roots.configuration' }, { signal })
    const roots = ApprovedRootAllowlistSchema.parse(reply.payload)
    if (reply.bytes !== undefined || !isDeepStrictEqual(roots.hostRef, host)
      || roots.applicationInstallationId !== selector.target.applicationInstallationId
      || !isDeepStrictEqual(input.endpoint().captureRequest(host.deviceId, 'execution-v1')?.binding, channel.binding)) {
      unavailable('The selected worker root or connection changed.')
    }
    requestedBinding.workingDirectory = workerOperatorDirectory(roots.managedRuntimeRoot, requestedBinding.owner)
    await profiles.revalidate(profileOwner, accepted)
  }
  const originalBinding = savedBinding ?? requestedBinding
  const observationBinding = { ...originalBinding, appMcpAccess: requestedBinding.appMcpAccess }
  const changingAccess = !options.observationPrincipalId && original.native_session_id
    && originalBinding.appMcpAccess !== requestedBinding.appMcpAccess
    && sameConversationForAppAccess(originalBinding, requestedBinding)
  const previousConfiguration = await readRunChatSkillsTransition(input.pool, original,
    originalBinding, requestedBinding, configuration)
    ?? await readAgentChatConfigurationTransition(input.pool, original, originalBinding, requestedBinding, configuration)
  if (previousConfiguration && !validWorkerConfigurationTransition(
    originalBinding, requestedBinding, previousConfiguration, configuration)) {
    unavailable('The saved Agent chat configuration transition changed.')
  }
  const changingSkills = previousConfiguration !== undefined
  if (!changingAccess && !changingSkills
    && !isDeepStrictEqual(options.observationPrincipalId ? observationBinding : originalBinding, requestedBinding)) {
    unavailable('The original worker conversation binding changed.')
  }
  const binding = changingAccess || changingSkills ? requestedBinding : originalBinding
  const requestCallers = new WeakMap<WorkerConversationRpcRequest, string>()
  const current = async (request: WorkerConversationRpcRequest, effectSignal?: AbortSignal, caller = context.caller()) => {
    const cleanup = request.method === 'conversation.release-runtime' || request.method === 'conversation.close'
    const live = await row(options.conversationId, request.method)
    await assertSource(live)
    const configurationId = live.kind === 'operator' ? live.operator_configuration_version_id : live.agent_configuration_version_id
    const savedConfiguration = !cleanup && configurationId !== configuration.id && live.kind === 'operator'
      ? await input.operators.configuration(configurationId!) : undefined
    const presentationChange = savedConfiguration && 'operatorId' in configuration
      && sameOperatorExecutionConfiguration(configuration, savedConfiguration)
    if (live.kind !== kind || !cleanup && configurationId !== configuration.id && !presentationChange
      || 'agentId' in configuration && (live.workspace_id !== configuration.workspaceId || live.agent_id !== configuration.agentId)) {
      unavailable('The original conversation configuration changed.')
    }
    if (live.worker_conversation_binding) {
      const savedBinding = WorkerConversationBindingSchema.parse(live.worker_conversation_binding)
      if (!isDeepStrictEqual(savedBinding, originalBinding) && !isDeepStrictEqual(savedBinding, binding)) {
        unavailable('The persisted worker conversation owner changed.')
      }
    }
    if (live.kind === 'agent' && !isDeepStrictEqual(live.record.systemPrompt, binding.systemPrompt)) {
      unavailable('The saved chat system prompt changed.')
    }
    if ('agentId' in configuration && directoryBinding) {
      if (!isDeepStrictEqual(live.record.directoryBinding, directoryBinding)) unavailable('The saved node directory changed.')
      await revalidateAgentChatDirectory(input.pool, configuration, directoryBinding, binding.workingDirectory)
    }
    const currentCaller = await authorizeWorkerConversationRequest(input.pool, live, request, {
      caller, requestCallers, changingAccess, originalBinding,
    }, input.agents)
    const observation = { ...owner, observationPrincipalId: currentCaller,
      ...(effectSignal ? { admissionSignal: effectSignal } : {}) }
    // Closing a settled owner does not launch or reconfigure its executable.
    if (!cleanup) await profiles[options.observationPrincipalId && reads.has(request.method)
      ? 'revalidateObservation' : 'revalidate'](observation, accepted)
    currentChannel()
  }
  const claudeFiles = configuration.harness.harness === 'claude' && input.fileService
    ? createMainWorkerClaudeFiles({ pool: input.pool, binding: owner, service: input.fileService,
      allowMutation: configuration.harness.sandbox !== 'read-only' }) : undefined
  const manager = new WorkerConversationManager({ binding, configuration: executionConfiguration,
    lifecycle: options.lifecycle ?? 'owner',
    ...(options.applicationAccess ? { applicationAccess: options.applicationAccess } : {}),
    channel, currentChannel, bridge, current,
    currentForDisposal: (request, effectSignal) => current(request, effectSignal, principalId),
    ...(executionConfiguration !== configuration && 'operatorId' in configuration
      ? { acceptedConfiguration: configuration } : {}),
    ...(changingAccess || changingSkills ? { previousBinding: originalBinding } : {}),
    ...(previousConfiguration ? { previousConfiguration } : {}),
    sourceWorkingDirectory: options.workingDirectory,
    ...(configuration.harness.harness === 'codex' && (binding.appMcpAccess === 'none' || options.fileInputs) && input.files
      ? { files: input.files(options.conversationId, configuration, binding.workingDirectory) } : {}),
    ...(configuration.harness.harness === 'claude'
      ? { claudeAuthority: conversationClaudeAuthority(input.pool, owner, claudeFiles) } : {}),
    profile: () => readWorkerConversationProfileFacts(input, configuration, accepted),
    observeSession: async session => {
      const saved = await input.pool.query(`update operator_conversations set worker_conversation_binding=$2::jsonb
        where id=$1 and deleted_at is null
          and record->>'status' is distinct from 'archived'
          and coalesce(operator_configuration_version_id,agent_configuration_version_id)=$4
          and (native_session_id is null or native_session_id=$3)
          and (worker_conversation_binding is null or worker_conversation_binding=$2::jsonb
            or worker_conversation_binding=$5::jsonb)`,
      [options.conversationId, JSON.stringify(binding), session.nativeSessionId, configuration.id,
        changingAccess || changingSkills ? JSON.stringify(originalBinding) : JSON.stringify(binding)])
      if (saved.rowCount !== 1) unavailable('The native worker owner could not be retained.')
    } })
  if (claudeFiles) {
    const dispose = manager.dispose.bind(manager)
    manager.dispose = async () => { try { await dispose() } finally { await claudeFiles.close() } }
  }
  return { manager, inspector: manager.inspector }
}

export function createProductionWorkerConversations(input: ProductionWorkerConversationsInput) {
  const bridge = new MainWorkerConversationBridge()
  const inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  const credentials = new WeakMap<NativeHarnessSessionManager, (
    token: string, signal: AbortSignal) => Promise<unknown>>()
  const row = async (conversationId: string, method?: WorkerConversationRpcRequest['method']) => {
    const result = (await input.pool.query<OwnerRow>(`select c.*,t.payload from operator_conversations c
      left join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      where c.id=$1`, [conversationId])).rows[0]
    const cleanup = method === 'conversation.release-runtime' || method === 'conversation.close'
    if (!result || !cleanup && (result.deleted_at || result.record.status === 'archived')) {
      unavailable('The addressed chat is no longer open.')
    }
    return result
  }
  const create = (options: WorkerConversationOptions) => {
    const configuration = structuredClone(options.configuration)
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const selector = options.profileSelection ?? configuration.harnessProfileSelection
    if (!selector || selector.target.hostRef.kind !== 'device') unavailable('A selected device profile is required.')
    let caller = options.observationPrincipalId
    const kind = 'operatorId' in configuration ? 'operator' : 'agent'
    const owner: ConversationClaudeOwner = 'operatorId' in configuration
      ? { kind: 'operator', conversationId: options.conversationId, repository: input.operators }
      : { kind: 'agent', conversationId: options.conversationId,
        workspaceId: configuration.workspaceId, repository: input.agents }
    const profiles = configuration.harness.harness === 'claude' ? input.claudeProfiles : input.profiles
    const prepared = new Map<string, AcceptedChatInput>()
    let actual: WorkerConversationManager | undefined
    const admitted = createAdmittedNativeManager<WorkerConversationManager>(configuration.harness.harness,
      async signal => {
        const allocation = await admitWorkerConversation(input, options, {
          configuration, selector, owner, profiles, kind, bridge, row, caller: () => caller,
        }, signal)
        actual = allocation.manager
        for (const [correlationId, value] of prepared) actual.restorePreparedInput(correlationId, value)
        prepared.clear()
        return allocation
      })
    Object.assign(admitted.manager, { restorePreparedInput: (correlationId: string, value: AcceptedChatInput) => {
      if (actual) actual.restorePreparedInput(correlationId, value)
      else prepared.set(correlationId, structuredClone(value))
    } })
    admitted.manager.setSessionControlPrincipal = principalId => { caller = principalId }
    admitted.manager.reconcileSessionCreation = async (start, signal, forkSource) => {
      const manager = await admitted.actual(signal)
      return manager.reconcileSessionCreation(start, signal, forkSource)
    }
    admitted.manager.mcpInspectionContext = async signal => {
      const manager = await admitted.actual(signal)
      return manager.mcpInspectionContext!(signal)
    }
    admitted.manager.startInitialTurn = async function* (start, turn, signal) {
      const manager = await admitted.actual(signal)
      if (!manager.startInitialTurn) unavailable('The worker adapter does not support admitted initial input.')
      yield* manager.startInitialTurn(start, turn, signal)
    }
    inspectors.set(admitted.manager, admitted.inspector)
    if (configuration.harness.harness === 'claude' && kind === 'operator' && options.appMcpAccess === 'scoped') {
      credentials.set(admitted.manager, async (token, signal) => {
        const manager = await admitted.actual(signal)
        return manager.deliverClaudeCredential(token, signal)
      })
    }
    return admitted.manager
  }
  const closeRetainedSession = async (conversationId: string, configuration: AgentConfigurationVersion,
    principalId: string, signal: AbortSignal) => {
    const original = await row(conversationId, 'conversation.close')
    const binding = WorkerConversationBindingSchema.parse(original.worker_conversation_binding)
    if (original.kind !== 'agent' || binding.owner.kind !== 'agent'
      || binding.owner.conversationId !== conversationId || binding.owner.workspaceId !== original.workspace_id
      || binding.owner.agentId !== original.agent_id || binding.owner.workflowId !== original.workflow_id
      || binding.owner.workflowNodeId !== original.workflow_node_id
      || binding.owner.configurationVersionId !== configuration.id
      || original.agent_configuration_version_id !== configuration.id
      || binding.owner.configurationHash !== commandInputHash(configuration)) {
      unavailable('The persisted Worker conversation owner changed.')
    }
    const session = NativeSessionReferenceSchema.parse({ harness: original.harness,
      nativeSessionId: original.native_session_id, providerVersion: original.provider_version })
    const host = binding.profile.target.hostRef
    if (host.kind !== 'device') unavailable('The persisted conversation has no Worker host.')
    const channel = input.endpoint().captureRequest(host.deviceId, 'execution-v1')
    if (!channel || channel.binding.mainId !== host.mainId || channel.binding.deviceId !== host.deviceId
      || channel.binding.workerInstallationId !== binding.profile.target.applicationInstallationId) {
      unavailable('The original paired Worker is unavailable.')
    }
    const requestCallers = new WeakMap<WorkerConversationRpcRequest, string>()
    const manager = new WorkerConversationManager({ binding, configuration, channel, bridge,
      current: async (request, effectSignal) => {
        effectSignal?.throwIfAborted()
        const live = await row(conversationId, request.method)
        if (live.kind !== 'agent' || live.agent_configuration_version_id !== configuration.id
          || live.native_session_id !== session.nativeSessionId || live.provider_version !== session.providerVersion
          || live.harness !== session.harness || !isDeepStrictEqual(live.worker_conversation_binding, binding)) {
          unavailable('The persisted Worker session changed before closure.')
        }
        await assertConversationSource(input.pool, binding.sourceExecution, live)
        await authorizeWorkerConversationRequest(input.pool, live, request, {
          caller: principalId, requestCallers, changingAccess: false, originalBinding: binding,
        }, input.agents)
        if (!isDeepStrictEqual(input.endpoint().captureRequest(host.deviceId, 'execution-v1')?.binding,
          channel.binding)) unavailable('The original Worker connection changed.')
      } })
    try { await manager.closeRetainedSession(session, signal) } finally { await manager.dispose() }
  }
  const mcp = new MainWorkerConversationMcp({ pool: input.pool, access: input.access, operators: input.operators,
    profiles: input.profiles, claudeProfiles: input.claudeProfiles, bridge,
    current: deviceId => input.endpoint().captureRequest(deviceId, 'execution-v1')?.binding, forward: input.mcpForward,
    ...(input.agentMcp ? { agent: input.agentMcp } : {}) })
  const closeConversation = async (conversationId: string, signal: AbortSignal) => {
    const original = await row(conversationId, 'conversation.close')
    if (!original.worker_conversation_binding || !original.native_session_id || !original.provider_version) {
      unavailable('The saved Worker session is unavailable for closure.')
    }
    const binding = WorkerConversationBindingSchema.parse(original.worker_conversation_binding)
    const target = binding.profile.target
    if (target.hostRef.kind !== 'device') unavailable('The saved Worker target changed.')
    const deviceId = target.hostRef.deviceId
    const channel = input.endpoint().captureRequest(deviceId, 'execution-v1')
    if (!channel || channel.binding.mainId !== target.hostRef.mainId
      || channel.binding.workerInstallationId !== target.applicationInstallationId) unavailable('The saved Worker is unavailable.')
    const session = NativeSessionReferenceSchema.parse({ harness: binding.harness,
      nativeSessionId: original.native_session_id, providerVersion: original.provider_version })
    const request: WorkerConversationRpcRequest = { method: 'conversation.close', binding, session }
    const requestCallers = new WeakMap<WorkerConversationRpcRequest, string>()
    const lease = bridge.capture({ request, channel, current: async () => {
      signal.throwIfAborted()
      const live = await row(conversationId, 'conversation.close')
      if (!isDeepStrictEqual(live.worker_conversation_binding, binding) || live.native_session_id !== session.nativeSessionId
        || !isDeepStrictEqual(input.endpoint().captureRequest(deviceId, 'execution-v1')?.binding, channel.binding)) {
        unavailable('The saved Worker session changed before closure.')
      }
      await authorizeWorkerConversationRequest(input.pool, live, request,
        { caller: undefined, requestCallers, changingAccess: false, originalBinding: binding }, input.agents)
    } })
    try {
      const reply = await lease.request(signal) as { receipt?: unknown }
      const receipt = WorkerConversationReceiptSchema.parse(reply.receipt)
      if (!receipt.closed || !isDeepStrictEqual(receipt.binding, binding)
        || !isDeepStrictEqual(receipt.session, session)) unavailable('Worker session closure is unconfirmed.')
    } finally { await lease.close() }
  }
  return { create, closeRetainedSession, closeConversation, bridge, mcp, inspector: (manager: NativeHarnessSessionManager) => inspectors.get(manager),
    deliverClaudeCredential: (manager: NativeHarnessSessionManager) => credentials.get(manager),
    close: () => bridge.close() }
}
