import type { SqlQuery } from '../../infrastructure/transaction.js'
import { withWorkflowChatContext } from '../workflow-chat/nativeContext.js'
import { nativeChatPrompt, preflightChatInput, restoreAcceptedChatInput, type AcceptedChatInput, type AcceptedChatSettings, type PreparedChatInput } from './nativeChatInput.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { ReadObservation } from '@foreman-code/contracts'
import { failedReadObservation, successfulReadObservation } from '../diagnostics/readObservation.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { errorMessage } from '../../shared/errorMessage.js'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { ChatResponseAcknowledgment } from '@foreman-code/contracts/interaction-activity'
import { withInteractionResponse, isSessionNativeInteraction } from '@foreman-code/contracts'
import { resolveAgentChatDirectory, revalidateAgentChatDirectory } from './agentChatDirectory.js'
import type { SessionControlRequest } from '@foreman-code/contracts'
import { pendingSessionControls, type ChatModelCatalog } from '../harnesses/sessionControlDefaults.js'
import { readRunChatTranscript } from './runChatTranscript.js'
import { ExecutionActivityReader, type ExecutionActivityRequest } from './executionActivity.js'
import { SessionControlStateSchema } from '@foreman-code/contracts'
import { validateSessionMessage } from './sessionControls/messageAdmission.js'
import { parseSessionCommand, sessionTaskContent } from '@foreman-code/contracts'
import { SessionControlStore } from './sessionControls/store.js'
import { acceptedResponseControl } from './acceptedResponseControl.js'
import { nativeNonSubmission } from './nativeNonSubmission.js'
import { sessionStartConfiguration } from '../harnesses/sessionStart.js'
import { agentConfigurationTransition, agentConfigurationDirectory } from './agentConfigurationTransition.js'
import { pendingInteractionAfterHistory } from './pendingInteractionReadback.js'
import { qualifyChatActivity } from './qualifiedActivity.js'
import { reconcileKnownActivities } from './reconcileKnownActivities.js'
import { knownNativeActivity } from './knownNativeActivity.js'
import { committedNativeText } from './committedNativeText.js'
import { activityTextEnvelope } from './activityTextEnvelope.js'
import { nativeInteractionAvailability } from './interactionAvailability.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { mkdir } from 'node:fs/promises'
import { componentLogger } from '../diagnostics/logger.js'
import { join, resolve } from 'node:path'
import type pg from 'pg'
import type { z } from 'zod'

import {
  ExecutionLocationSchema, NativeSessionReferenceSchema, type AgentConfigurationVersion, type HarnessExecution, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference,
} from '@foreman-code/contracts'
import {
  AgentChatStateSchema, AgentChatStreamEventSchema, SendAgentChatMessageRequestSchema, AgentChatMessageCommandSchema, AgentChatReadbackQuerySchema,
  InterruptAgentChatRequestSchema, CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  type AgentChatBlockedReason, type AgentChatCapabilities, type AgentChatContext, type AgentChatOrigin, type AgentChatQuery,
  type AgentChatSessionState, type AgentChatState, type AgentChatStreamEvent, type AgentChatTurn, type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { RepeatOccurrenceIdentityV1Schema } from '@foreman-code/contracts/wave25'

import { SelectedRunChatKeySchema } from '@foreman-code/contracts/run-snapshots'
import {
  ReadSelectedRunChatRequestSchema, ReadSelectedRunChatResponseSchema, SendSelectedRunChatRequestSchema,
  InterruptSelectedRunChatRequestSchema, type ReadSelectedRunChatResponse,
} from '@foreman-code/contracts/selected-run-chat'
import {
  assertRunChatConversation, findRunChatConversation, resolveRunChatSelection, runChatStorageKey,
  staleRunChat, withRunChatAuthority, type RunChatAuthorityCheck,
} from './selectedRunChat.js'
import { agentActivitySnapshot } from './activitySnapshot.js'
import { AgentChatCommands } from './agentChatCommands.js'
import { requireAuthorization, isAuthorized } from '../access/policy.js'
import { commandInputHash, PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { NativeDeliveryError, NativeTurnNotActiveError } from '../harnesses/errors.js'
import type { NativeHarnessSessionManager, NativeSessionStart, AgentChatNativeSessionStart, NativeMessageSubmission } from '../harnesses/port.js'
import { primeInitialNativeStream } from '../harnesses/claudeSdk/initialStream.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { agentMessagePrompt } from './agentMessagePrompt.js'
import { assertAgentChatInputSize } from './agentInputSize.js'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { currentOperatorHistory, operatorActivity } from './operatorActivity.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { completedNativeAssistantMessage } from './operatorText.js'
import { nativeActivityFence } from './nativeActivityFence.js'
import { createNativeTextStream } from './nativeTextStream.js'
import type { ActivityScope } from '@foreman-code/contracts/activity'
import {
  agentChatCorrelation, agentChatKey, agentConversation, type AgentConversationRow, type AgentChatInterruptTarget, type NewAgentConversation, PostgresAgentChatRepository,
} from './agentChatRepository.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { validateMessageAttachments } from './messageAttachments.js'
import type { ChatSendRequest, DeliveryTarget } from '@foreman-code/contracts'
import type { DeliveryQualification, StoredDelivery } from '../workflow-chat/model.js'
import { ConversationDeliveryOwner, type ConversationTarget } from './conversationDeliveryOwner.js'
import type { PostgresChatDeliveryRepository } from '../workflow-chat/deliveryRepository.js'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import { conversationFeatureContext, type ConversationFeatureContext } from './conversationFeatureSubject.js'
import { installChatDeliveryBridge, operatorDeliveryBridge } from '../workflow-chat/deliveryBridgeAccess.js'
import type { LegacyChatDeliveryBridge } from '../workflow-chat/legacyBridge.js'

/** One native manager per conversation; its process is owned by this service, never by a UI connection. */
export interface AgentChatManagerFactory extends ChatModelCatalog {
  (conversationId: string, configuration: AgentConfigurationVersion, workingDirectory: string,
    accountSource?: { executionId: string }, featureContext?: ConversationFeatureContext): NativeHarnessSessionManager | Promise<NativeHarnessSessionManager>
  recoverCompaction?(configuration: AgentConfigurationVersion, conversationId: string,
    session: NativeSessionReference, start: NativeSessionStart,
    state: import('@foreman-code/contracts').CompactionState, principalId: string, signal: AbortSignal):
    Promise<import('@foreman-code/contracts').CompactionState>
  closeRetainedSession?(conversationId: string, configuration: AgentConfigurationVersion,
    principalId: string, signal: AbortSignal): Promise<void>
  release?(conversationId: string): void
  closeRecoveredSession?(conversationId: string, signal: AbortSignal): Promise<void>
  unavailable?(configuration: AgentConfigurationVersion, workingDirectory: string, executionId?: string):
    Promise<{ reason: AgentChatBlockedReason; message: string } | undefined>
  /** Prepare and retain the actual input frames; this hook performs no native submission. */
  prepareInput?(input: { principalId: string; conversationId: string | null; configuration: AgentConfigurationVersion;
    context: AgentChatContext; workingDirectory: string; request: SendAgentChatMessageRequest; prompt: string;
    row?: AgentConversationRow; sql?: TransactionSql; featureContext: ConversationFeatureContext; settings: AcceptedChatSettings }): Promise<PreparedChatInput>
  /** Reads installed-provider qualification for this exact live owner; a method name is not capability proof. */
  qualifiedSteer?(row: AgentConversationRow, configuration: AgentConfigurationVersion): Promise<boolean>
}

export class AgentChatEvents {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: AgentChatStreamEvent) => void>>()
  private readonly owners = new Set<(event: AgentChatStreamEvent) => void>()
  publish(conversationId: string, type: AgentChatStreamEvent['type'], data: Record<string, unknown>) {
    const event = AgentChatStreamEventSchema.parse({ id: this.sequence++, conversationId, type, data })
    for (const owner of this.owners) owner(event)
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try { listener(event) } catch (error) { logIgnoredError('engine', 'publish conversation event', error) }
    }
  }
  subscribeOwner(listener: (event: AgentChatStreamEvent) => void) { this.owners.add(listener); return () => this.owners.delete(listener) }
  subscribe(id: string, listener: (event: AgentChatStreamEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size && this.listeners.get(id) === listeners) this.listeners.delete(id)
    }
  }
}

export type ConversationFeatureBinder = (input: { conversationId: string; principalId: string;
  context: ConversationFeatureContext; manager: NativeHarnessSessionManager; session: NativeSessionReference;
  correlationId: string; signal: AbortSignal }) => Promise<void | { restart: true }>

interface Runtime {
  manager: NativeHarnessSessionManager
  session?: NativeSessionReference
  creationInput?: NativeSessionStart
  configuration: AgentConfigurationVersion
  featureContextKey?: string
  retiring?: boolean
  acknowledgedCancel?: { requestId: string; nativeId: string }
  disposal?: Promise<void>
  /** Detach only this turn's observer after its durable terminal settlement. */
  observer?: { requestId: string; controller: AbortController }
}

interface Resolution {
  context: AgentChatContext
  key?: string
  executionId?: string
  row?: AgentConversationRow
  blocked?: { reason: AgentChatBlockedReason; message: string }
  /** How a first message would create its native session. */
  create?: Omit<NewAgentConversation, 'context'>
  configuration?: AgentConfigurationVersion
  source?: HarnessExecution
  candidateId?: string
}

function forksRunHistory(row: AgentConversationRow): boolean {
  return row.record.origin.kind === 'run_execution' && !row.record.handoffContext && !row.record.freshSession
}

const STEER_UNAVAILABLE_REASON = 'This harness cannot add input to a running turn. Queue it for the next turn or interrupt and send.'

function failure(error: unknown, code = 'AGENT_CHAT_TURN_FAILED'): ExecutionResult {
  const provider = error && typeof error === 'object' && 'result' in error ? (error as { result?: ExecutionResult }).result?.error : undefined
  return { outcome: 'failed', error: { code: nativeErrorCode(error) ?? code,
    message: provider?.message ?? (errorMessage(error, 'The native turn failed.')), retryable: true } }
}
function definiteRejection(error: unknown): boolean {
  if (error instanceof NativeDeliveryError) {
    return error.operation === 'turn_submission' && error.delivery === 'not_sent'
  }
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  return 'uncertain' in error && error.uncertain === false
}
/** Only the native creation boundary can prove that an unbound attempt created no session. */
class RejectedSessionCreation extends Error {
  constructor(readonly rejection: unknown) {
    super('Native session creation was definitely rejected and its owner was disposed.', { cause: rejection })
  }
}
function definiteNonCreation(error: unknown): boolean {
  return error instanceof NativeDeliveryError
    && error.operation === 'session_creation' && error.delivery === 'not_sent'
}
const EPHEMERAL_SESSION_LOST = 'This ephemeral Codex session is no longer live and cannot be resumed after the API restarts. Start a separate conversation.'
function nativeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const nested = 'result' in error ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
  return nested ?? ('code' in error && typeof error.code === 'string' ? error.code : undefined)
}
function nativeUnavailable(error: unknown): { reason: 'native_session_missing' | 'harness_unavailable'; message: string } | undefined {
  const code = nativeErrorCode(error)
  if (code === 'CODEX_SCOPED_ENVIRONMENT_REQUIRED' || code === 'CODEX_APP_MCP_UNAVAILABLE') {
    return { reason: 'harness_unavailable', message: 'Chat could not verify that the scoped Foreman Code App MCP server was disabled for its native session. Foreman Code workflow tools are not available in chat, and chat never receives App MCP or workflow credentials.' }
  }
  if (code && ['CODEX_MCP_CONFIG_INVALID', 'CODEX_ENVIRONMENT_INVALID'].includes(code)) {
    return { reason: 'harness_unavailable', message: 'The native credential does not match the accepted conversation scope; check the native configuration.' }
  }
  if (code === 'AGENT_CHAT_EPHEMERAL_SESSION_LOST') return { reason: 'native_session_missing', message: EPHEMERAL_SESSION_LOST }
  if (code === 'NATIVE_SESSION_CREATION_STATE_LOST') {
    return { reason: 'native_session_missing', message: 'The original native session creation can no longer be recovered. This conversation is read-only; no input was resent.' }
  }
  if (code && (/SESSION_NOT_FOUND|THREAD_NOT_FOUND|SESSION_ID_MISMATCH|SETTING_UNSUPPORTED|VERSION_MISMATCH/.test(code)
    || code === 'AGENT_CHAT_FORK_UNAVAILABLE')) {
    return { reason: 'native_session_missing', message: 'The native session or Run source no longer exists or cannot be continued. No replacement session was created.' }
  }
  return undefined
}

function intervalTick(execution: HarnessExecution): number {
  const input = execution.input
  const tick = input && typeof input === 'object' && !Array.isArray(input) ? input.tick : undefined
  const index = tick && typeof tick === 'object' && !Array.isArray(tick) ? tick.index : undefined
  return typeof index === 'number' ? index : 0
}

export class AgentChatService {
  get deliveryBridge(): LegacyChatDeliveryBridge | undefined { return operatorDeliveryBridge(this) }
  installDeliveryBridge(bridge: LegacyChatDeliveryBridge): void { installChatDeliveryBridge(this, bridge) }

  async assertContextReadable(principal: ManagementPrincipal, workspaceId: string, query: AgentChatQuery): Promise<void> {
    const scope = { workspaceId, ...query }
    this.authorize(principal, 'agent_chat:read', scope)
    this.authorize(await readLiveManagementPrincipal(this.pool, principal.id), 'agent_chat:read', scope)
  }

  async hasDeliveryConversation(id: string): Promise<boolean> { return Boolean(await this.repository.get(id)) }

  async retainedConversationTarget(principal: ManagementPrincipal, workspaceId: string, conversationId: string): Promise<DeliveryTarget> {
    const row = (await this.pool.query<Pick<AgentConversationRow, 'workspace_id' | 'workflow_id' | 'workflow_node_id' | 'agent_id'>>(
      "select workspace_id,workflow_id,workflow_node_id,agent_id from operator_conversations where kind='agent' and id=$1",
    [conversationId])).rows[0]
    const target: DeliveryTarget | undefined = row ? { kind: 'agent_conversation', conversationId, agent: {
      workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, agentId: row.agent_id } }
      : (await this.pool.query<{ target: DeliveryTarget }>(`select request->'target' as target from chat_delivery_commands
        where workspace_id=$1 and request->'target'->>'kind'='agent_conversation'
          and request->'target'->>'conversationId'=$2 limit 1`, [workspaceId, conversationId])).rows[0]?.target
    if (!target || target.kind !== 'agent_conversation' || target.agent.workspaceId !== workspaceId) {
      throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    }
    await this.authorizeDelivery(principal, target, 'read')
    return target
  }

  async assertLegacyTargetLocked(tx: TransactionSql, target: DeliveryTarget, query: AgentChatQuery,
    expected: string | null): Promise<void> {
    if (target.kind !== 'agent_conversation') return
    await lockActiveWorkspace(tx, target.agent.workspaceId)
    const row = await this.repository.get(target.conversationId, tx)
    const key = row?.agent_key ?? agentChatKey({ workspaceId: target.agent.workspaceId, ...query })
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${key}`])
    const current = await this.repository.get(target.conversationId, tx)
    if ((current?.id ?? null) !== expected) throw new DomainError('CHAT_TARGET_CHANGED', 'The observed conversation changed before admission.', 409)
  }

  async deliveryEnvelope(principal: ManagementPrincipal, workspaceId: string, id: string, requestId: string) {
    const state = await this.readConversation(principal, workspaceId, id)
    const turn = await this.repository.turn(id, requestId)
    return { state, ...(turn ? { turn } : {}) }
  }

  /** Old native journals retain their original targetless replay semantics before any fresh target resolution. */
  async replayLegacyDelivery(principal: ManagementPrincipal, workspaceId: string, input: SendAgentChatMessageRequest) {
    const context = { workspaceId, ...input.context }
    this.authorize(principal, 'agent_chat:read', context)
    this.authorize(await readLiveManagementPrincipal(this.pool, principal.id), 'agent_chat:read', context)
    const rows = (await this.pool.query<AgentConversationRow>(`select c.* from operator_conversations c
      join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$5
      where c.kind='agent' and c.workspace_id=$1 and c.workflow_id=$2 and c.workflow_node_id=$3 and c.agent_id=$4
        and c.origin_run_id is not distinct from $6::text
        and ($7::text is null or c.id=$7) order by c.created_at desc limit 2`,
    [workspaceId, input.context.workflowId, input.context.workflowNodeId, input.context.agentId, input.requestId,
      input.context.runId ?? null, input.expectedConversationId])).rows
    if (!rows.length) return undefined
    if (rows.length !== 1) throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'Select the original conversation to read this command.', 409)
    const row = rows[0]!
    const replay = await this.repository.admit({ key: row.agent_key, request: input, context, delivery: 'queued',
      assertCurrent: async tx => { this.authorize(await readLiveManagementPrincipal(tx, principal.id), 'agent_chat:read', context) } })
    return { state: await this.readConversation(principal, workspaceId, row.id), turn: replay.turn, replayed: true,
      ...(replay.replayWarning ? { replayWarning: replay.replayWarning } : {}) }
  }
  private readonly activityObservations = new Map<string, ReadObservation>()
  private readonly pendingObservations = new Map<string, ReadObservation>()
  readonly events = new AgentChatEvents()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tasks = new Map<string, Promise<void>>()
  /** Live preparation is not orphan recovery, including the create-to-bind gap. */
  private readonly preparations = new Map<string, { requestId: string; done: Promise<void> }>()
  private readonly wakeups = new Set<string>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflightCommands = new Set<Promise<unknown>>()
  private recovery: Promise<void> | undefined
  private shutdownAttempt: Promise<void> | undefined
  private readonly activity: PostgresOperatorActivityRepository
  private readonly sessionControls: SessionControlStore
  private readonly executionActivityReader: ExecutionActivityReader
  private canonicalDelivery: ConversationDeliveryOwner | undefined
  private featureContextBinder: ConversationFeatureBinder | undefined
  installFeatureContextBinder(bind: ConversationFeatureBinder): void { this.featureContextBinder = bind }

  private readonly commands: AgentChatCommands
  private readonly lifetime = new AbortController()
  private closing = false

  constructor(
    private readonly pool: pg.Pool,
    private readonly repository: PostgresAgentChatRepository,
    private readonly messages: PostgresOperatorConversationRepository,
    private readonly workflows: Pick<PostgresWorkflowRepository, 'getSavedVersion' | 'getCurrentSavedVersion' | 'getAgentConfiguration'>,
    /** Read-only: chat never writes Runs, executions or their native lanes. */
    private readonly runs: Pick<PostgresRunRepository, 'getForWorkspace' | 'executionPages' | 'getExecution'>,
    private readonly managers: AgentChatManagerFactory,
    private readonly runtimeRoot: string,
  ) {
    this.activity = new PostgresOperatorActivityRepository(pool)
    this.commands = new AgentChatCommands(pool)
    this.sessionControls = new SessionControlStore(pool, 'agent')
    this.executionActivityReader = new ExecutionActivityReader(pool)
  }

  /** Publish command ownership before the first await so shutdown also drains admission/readback. */
  private command<T>(operation: () => Promise<T>): Promise<T> {
    const next = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.inflightCommands.add(next)
    void next.finally(() => this.inflightCommands.delete(next)).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return next
  }

  /** Serialize native lifecycle decisions per conversation. */
  private control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(id) ?? Promise.resolve()
    const next = previous.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ }).then(() => { this.assertOpen(); return operation() })
    this.controls.set(id, next)
    void next.finally(() => { if (this.controls.get(id) === next) this.controls.delete(id) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return next
  }
  private assertOpen() {
    if (this.closing) throw new DomainError('AGENT_CHAT_CLOSING', 'Agent chat is shutting down.', 503)
  }
  private authorize(principal: ManagementPrincipal, action: ManagementAction, context: Pick<AgentChatContext, 'workspaceId' | 'workflowId' | 'runId'>) {
    requireAuthorization(principal, action, { workspaceId: context.workspaceId, workflowId: context.workflowId, ...(context.runId ? { runId: context.runId } : {}) })
  }
  private async conversation(workspaceId: string, id: string, principal: ManagementPrincipal, action: ManagementAction) {
    const row = await this.repository.get(id)
    if (!row || row.workspace_id !== workspaceId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    this.authorize(principal, action, { workspaceId, workflowId: row.workflow_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) })
    const live = await readLiveManagementPrincipal(this.pool, principal.id)
    this.authorize(live, action, { workspaceId, workflowId: row.workflow_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) })
    // Commands return transcript/activity/approval state: check its authority
    // before command reservation or any native/database mutation, also on replay.
    if (action !== 'agent_chat:read') this.authorize(live, 'agent_chat:read', { workspaceId, workflowId: row.workflow_id,
      ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) })
    if (action === 'agent_chat:write' && row.record.archived) {
      throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'This conversation is in history. Use the current conversation.', 409)
    }
    if (action !== 'agent_chat:read' && row.record.origin.kind === 'run_execution'
      && row.native_session_id === row.record.origin.sourceNativeSessionId) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'A Run source session cannot be controlled as a chat session.', 409)
    }
    return row
  }

  // ---------------------------------------------------------------- context

  private async resolve(context: AgentChatContext, executionId?: string, selectedRun = false, read?: {
    sql: SqlQuery
    run?: Awaited<ReturnType<PostgresRunRepository['getForWorkspace']>>
    source: HarnessExecution | undefined
  }): Promise<Resolution> {
    const sql = read?.sql ?? this.pool
    const workflows = read ? new PostgresWorkflowRepository(sql) : this.workflows
    let key = agentChatKey(context)
    let row = selectedRun && context.runId && executionId
      ? await findRunChatConversation(sql, context, executionId) : await this.repository.byKey(key, sql)
    const blocked = (reason: AgentChatBlockedReason, message: string): Resolution => ({ context, key,
      ...(executionId ? { executionId } : {}), ...(row ? { row } : {}), blocked: { reason, message } })
    if (context.runId) {
      const run = read ? read.run : await this.runs.getForWorkspace(context.workspaceId, context.runId)
        .catch(ignoreError('engine', 'load selected run for chat context', { workspaceId: context.workspaceId, runId: context.runId }))
      if (!run || run.id !== context.runId || run.workflowId !== context.workflowId) return blocked('context_stale', 'The selected Run does not belong to this workflow.')
      const version = await workflows.getSavedVersion(run.workflowVersionId)
      const node = version?.definition.nodes.find((entry) => entry.id === context.workflowNodeId)
      if (node?.kind === 'job') return { context, key, blocked: { reason: 'agent_missing', message: 'Jobs do not support Agent chat.' } }
      if (!version || !node || node.agentId !== context.agentId) {
        return blocked('agent_missing', 'This Agent is not part of the selected Run.')
      }
      if (row) {
        assertRunChatConversation(row, context, executionId)
        // A continued conversation stays on its original execution, including after another attempt.
        executionId ??= row.origin_execution_id ?? undefined
      }
      const block = version.definition.repeat?.blocks.find((entry) => entry.nodeIds.includes(context.workflowNodeId))
      let source: HarnessExecution | undefined
      let sourceOccurrence = 0, sourceTick = 0
      let pages: AsyncIterable<HarnessExecution[]> | Iterable<HarnessExecution[]>
      if (read) pages = [read.source ? [read.source] : []]
      else if (executionId) {
        const exactExecution = await this.runs.getExecution(executionId)
        pages = [exactExecution ? [exactExecution] : []]
      } else pages = this.runs.executionPages(run.id)
      for await (const page of pages) {
        for (const execution of page) {
          if (executionId && execution.id !== executionId) continue
          if (execution.runId !== run.id || execution.workflowNodeId !== context.workflowNodeId || execution.agentId !== context.agentId) {
            if (executionId) staleRunChat()
            continue
          }
          let occurrenceIndex = 0
          const tick = intervalTick(execution)
          if (block) {
            const input = execution.input
            const occurrence = input && typeof input === 'object' && !Array.isArray(input) ? input.occurrence : undefined
            const parsed = RepeatOccurrenceIdentityV1Schema.safeParse(
              occurrence && typeof occurrence === 'object' && !Array.isArray(occurrence) ? occurrence.identity : undefined)
            if (!parsed.success || parsed.data.blockId !== block.id || parsed.data.scope.runId !== run.id
              || parsed.data.scope.workspaceId !== context.workspaceId || parsed.data.scope.workflowId !== context.workflowId
              || parsed.data.scope.workflowVersionId !== run.workflowVersionId) {
              return blocked('context_stale', 'The selected Run execution has no matching business occurrence identity.')
            }
            occurrenceIndex = parsed.data.occurrenceIndex
          }
          // The legacy unpinned entrypoint retains its latest-occurrence policy. SCH-06 always
          // supplies an explicit execution after snapshot resolution; it never takes this fallback.
          // Interval checks of one node share occurrence 0: the latest check is the current execution.
          if (!source || occurrenceIndex > sourceOccurrence || occurrenceIndex === sourceOccurrence
            && (tick > sourceTick || tick === sourceTick && execution.attempt > source.attempt)) {
            source = execution; sourceOccurrence = occurrenceIndex; sourceTick = tick
          }
        }
      }
      if (!source) {
        if (executionId) staleRunChat()
        if (run.executionState !== 'completed' && run.executionState !== 'interrupted') {
          return blocked('run_active', 'Waiting for this Agent’s execution to start. Its public transcript will appear here.')
        }
        return blocked('native_session_missing', 'This Run has no stored execution for this Agent.')
      }
      executionId = source.id
      row ??= await findRunChatConversation(sql, context, executionId)
      if (row) assertRunChatConversation(row, context, executionId, source)
      key = row?.agent_key ?? runChatStorageKey(context, executionId)
      const sourceResolution = { context, key, executionId, source, ...(row ? { row } : {}) }
      const pinned = await workflows.getAgentConfiguration(row?.agent_configuration_version_id ?? source.agentConfigurationVersionId)
      const configuration = pinned && (node.skills || node.browser?.enabled)
        ? configurationWithNodeSkills(pinned, node.skills, version.nodeSkillSnapshots?.[node.id], node.browser) : pinned
      if (!configuration) return { ...sourceResolution, blocked: { reason: 'agent_missing',
        message: 'The Agent configuration used by this Run is unavailable. Its transcript remains readable.' } }
      if (configuration.harness.harness === 'opencode') {
        return { ...sourceResolution, configuration, blocked: { reason: 'harness_unavailable', message: RETIRED_OPENCODE_MESSAGE } }
      }
      if ((row?.record.sourceConfigurationVersionId ?? configuration.id) !== source.agentConfigurationVersionId || configuration.agentId !== context.agentId
        || row && row.harness !== configuration.harness.harness) staleRunChat()
      if (source.state !== 'completed') {
        return { ...sourceResolution, configuration, blocked: { reason: 'run_active',
          message: source.state === 'queued' || source.state === 'starting'
            ? 'Starting — you can message it when it finishes' : 'Working — you can message it when it finishes' } }
      }
      if (row) {
        const unavailable = this.sessionUnavailable(row, configuration)
          ?? (!row.native_session_id && !row.record.freshSession && (!source.nativeSessionId || !source.workingDirectory || source.state !== 'completed'
            || configuration.harness.harness === 'codex' && configuration.harness.advanced?.sessionPersistence === 'ephemeral')
            ? { reason: 'native_session_missing' as const, message: 'The Run source cannot be forked. Stored chat messages remain readable; no replacement session will be created.' }
            : undefined)
        return { ...sourceResolution, configuration, ...(unavailable ? { blocked: unavailable } : {}) }
      }
      if (!source.nativeSessionId || !source.workingDirectory || source.state !== 'completed') {
        return { ...sourceResolution, configuration, blocked: { reason: 'native_session_missing',
          message: 'This execution has no resumable stored native session. Its transcript remains readable.' } }
      }
      if (configuration.harness.harness === 'codex' && configuration.harness.advanced?.sessionPersistence === 'ephemeral') {
        return { ...sourceResolution, configuration, blocked: { reason: 'native_session_missing',
          message: 'This execution used an ephemeral Codex session. Its transcript remains readable; follow-up chat is unavailable.' } }
      }
      return { ...sourceResolution, configuration, create: {
        agentConfigurationVersionId: configuration.id, harness: configuration.harness.harness,
        origin: { kind: 'run_execution', runId: run.id, executionId, sourceNativeSessionId: source.nativeSessionId },
        workingDirectory: source.workingDirectory, runtimeDirectory: '',
        ...(source.systemPrompt ? { systemPrompt: source.systemPrompt } : {}),
      } }
    }
    const version = await workflows.getCurrentSavedVersion(context.workspaceId, context.workflowId)
    if (!version) return blocked('context_stale', 'The workflow was not found.')
    const node = version.definition.nodes.find((entry) => entry.id === context.workflowNodeId)
    if (node?.kind === 'job') return { context, key, blocked: { reason: 'agent_missing', message: 'Jobs do not support Agent chat.' } }
    if (!node || node.agentId !== context.agentId) {
      return blocked('agent_missing', 'This Agent is no longer part of the saved workflow.')
    }
    if (row) {
      const configuration = await workflows.getAgentConfiguration(row.agent_configuration_version_id)
      const unavailable = this.sessionUnavailable(row, configuration)
      if (configuration && row.record.directoryBinding) {
        try { await revalidateAgentChatDirectory(sql, configuration, row.record.directoryBinding, row.record.workingDirectory) }
        catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'AGENT_CHAT_DIRECTORY_UNAVAILABLE') throw error
          return { ...blocked('context_stale', error.message), configuration }
        }
      }
      return { context, row, ...(configuration ? { configuration } : {}), ...(unavailable ? { blocked: unavailable } : {}) }
    }
    const agent = (await sql.query<{ current_configuration_version_id: string | null; archived_at: Date | null }>(
      'select current_configuration_version_id,archived_at from agents where workspace_id=$1 and id=$2', [context.workspaceId, context.agentId])).rows[0]
    if (!agent || agent.archived_at || !agent.current_configuration_version_id) return blocked('agent_missing', 'This Agent has no saved configuration.')
    const configurationId = node.placement ? version.agentConfigurationVersionIds[context.agentId]
      : agent.current_configuration_version_id
    const configuration = configurationId ? await workflows.getAgentConfiguration(configurationId) : undefined
    if (!configuration) return blocked('agent_missing', 'This Agent has no saved configuration.')
    if (configuration.harness.harness === 'opencode') return { ...blocked('harness_unavailable', RETIRED_OPENCODE_MESSAGE), configuration }
    const workspace = (await sql.query<{ execution_location: unknown }>('select execution_location from workspaces where id=$1', [context.workspaceId])).rows[0]
    const location = ExecutionLocationSchema.safeParse(workspace?.execution_location)
    let directory
    try { directory = await resolveAgentChatDirectory({ sql, configuration, workflowVersionId: version.id,
      ...(node.placement ? { placement: node.placement } : {}), ...(location.success ? { location: location.data } : {}) }) }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'AGENT_CHAT_DIRECTORY_UNAVAILABLE') throw error
      return { ...blocked('execution_location_missing', error.message), configuration }
    }
    const generation = (await sql.query<{ id: string }>(`select id from operator_conversations
      where kind='agent' and workspace_id=$1 and workflow_id=$2 and workflow_node_id=$3 and agent_id=$4
      order by created_at desc,id desc limit 1`, [context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId])).rows[0]?.id ?? null
    const candidateId = `agent-chat:${commandInputHash({ context, workflowVersionId: version.id,
      configurationVersionId: configuration.id, directory, generation }).slice(7)}`
    return { context, configuration, candidateId, create: {
      id: candidateId,
      agentConfigurationVersionId: configuration.id, harness: configuration.harness.harness, origin: { kind: 'fresh' },
      ...directory, runtimeDirectory: '',
    } }
  }

  private capabilities(configuration: AgentConfigurationVersion | undefined, row?: AgentConversationRow): AgentChatCapabilities {
    const harness = configuration?.harness.harness ?? row?.harness ?? 'codex'
    const providerVersion = row?.provider_version ?? null
    if (harness === 'opencode') return { harness, providerVersion, steer: 'unavailable',
      interruptAndSend: false, queueNextTurn: false, resume: false,
      unavailable: { steer: RETIRED_OPENCODE_MESSAGE, resume: RETIRED_OPENCODE_MESSAGE } }
    const unavailable = row ? this.sessionUnavailable(row, configuration) : undefined
    if (harness === 'codex') {
      return { harness, providerVersion, steer: 'native_expected_turn', interruptAndSend: true, queueNextTurn: true, resume: !unavailable,
        unavailable: unavailable ? { resume: unavailable.message } : {} }
    }
    return { harness, providerVersion, steer: 'unavailable', interruptAndSend: true, queueNextTurn: true, resume: !unavailable,
      unavailable: { steer: STEER_UNAVAILABLE_REASON, ...(unavailable ? { resume: unavailable.message } : {}) } }
  }

  private sessionUnavailable(row: AgentConversationRow, configuration: AgentConfigurationVersion | undefined): Resolution['blocked'] {
    if (row.harness === 'opencode' || configuration?.harness.harness === 'opencode') {
      return { reason: 'harness_unavailable', message: RETIRED_OPENCODE_MESSAGE }
    }
    if (!configuration) return { reason: 'agent_missing', message: 'The pinned Agent configuration is unavailable; the transcript remains readable.' }
    if (!row.native_session_id && row.record.sessionCreation && row.turn_state === 'uncertain') {
      return { reason: 'native_session_missing', message: 'Native session creation is unconfirmed. Wait for recovery before sending another message.' }
    }
    if (!row.native_session_id && (row.provider_version || row.record.startupDelivered || row.record.startupReceipt)) {
      return { reason: 'native_session_missing', message: 'This conversation lost its stored native session identity. The transcript remains readable; a replacement session will not be created.' }
    }
    if (row.native_session_id && !row.provider_version) return { reason: 'native_session_missing', message: 'The stored native session has no provider version and cannot be resumed.' }
    if (row.record.origin.kind === 'run_execution' && row.native_session_id === row.record.origin.sourceNativeSessionId) {
      return { reason: 'harness_unavailable', message: 'Chat cannot use the Run-owned native session directly. A separate native fork is required.' }
    }
    if (row.record.sessionUnavailable) return { reason: row.record.sessionUnavailableReason ?? 'native_session_missing', message: row.record.sessionUnavailable }
    const runtime = this.runtimes.get(row.id)
    if (runtime?.retiring && !runtime.disposal) return { reason: 'harness_unavailable', message: 'Native cleanup is unconfirmed. This conversation cannot start more work until its owner is safely disposed.' }
    if (row.native_session_id && configuration?.harness.harness === 'codex'
      && configuration.harness.advanced?.sessionPersistence === 'ephemeral'
      && runtime?.session?.nativeSessionId !== row.native_session_id) {
      return { reason: 'native_session_missing', message: EPHEMERAL_SESSION_LOST }
    }
    return undefined
  }

  private async markNativeUnavailable(id: string, error: unknown): Promise<boolean> {
    const unavailable = nativeUnavailable(error)
    if (!unavailable) return false
    await this.repository.markSessionUnavailable(id, unavailable.message, unavailable.reason)
    this.events.publish(id, 'state', { sessionState: 'unavailable', reason: unavailable.reason })
    return true
  }

  private sessionState(row: AgentConversationRow | undefined): AgentChatSessionState {
    if (!row) return 'none'
    if (row.record.sessionUnavailable) return 'unavailable'
    switch (row.turn_state) {
      case 'starting': return row.native_session_id ? 'active' : 'creating'
      case 'active': return row.pending_interaction ? 'waiting_approval' : 'active'
      case 'canceling': return 'interrupting'
      case 'uncertain': return row.active_request_id ? 'uncertain' : 'idle'
      case 'error': return 'error'
      default: return 'idle'
    }
  }

  private async state(resolution: Resolution, principal: ManagementPrincipal): Promise<AgentChatState> {
    const { context } = resolution
    const livePrincipal = await readLiveManagementPrincipal(this.pool, principal.id)
    this.authorize(livePrincipal, 'agent_chat:read', context)
    const sourceTranscript = resolution.source ? await readRunChatTranscript(this.pool, resolution.source) : undefined
    const blocked = resolution.blocked ?? await this.harnessUnavailable(resolution)
    const capabilities = this.capabilities(resolution.configuration, resolution.row)
    capabilities.steer = resolution.row && await this.hasQualifiedSteer(resolution.row.id) ? 'native_expected_turn' : 'unavailable'
    if (blocked && ['native_session_missing', 'harness_unavailable', 'agent_missing'].includes(blocked.reason)) {
      capabilities.resume = false; capabilities.queueNextTurn = false; capabilities.interruptAndSend = false
      capabilities.steer = 'unavailable'
      capabilities.unavailable = { resume: blocked.message, queueNextTurn: blocked.message,
        interruptAndSend: blocked.message, steer: blocked.message }
    }
    const availability = blocked ? { canSend: false, reason: blocked.reason, message: blocked.message } : { canSend: true, message: 'Chat uses this Agent’s accepted configuration and scoped workflow capabilities.' }
    if (!resolution.row) {
      const finalPrincipal = await readLiveManagementPrincipal(this.pool, principal.id)
      this.authorize(finalPrincipal, 'agent_chat:read', context)
      return AgentChatStateSchema.parse({ context, conversation: null, sessionState: 'none', availability, capabilities,
        ...(sourceTranscript ? { sourceTranscript } : {}),
        activeTurn: null, turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 0,
        qualificationKey: commandInputHash({ principal: finalPrincipal, configurationId: resolution.configuration?.id ?? null,
          availability, capabilities }).slice(7) })
    }
    let loaded = await this.repository.state(resolution.row.id, { recoverOverflow: true })
    if (!loaded) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    const resident = this.runtimes.get(loaded.row.id)
    resident?.manager.setSessionControlPrincipal?.(livePrincipal.id)
    if (!blocked && resident?.configuration.id === loaded.row.agent_configuration_version_id
      && !loaded.row.active_request_id && !loaded.row.pending_interaction && resident?.session
      && !resident.retiring && !resident.disposal
      && !await this.pendingConfiguration(loaded.row)) {
      let pending: Awaited<ReturnType<NativeHarnessSessionManager['pending']>>
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(1_000)])
      try {
        pending = await resident.manager.pending(resident.session, signal)
        this.pendingObservations.set(loaded.row.id, successfulReadObservation())
      } catch (error) {
        const retired = resident.retiring || resident.disposal || this.runtimes.get(loaded.row.id) !== resident
        const timedOut = signal.aborted && !this.lifetime.signal.aborted
        const offline = timedOut || error instanceof DeviceConnectionError && ['transport', 'timeout', 'unavailable'].includes(error.code)
          || error instanceof DomainError && error.code === 'WORKER_CONVERSATION_UNAVAILABLE'
        const profileUnavailable = error instanceof DomainError && error.code === 'HARNESS_PROFILE_UNAVAILABLE'
        if (!retired && !offline && !profileUnavailable) throw error
        if (retired) {
          componentLogger('harness').debug({ conversationId: loaded.row.id,
            error: errorMessage(error, 'The pending interaction read ended during native cleanup.') },
          'Refreshing chat after its pending interaction reader retired')
          return this.readConversation(principal, context.workspaceId, loaded.row.id)
        }
        if (offline || profileUnavailable) {
          let message = 'The chat Worker is unavailable; pending interactions could not be refreshed'
          if (profileUnavailable) message = 'The saved harness profile is unavailable; pending interactions could not be refreshed'
          const observation = failedReadObservation(this.pendingObservations.get(loaded.row.id), timedOut ? signal.reason : error,
            message)
          this.pendingObservations.set(loaded.row.id, observation)
          componentLogger('harness').warn({ conversationId: loaded.row.id, ...observation },
            'Agent chat pending interaction refresh unavailable')
        }
      }
      if (pending && isSessionNativeInteraction(pending)) {
        await this.repository.pending(loaded.row.id, null, pending)
        loaded = await this.repository.state(loaded.row.id, { recoverOverflow: true })
        if (!loaded) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      }
    }
    const { row } = loaded
    if (loaded.hasMoreTurns) {
      availability.canSend = false
      availability.message = [availability.message,
        'This chat has more than 100 unfinished messages. Only a recovery window is shown. Cancel queued messages to free capacity; Stop chat also cancels all queued messages when available. Unconfirmed deliveries still require native evidence.']
        .filter(Boolean).join(' ')
    }
    if (loaded.hasMoreActivities) {
      availability.message = [availability.message,
        'This chat has more than 100 unfinished tools or subagents. Only 100 unfinished entries are shown; additional work remains in activity history.']
        .filter(Boolean).join(' ')
    }
    const runtime = this.runtimes.get(row.id)
    const responseAvailability = row.pending_interaction ? await nativeInteractionAvailability(row.pending_interaction,
      isAuthorized(livePrincipal, 'agent_chat:respond', { workspaceId: row.workspace_id, workflowId: row.workflow_id,
        ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }),
      !blocked && runtime?.session ? { manager: runtime.manager, session: runtime.session } : undefined,
      { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
        isCurrent: () => this.runtimes.get(row.id) === runtime && !!runtime?.session && !runtime.disposal && !this.closing }) : undefined
    const finalPrincipal = await readLiveManagementPrincipal(this.pool, principal.id)
    this.authorize(finalPrincipal, 'agent_chat:read', context)
    const qualifiedResponse = responseAvailability && !isAuthorized(finalPrincipal, 'agent_chat:respond', { workspaceId: context.workspaceId, workflowId: context.workflowId, ...(context.runId ? { runId: context.runId } : {}) })
      ? { ...responseAvailability, available: false, status: 'unavailable' as const, path: null,
        reason: 'unauthorized' as const, message: 'Your current grants do not allow responding to this interaction.' } : responseAvailability
    const pendingObservation = this.pendingObservations.get(row.id)
    const observation = pendingObservation?.status === 'unavailable' ? pendingObservation
      : this.activityObservations.get(row.id) ?? pendingObservation
    const activitySnapshot = { ...qualifyChatActivity(agentActivitySnapshot(loaded), qualifiedResponse),
      ...(observation ? { observation } : {}) }
    const qualificationKey = commandInputHash({ principal: finalPrincipal, configurationId: resolution.configuration?.id ?? null,
      availability, capabilities, scope: activitySnapshot.scope, revision: activitySnapshot.revision,
      sourceRevisions: 'sourceRevisions' in activitySnapshot ? activitySnapshot.sourceRevisions : null,
      responseAvailability: qualifiedResponse ?? null }).slice(7)
    const activities = loaded.activityPage.activities
    return AgentChatStateSchema.parse({
      context, conversation: agentConversation(row), sessionState: this.sessionUnavailable(row, resolution.configuration)
        || blocked && ['native_session_missing', 'harness_unavailable', 'agent_missing'].includes(blocked.reason)
        ? 'unavailable' : this.sessionState(row), availability, capabilities,
      activeTurn: row.active_request_id ? { requestId: row.active_request_id,
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}), startedAt: loaded.activeStartedAt?.toISOString() ?? loaded.turns.find((turn) => turn.requestId === row.active_request_id)?.createdAt ?? row.created_at.toISOString() } : null,
      turns: loaded.turns, messages: loaded.messages, hasEarlierMessages: loaded.hasEarlierMessages, activities,
      ...(sourceTranscript ? { sourceTranscript } : {}),
      ...(loaded.hasMoreTurns ? { hasMoreTurns: true } : {}),
      ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
      ...(row.last_result ? { lastResult: row.last_result } : {}),
      revision: Number(row.revision), activitySnapshot, qualificationKey,
      ...(qualifiedResponse ? { responseAvailability: qualifiedResponse } : {}),
    })
  }

  private async harnessUnavailable(resolution: Resolution): Promise<Resolution['blocked']> {
    if (!this.managers.unavailable) return undefined
    const row = resolution.row
    const pending = row ? await this.pendingConfiguration(row) : undefined
    if (pending) return this.managers.unavailable?.(pending, row!.record.workingDirectory)
    const executionId = resolution.row?.record.sourceConfigurationVersionId
      ? undefined : resolution.executionId ?? resolution.row?.origin_execution_id
    const workingDirectory = resolution.row?.record.workingDirectory ?? resolution.create?.workingDirectory
    if ((!executionId && !resolution.row?.record.sourceConfigurationVersionId)
      || !workingDirectory || !resolution.configuration) return undefined
    return this.managers.unavailable?.(resolution.configuration, workingDirectory, executionId ?? undefined)
  }

  async read(principal: ManagementPrincipal, workspaceId: string, query: AgentChatQuery) {
    const context: AgentChatContext = { workspaceId, ...query }
    this.authorize(principal, 'agent_chat:read', context)
    const resolution = await this.resolve(context)
    const state = await this.state(resolution, principal)
    const id = resolution.row?.id ?? resolution.candidateId
    return { ...state, ...(id ? { deliveryTarget: { kind: 'agent_conversation' as const,
      agent: { workspaceId, workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId },
      conversationId: id }, deliveryTargetState: resolution.row ? 'existing' as const : 'not_created' as const } : {}) }
  }
  async readConversation(principal: ManagementPrincipal, workspaceId: string, id: string): Promise<AgentChatState> {
    const row = await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const context: AgentChatContext = { workspaceId, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
      agentId: row.agent_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }
    if (row.record.archived) {
      const configuration = await this.conversationConfiguration(row)
      return this.state({ context, row, ...(configuration ? { configuration } : {}),
        blocked: { reason: 'context_stale', message: 'This conversation is in history. Use the current conversation.' } }, principal)
    }
    const resolution = await this.resolve(context, row.origin_execution_id ?? undefined,
      !!context.runId && !!row.origin_execution_id && row.agent_key === runChatStorageKey(context, row.origin_execution_id))
    if (resolution.row?.id !== id) staleRunChat()
    return this.state(resolution, principal)
  }
  private async sessionControlBinding(principal: ManagementPrincipal, workspaceId: string, id: string, write = false) {
    const row = await this.conversation(workspaceId, id, principal, write ? 'agent_chat:write' : 'agent_chat:read')
    this.runtimes.get(id)?.manager.setSessionControlPrincipal?.(principal.id)
    const state = await this.readConversation(principal, workspaceId, id)
    const pending = await this.pendingConfiguration(row)
    const recoveringCompaction = pending !== undefined && await this.sessionControls.hasPendingCompaction(id)
    const configuration = pending && !recoveringCompaction ? pending : await this.conversationConfiguration(row)
    const nativeAvailable = !pending && state.sessionState !== 'unavailable'
    let runtime = nativeAvailable ? this.runtimes.get(id) : undefined
    if (nativeAvailable && write && !row.active_request_id && row.native_session_id && configuration) {
      runtime = await this.runtime(row, configuration, `session-control:${id}`, this.lifetime.signal, principal.id)
    }
    const session = runtime?.session ?? (row.native_session_id ? {
      harness: row.harness, providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id,
    } : undefined)
    return { conversationId: id, principalId: principal.id, defaultSubject: `${workspaceId}:${row.agent_id}`, profileKey: configuration?.id ?? row.agent_configuration_version_id,
      busyReason: row.active_request_id || row.pending_interaction || state.turns.some(turn => turn.delivery === 'queued')
        ? 'Wait for the active and queued turns and their approvals to finish.' : null,
      session,
      get manager() {
        return runtime && !runtime.disposal && !runtime.retiring ? runtime.manager : undefined
      },
      ...((nativeAvailable || recoveringCompaction) && session && configuration && this.managers.recoverCompaction ? {
        recoverCompaction: (state: import('@foreman-code/contracts').CompactionState) => this.managers.recoverCompaction!(
          configuration, id, session, this.startInput(row, configuration, `session-control:${id}`, true),
          state, principal.id, this.lifetime.signal),
      } : {}),
      ...(configuration ? { pendingCapabilities: pendingSessionControls(configuration.harness,
        !session ? await this.managers.modelOptions?.(configuration.harness) : undefined) } : {}) }
  }

  private async resolveControlContext(principal: ManagementPrincipal, context: AgentChatContext, executionId?: string) {
    if (!context.runId) return this.resolve(context)
    return withRunChatAuthority(this.pool, principal, { workspaceId: context.workspaceId, workflowId: context.workflowId,
      runId: context.runId, workflowNodeId: context.workflowNodeId, ...(executionId ? { executionId } : {}) },
    ['agent_chat:read'], async client => {
      const selected = await resolveRunChatSelection(client, this.runs, { workspaceId: context.workspaceId,
        workflowId: context.workflowId, runId: context.runId!, workflowNodeId: context.workflowNodeId,
        ...(executionId ? { executionId } : {}) })
      if (selected.kind !== 'selected') throw new DomainError('AGENT_CHAT_EXECUTION_REQUIRED', 'Select the Run execution before changing its chat controls.', 409)
      if (selected.context.agentId !== context.agentId) staleRunChat()
      return this.resolve(selected.context, selected.selection.executionId, true)
    })
  }

  async readContextControls(principal: ManagementPrincipal, context: AgentChatContext, executionId?: string) {
    this.authorize(principal, 'agent_chat:read', context)
    const live = await readLiveManagementPrincipal(this.pool, principal.id)
    this.authorize(live, 'agent_chat:read', context)
    const resolved = context.runId && !executionId ? await this.resolve(context)
      : await this.resolveControlContext(principal, context, executionId)
    if (resolved.row) return this.readSessionControls(principal, context.workspaceId, resolved.row.id)
    if (!resolved.configuration) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE', resolved.blocked?.message ?? 'This node has no chat configuration.', 409)
    }
    const defaultsRow = await this.pool.query<{ record: unknown }>(`select record from conversation_session_defaults
      where principal_id=$1 and role='agent' and subject=$2 and profile_key=$3`,
    [principal.id, `${context.workspaceId}:${context.agentId}`, resolved.configuration.id])
    const defaults = defaultsRow.rows[0]?.record ?? {}
    return SessionControlStateSchema.parse({ conversationId: null, revision: 0,
      profileKey: resolved.configuration.id, desiredMode: 'regular', appliedMode: null,
      defaults, desired: defaults, applied: null, applicability: 'next-turn',
      capabilities: pendingSessionControls(resolved.configuration.harness,
        await this.managers.modelOptions?.(resolved.configuration.harness)), context: null,
      nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [],
      busyReason: resolved.blocked?.message ?? null })
  }

  /** The stored conversation record for this context, created when absent. It starts no native session. */
  private async ensureContextConversation(principal: ManagementPrincipal, context: AgentChatContext, executionId?: string,
    expectedRevision = 0) {
    this.authorize(principal, 'agent_chat:write', context)
    this.authorize(principal, 'agent_chat:read', context)
    const resolved = await this.resolveControlContext(principal, context, executionId)
    if (resolved.blocked || !resolved.configuration) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE', resolved.blocked?.message ?? 'This node has no chat configuration.', 409)
    }
    if (resolved.row) return resolved.row
    if (!resolved.create || expectedRevision !== 0) staleRunChat()
    return this.repository.ensureForControls(resolved.key ?? agentChatKey(context),
      { ...resolved.create, context }, async client => {
        const current = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(current, 'agent_chat:read', context)
        this.authorize(current, 'agent_chat:write', context)
      })
  }

  async changeContextControls(principal: ManagementPrincipal, context: AgentChatContext,
    input: SessionControlRequest, source: 'http' | 'mcp' = 'http', executionId?: string) {
    const row = await this.ensureContextConversation(principal, context, executionId, input.expectedRevision)
    return this.changeSessionControls(principal, context.workspaceId, row.id, input, source)
  }

  /** Files attach to an existing conversation, so the first attachment creates the record (not a native session) first. */
  async ensureConversation(principal: ManagementPrincipal, context: AgentChatContext, executionId?: string): Promise<AgentChatState> {
    const row = await this.ensureContextConversation(principal, context, executionId)
    return this.readConversation(principal, context.workspaceId, row.id)
  }

  async readSessionControls(principal: ManagementPrincipal, workspaceId: string, id: string) {
    return this.command(async () => this.sessionControls.read(await this.sessionControlBinding(principal, workspaceId, id)))
  }

  async configurationContext(principal: ManagementPrincipal, workspaceId: string, id: string): Promise<AgentChatQuery> {
    const row = await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    return { workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, agentId: row.agent_id,
      ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }
  }

  changeSessionControls(principal: ManagementPrincipal, workspaceId: string, id: string,
    input: SessionControlRequest, source: 'http' | 'mcp' = 'http') {
    return this.command(() => this.control(id, () => this.sessionControls.execute(principal, source, input,
      async () => {
        if (input.kind === 'save-default') await this.conversation(workspaceId, id, principal, 'agents:update')
        return this.sessionControlBinding(principal, workspaceId, id, true)
      }, this.lifetime.signal)))
  }

  /** Live public activity of the selected Run Agent's executions. Read-only; never touches native sessions. */
  async executionActivity(principal: ManagementPrincipal, workspaceId: string,
    query: AgentChatQuery & { runId: string }, request: ExecutionActivityRequest) {
    const context: AgentChatContext = { workspaceId, ...query }
    this.authorize(principal, 'agent_chat:read', context)
    this.authorize(await readLiveManagementPrincipal(this.pool, principal.id), 'agent_chat:read', context)
    return this.executionActivityReader.read({ workspaceId, workflowId: query.workflowId, runId: query.runId,
      workflowNodeId: query.workflowNodeId, agentId: query.agentId }, request)
  }
  async history(principal: ManagementPrincipal, workspaceId: string, id: string, before: string | undefined, limit: number) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const page = AgentChatReadbackQuerySchema.parse({ before, limit })
    return { conversationId: id, ...await this.repository.history(id, page.before, page.limit) }
  }
  async receipts(principal: ManagementPrincipal, workspaceId: string, id: string, before: string | undefined, limit: number) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const page = AgentChatReadbackQuerySchema.parse({ before, limit })
    return { conversationId: id, ...await this.repository.receipts(id, page.before, page.limit) }
  }
  async assertReadable(principal: ManagementPrincipal, workspaceId: string, id: string) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
  }

  /** Snapshot-selected read. It never creates, attaches, forks or probes a native session. */
  async readSelectedRun(principal: ManagementPrincipal, raw: unknown): Promise<ReadSelectedRunChatResponse> {
    const input = ReadSelectedRunChatRequestSchema.parse(raw)
    return withRunChatAuthority(this.pool, principal, input.selection, ['agent_chat:read'], async (client) => {
      const selected = await resolveRunChatSelection(client, this.runs, input.selection)
      if (selected.kind !== 'selected') return ReadSelectedRunChatResponseSchema.parse(selected)
      const resolution = await this.resolve(selected.context, selected.selection.executionId, true)
      if (resolution.blocked?.reason === 'context_stale') staleRunChat()
      const state = await this.state(resolution, principal)
      const id = state.conversation?.id
      return ReadSelectedRunChatResponseSchema.parse({ kind: 'selected', selection: selected.selection, state,
        key: id ? SelectedRunChatKeySchema.parse({ ...selected.selection, agentId: selected.context.agentId, conversationId: id }) : null,
        ...(id && input.history ? { history: await this.history(principal, input.selection.workspaceId, id, input.history.before, input.history.limit) } : {}),
        ...(id && input.receipts ? { receipts: await this.receipts(principal, input.selection.workspaceId, id, input.receipts.before, input.receipts.limit) } : {}),
      })
    })
  }

  sendSelectedRun(principal: ManagementPrincipal, raw: unknown) {
    return this.command(async () => {
      const input = SendSelectedRunChatRequestSchema.parse(raw)
      return withRunChatAuthority(this.pool, principal, input.selection, ['agent_chat:read', 'agent_chat:write'], async (client, assertCurrent) => {
        const selected = await resolveRunChatSelection(client, this.runs, input.selection)
        if (selected.kind !== 'selected') throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'The selected Run has no resolvable historical chat.', 409)
        const { workspaceId, ...context } = selected.context
        return this.sendMessage(principal, workspaceId, { ...input.message, context }, selected.selection.executionId, assertCurrent)
      })
    })
  }

  sendSelectedRunCommand(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'http') {
    const input = SendSelectedRunChatRequestSchema.parse(raw)
    if (parseSessionCommand(input.message.content).kind !== 'new') return this.sendSelectedRun(principal, input)
    return this.command(() => withRunChatAuthority(this.pool, principal, input.selection,
      ['agent_chat:read', 'agent_chat:write'], async (client, assertCurrent) => {
        const selected = await resolveRunChatSelection(client, this.runs, input.selection)
        if (selected.kind !== 'selected') {
          throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'The selected Run has no resolvable historical chat.', 409)
        }
        const { workspaceId, ...context } = selected.context
        return this.sendCommand(principal, workspaceId, { ...input.message, context }, source,
          { executionId: selected.selection.executionId, assertCurrent })
      }))
  }

  interruptSelectedRun(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = InterruptSelectedRunChatRequestSchema.parse(raw)
      return withRunChatAuthority(this.pool, principal, input.key, ['agent_chat:read', 'agent_chat:cancel'], async (client, assertCurrent) => {
        const selected = await resolveRunChatSelection(client, this.runs, input.key)
        if (selected.kind !== 'selected' || selected.context.agentId !== input.key.agentId) staleRunChat()
        const row = await findRunChatConversation(client, selected.context, input.key.executionId)
        if (!row || row.id !== input.key.conversationId) staleRunChat()
        // Validate configuration/source identity too, before interrupt's durable command receipt.
        const resolution = await this.resolve(selected.context, input.key.executionId, true)
        if (resolution.row?.id !== row.id || resolution.blocked?.reason === 'context_stale') staleRunChat()
        if (row.record.origin.kind === 'run_execution' && row.native_session_id === row.record.origin.sourceNativeSessionId) {
          throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'A Run source session cannot be controlled as a chat session.', 409)
        }
        await assertCurrent()
        return this.interrupt(principal, input.key.workspaceId, row.id, input.request, source)
      })
    })
  }

  // ---------------------------------------------------------------- commands

  async sendCommand(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest,
    source: 'http' | 'mcp' = 'http', selection?: { executionId: string; assertCurrent: RunChatAuthorityCheck }) {
    const input = AgentChatMessageCommandSchema.parse(value)
    if (parseSessionCommand(input.content).kind !== 'new') return this.send(principal, workspaceId, input)
    return this.command(async () => {
      const context = { workspaceId, ...input.context }
      const authorize = async (client: Pick<pg.Pool, 'query'>) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(live, 'agent_chat:read', context)
        this.authorize(live, 'agent_chat:write', context)
      }
      await authorize(this.pool)
      if (input.attachments.length || input.intent === 'steer' || input.sessionMode) {
        throw new DomainError('SESSION_COMMAND_INVALID', '/new starts a separate conversation without attachments or a mode.', 422)
      }
      let executionId = selection?.executionId
      if (input.expectedConversationId !== null) {
        const expected = await this.repository.get(input.expectedConversationId)
        if (!expected) staleRunChat()
        assertRunChatConversation(expected, context, executionId)
        executionId ??= expected.origin_execution_id ?? undefined
      }
      const selectedRun = !!context.runId && !!executionId
      // Run readers own graph transactions; read completed source facts before reserving the command connection.
      const previous = await this.resolve(context, executionId, selectedRun)
      const run = context.runId ? await this.runs.getForWorkspace(context.workspaceId, context.runId) : undefined
      const result = await new PostgresCommandCoordinator(this.pool).execute({
        principal, source, operation: 'agent_chat_new', commandId: input.requestId,
        targetKey: agentChatKey(context), payload: input, authorize,
        perform: async client => {
          await selection?.assertCurrent(client)
          const resolved = await this.resolve(context, previous.executionId ?? executionId, selectedRun,
            { sql: client, run, source: previous.source })
          if ((resolved.row?.id ?? null) !== input.expectedConversationId) staleRunChat()
          if (resolved.blocked && !['native_session_missing', 'harness_unavailable'].includes(resolved.blocked.reason)) {
            throw new DomainError('AGENT_CHAT_UNAVAILABLE', resolved.blocked.message, 409)
          }
          if (!resolved.configuration || resolved.configuration.harness.harness === 'opencode') {
            throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'This Agent has no supported chat configuration.', 409)
          }
          if (!resolved.row) {
            if (resolved.blocked) throw new DomainError('AGENT_CHAT_UNAVAILABLE', resolved.blocked.message, 409)
            if (!resolved.create) staleRunChat()
            const key = resolved.key ?? agentChatKey(context)
            await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${key}`])
            if (await this.repository.byKey(key, client)) staleRunChat()
            const row = await this.repository.ensureForControls(key,
              { ...resolved.create, context, freshSession: true }, authorize, client)
            return { conversationId: row.id, previousConversationId: null }
          }
          return { conversationId: await this.repository.replaceConversation(client, resolved.row),
            previousConversationId: resolved.row.id }
        },
      })
      const { conversationId, previousConversationId } = result.value
      if (previousConversationId) await this.retireArchivedConversation(previousConversationId)
      this.events.publish(previousConversationId ?? conversationId, 'state', { conversationReset: true })
      return { state: await this.readConversation(principal, workspaceId, conversationId),
        reset: { requestId: input.requestId, previousConversationId }, replayed: result.replayed }
    })
  }

  private async retireArchivedConversation(id: string) {
    const row = await this.repository.get(id)
    if (!row?.record.archived || row.active_request_id) return
    const state = await this.repository.state(id)
    if (state?.turns.some(turn => ['queued', 'submitting', 'accepted', 'unknown'].includes(turn.delivery))) return
    await this.control(id, async () => {
      const runtime = this.runtimes.get(id)
      if (runtime?.session && runtime.manager.closeForResume) await runtime.manager.closeForResume(runtime.session)
      await this.release(id)
    })
  }

  send(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest) {
    return this.command(() => this.sendMessage(principal, workspaceId, value))
  }
  private async conversationAuthority(principal: ManagementPrincipal, context: AgentChatContext) {
    const live = await readLiveManagementPrincipal(this.pool, principal.id)
    this.authorize(live, 'agent_chat:write', context)
    this.authorize(live, 'agent_chat:read', context)
  }

  private async sendMessage(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest, executionId?: string, assertCurrent: RunChatAuthorityCheck = async () => {}) {
    this.assertOpen()
    const parsed = AgentChatMessageCommandSchema.parse(value)
    const planTask = parseSessionCommand(parsed.content).kind === 'plan-task' || parsed.sessionMode === 'plan'
    const input = planTask ? { ...parsed, sessionMode: 'plan' as const } : parsed
    const context: AgentChatContext = { workspaceId, ...input.context }
    this.authorize(principal, 'agent_chat:write', context)
    this.authorize(principal, 'agent_chat:read', context)
    let selectedRun = executionId !== undefined
    if (input.expectedConversationId !== null) {
      const expected = await this.repository.get(input.expectedConversationId)
      if (!expected) staleRunChat()
      assertRunChatConversation(expected, context, executionId)
      selectedRun ||= !!context.runId && !!expected.origin_execution_id
        && expected.agent_key === runChatStorageKey(context, expected.origin_execution_id)
      executionId ??= expected.origin_execution_id ?? undefined
    }
    const resolution = await this.resolve(context, executionId, selectedRun)
    if (input.expectedConversationId !== null && resolution.row?.id !== input.expectedConversationId
      || resolution.blocked?.reason === 'context_stale') staleRunChat()
    const key = resolution.key ?? agentChatKey(context)
    await assertCurrent()
    if (resolution.row) {
      const prior = await this.repository.turn(resolution.row.id, input.requestId)
      if (prior) {
        // Same key and input returns the stored receipt; a different input is a conflict. Never re-sends.
        const admitted = await this.repository.admit({ key, request: input, context, delivery: 'queued', assertCurrent })
        return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun), principal), turn: admitted.turn, replayed: true,
          ...(admitted.replayWarning ? { replayWarning: admitted.replayWarning } : {}) }
      }
    }
    const admissionValidation = SendAgentChatMessageRequestSchema.safeParse(input)
    if (!admissionValidation.success) {
      throw new DomainError('CHAT_MESSAGE_TOO_LARGE',
        admissionValidation.error.issues.map(issue => issue.message).join('; '), 400)
    }
    const blocked = resolution.blocked ?? await this.harnessUnavailable(resolution)
    if (blocked) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE',
        blocked.message, 409, { reason: blocked.reason })
    }
    validateSessionMessage(input.content, input.sessionMode)
    const row = resolution.row
    const nextConfiguration = row && input.intent !== 'steer' ? await this.pendingConfiguration(row) : undefined
    const validateInput = async (sql: pg.PoolClient, current: AgentConversationRow) => {
      if (resolution.configuration) await assertAgentChatInputSize(sql, { row: current,
        configuration: resolution.configuration, ...(nextConfiguration ? { nextConfiguration } : {}),
        request: input, principalId: principal.id })
    }
    if (input.intent === 'steer') return this.steer(principal, context, key, input, resolution, selectedRun, assertCurrent, validateInput)
    if (input.intent === 'interrupt_and_send' && !row) throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to interrupt.', 409)
    const create = resolution.create ? { ...resolution.create, context } : undefined
    const admit = async () => {
      if (row) await this.sessionControls.assertSendAllowed(row.id)
      await this.conversationAuthority(principal, context)
      return this.repository.admit({ key, request: input, context, delivery: 'queued', ownerPrincipalId: principal.id,
        assertCurrent, validateInput, prepareInput: (row, sql) => this.prepareOwnerInput(principal, input, row, undefined, sql), ...(create ? { create } : {}) })
    }
    // The repository locks admission with compaction; settlement can proceed after its commit.
    const admitted = await admit()
    if (admitted.replayed) return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun), principal), turn: admitted.turn, replayed: true,
      ...(admitted.replayWarning ? { replayWarning: admitted.replayWarning } : {}) }
    this.events.publish(admitted.conversationId, 'turn', { requestId: input.requestId, delivery: admitted.turn.delivery })
    if (input.intent === 'interrupt_and_send') await this.interruptActive(admitted.conversationId, false, admitted.interruptTarget)
    this.pump(admitted.conversationId)
    return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun), principal), turn: admitted.turn, replayed: false }
  }

  private async preflightInput(principal: ManagementPrincipal, request: SendAgentChatMessageRequest, resolution: Resolution, sql?: TransactionSql, channelContext?: string): Promise<AcceptedChatInput> {
    const configuration = resolution.configuration
    const workingDirectory = resolution.row?.record.workingDirectory ?? resolution.create?.workingDirectory
    if (!configuration || !workingDirectory) throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'The accepted chat configuration is unavailable.', 409)
    if (!resolution.row) throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'Native preparation requires the reserved conversation owner.', 503)
    const row = resolution.row
    const settings = await this.sessionControls.acceptedSettings({ conversationId: resolution.row.id, principalId: principal.id,
      defaultSubject: `${resolution.row.workspace_id}:${resolution.row.agent_id}`, profileKey: configuration.id }, request.sessionMode, sql ?? this.pool)
    const userPrompt = withWorkflowChatContext(nativeChatPrompt(sessionTaskContent(request.content, settings.sessionMode), Boolean(request.attachments?.length)), channelContext)
    const prompt = request.intent === 'steer' ? userPrompt
      : agentMessagePrompt(resolution.row.record, configuration, userPrompt).text
    const startup = request.intent !== 'steer' && !resolution.row?.record.startupDelivered
    const featureContext = await conversationFeatureContext(sql ?? this.pool, resolution.row, configuration)
    const prepare = (text: string) => preflightChatInput(request, {
      workerRequired: configuration.harnessProfileSelection?.target.hostRef.kind === 'device', prompt: text, startup, settings,
      ...(this.managers.prepareInput ? { prepare: () => this.managers.prepareInput!({ principalId: principal.id,
        conversationId: resolution.row?.id ?? null, configuration, context: resolution.context, workingDirectory,
        request, prompt: text, row: row, featureContext, settings, ...(sql ? { sql } : {}) }) } : {}),
    })
    const accepted = await prepare(prompt)
    accepted.conversationContext = { subject: featureContext.subject, workflowVersionId: featureContext.workflowVersionId, workingDirectory }
    if (startup && prompt !== userPrompt) {
      const plain = await prepare(userPrompt)
      accepted.subsequent = { ...plain, startup: false, conversationContext: accepted.conversationContext }
    }
    return accepted
  }

  private async prepareOwnerInput(principal: ManagementPrincipal, request: SendAgentChatMessageRequest,
    row: AgentConversationRow, pinnedConfigurationId?: string, sql?: TransactionSql, channelContext?: string) {
    const configuration = pinnedConfigurationId ? await this.workflows.getAgentConfiguration(pinnedConfigurationId)
      : await this.pendingConfiguration(row, sql) ?? await this.conversationConfiguration(row)
    if (!configuration) throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The accepted configuration is unavailable.', 409)
    const context: AgentChatContext = { workspaceId: row.workspace_id, workflowId: row.workflow_id,
      workflowNodeId: row.workflow_node_id, agentId: row.agent_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }
    const input = await this.preflightInput(principal, request, { context, row: { ...row,
      agent_configuration_version_id: configuration.id }, configuration }, sql, channelContext)
    return { input, configurationVersionId: configuration.id }
  }

  private async steer(principal: ManagementPrincipal, context: AgentChatContext, key: string, input: SendAgentChatMessageRequest, resolution: Resolution, selectedRun: boolean, assertCurrent: RunChatAuthorityCheck,
    validateInput: (sql: pg.PoolClient, row: AgentConversationRow) => Promise<void>) {
    const row = resolution.row
    const runtime = row ? this.runtimes.get(row.id) : undefined
    if (!row || !row.active_request_id || !row.active_native_turn_id || !runtime?.session) {
      throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to steer. Send it as the next turn instead.', 409)
    }
    if (!runtime.manager.steerTurn || !await this.hasQualifiedSteer(row.id)) {
      throw new DomainError('AGENT_CHAT_STEER_UNAVAILABLE', STEER_UNAVAILABLE_REASON, 409)
    }
    if (input.expectedNativeTurnId !== row.active_native_turn_id) {
      throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The turn you steered already finished. Send it as the next turn instead.', 409)
    }
    const target = input.expectedNativeTurnId
    return this.control(row.id, async () => {
      await assertCurrent()
      const admitted = await this.repository.admit({ key, request: input, context, delivery: 'submitting', targetNativeTurnId: target,
        ownerPrincipalId: principal.id, assertCurrent, validateInput, prepareInput: (row, sql) => this.prepareOwnerInput(principal, input, row, row.agent_configuration_version_id, sql) })
      if (admitted.replayed) return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun), principal), turn: admitted.turn, replayed: true }
      try {
        runtime.manager.setSessionControlPrincipal?.(principal.id)
        const prepared = await this.repository.turnPreparedInput(row.id, input.requestId)
        if (prepared) restoreAcceptedChatInput(runtime.manager, agentChatCorrelation(row.id, input.requestId), prepared.input)
        const steered = await runtime.manager.steerTurn!(runtime.session!, {
          prompt: prepared?.input.prompt ?? sessionTaskContent(input.content, input.sessionMode), clientCorrelationId: agentChatCorrelation(row.id, input.requestId), expectedTurnId: target,
        }, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
        if (steered.nativeTurnId !== target) throw new Error('The provider acknowledged a different steer target.')
        await this.repository.steerAccepted(row.id, input.requestId, steered.nativeTurnId)
      } catch (error) {
        if (error instanceof NativeTurnNotActiveError || definiteRejection(error)) {
          await this.repository.discard(row.id, input.requestId)
          throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The turn finished before the steer arrived. Send it as the next turn instead.', 409, undefined, { cause: error })
        }
        await this.repository.unknown(row.id, input.requestId, errorMessage(error, 'Steer delivery is unconfirmed.'))
        this.scheduleReconcile(row.id)
      }
      this.events.publish(row.id, 'turn', { requestId: input.requestId })
      const turn = (await this.repository.turn(row.id, input.requestId))!
      return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun), principal), turn, replayed: false }
    })
  }

  /** Composition installs the common receipt journal; native dispatch remains owned by this service. */
  createDeliveryOwner(receipts: PostgresChatDeliveryRepository, changed?: (receiptId: string) => Promise<void>): ConversationDeliveryOwner {
    if (this.canonicalDelivery) return this.canonicalDelivery
    const owner = new ConversationDeliveryOwner(this.pool, receipts, {
      authenticate: (principal, target, action, sql) => this.authorizeDelivery(principal, target, action, sql),
      lock: async (tx, principal, target) => {
        const row = await this.lockDeliveryTarget(tx, principal, target, false)
        return { id: row.id, activeRequestId: row.active_request_id, nativeTurnId: row.active_native_turn_id, nativeSessionId: row.native_session_id }
      },
      qualifyLocked: (tx, principal, request) => this.qualifyDelivery(tx, principal, request),
      journalLocked: (tx, principal, command) => this.journalDelivery(tx, principal, command),
      dispatch: (principal, target, commandId) => {
        if (target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An Agent owner requires its Agent target.', 422)
        return this.dispatchAdmittedDelivery(principal, target.agent.workspaceId, target.conversationId, commandId)
      },
      dispatchStop: async (_principal, target, binding) => {
        if (binding.requestId) await this.interruptActive(target.conversationId, false,
          { requestId: binding.requestId, nativeTurnId: binding.nativeTurnId ?? null })
        this.events.publish(target.conversationId, 'turn', { requestId: binding.requestId, cancelRequested: true })
      },
      read: (principal, target) => this.readDelivery(principal, target),
      conversationChanged: async target => { this.events.publish(target.conversationId, 'state', { snapshotRequired: true }) },
      progress: async (command, tx) => {
        if (command.request.target.kind !== 'agent_conversation') throw new Error('A foreign target reached the Agent owner.')
        const turn = await this.repository.turn(command.request.target.conversationId, command.request.commandId, tx)
        return turn ? { state: turn.delivery, ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {}),
          ...(turn.error ? { errorCode: turn.error.code } : {}) } : { state: 'unknown', errorCode: 'CHAT_OWNER_JOURNAL_MISSING' }
      }, ...(changed ? { changed } : {}),
    })
    this.canonicalDelivery = owner
    this.events.subscribeOwner(event => {
      if (event.type === 'delta') return
      void this.syncDeliveryReceipts(event.conversationId, owner).catch(error =>
        logIgnoredError('engine', 'synchronize retained Agent delivery', error))
    })
    return owner
  }

  private async syncDeliveryReceipts(id: string, owner: ConversationDeliveryOwner): Promise<void> {
    const row = await this.repository.get(id)
    if (!row) return
    const target: DeliveryTarget = { kind: 'agent_conversation', conversationId: id,
      agent: { workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, agentId: row.agent_id } }
    const commands = await owner.receipts.unfinishedForTarget(target)
    for (const command of commands) if (!['completed', 'failed', 'canceled'].includes(command.receipt.state)) await owner.refresh(command)
  }

  private async authorizeDelivery(principal: ManagementPrincipal, target: ConversationTarget,
    action: 'read' | 'write' | 'cancel', tx?: TransactionSql): Promise<void> {
    if (target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An Agent owner requires its Agent target.', 422)
    const sql: SqlQuery = tx ?? this.pool
    const row = (await sql.query<Pick<AgentConversationRow, 'workspace_id' | 'workflow_id' | 'workflow_node_id' | 'agent_id' | 'origin_run_id'>>(
      "select workspace_id,workflow_id,workflow_node_id,agent_id,origin_run_id from operator_conversations where kind='agent' and id=$1",
    [target.conversationId])).rows[0]
    if (row && (row.workspace_id !== target.agent.workspaceId || row.workflow_id !== target.agent.workflowId
      || row.workflow_node_id !== target.agent.workflowNodeId || row.agent_id !== target.agent.agentId)) {
      throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'The conversation does not belong to that exact Agent node.', 403)
    }
    const scope = { workspaceId: target.agent.workspaceId, workflowId: target.agent.workflowId,
      ...(row?.origin_run_id ? { runId: row.origin_run_id } : {}) }
    this.authorize(principal, 'agent_chat:read', scope)
    if (action !== 'read') this.authorize(principal, action === 'write' ? 'agent_chat:write' : 'agent_chat:cancel', scope)
    const live = await readLiveManagementPrincipal(sql, principal.id)
    this.authorize(live, 'agent_chat:read', scope)
    if (action !== 'read') this.authorize(live, action === 'write' ? 'agent_chat:write' : 'agent_chat:cancel', scope)
  }

  private async lockDeliveryTarget(tx: TransactionSql, principal: ManagementPrincipal, target: ConversationTarget,
    create: boolean): Promise<AgentConversationRow> {
    if (target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An Agent owner requires its Agent target.', 422)
    await this.authorizeDelivery(principal, target, 'read', tx)
    const context: AgentChatContext = { ...target.agent }
    const existing = await this.repository.get(target.conversationId, tx)
    const key = existing?.agent_key ?? agentChatKey(context)
    await lockActiveWorkspace(tx, target.agent.workspaceId)
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${key}`])
    let row = (await tx.query<AgentConversationRow>(`select * from operator_conversations
      where id=$1 and kind='agent' and deleted_at is null for update`, [target.conversationId])).rows[0]
    if (!row && create) {
      await tx.query('select id from workflows where workspace_id=$1 and id=$2 for share', [context.workspaceId, context.workflowId])
      await tx.query('select id from agents where workspace_id=$1 and id=$2 for share', [context.workspaceId, context.agentId])
      const selected = await this.resolve(context, undefined, false, { sql: tx, source: undefined })
      if (selected.row?.id === target.conversationId) row = selected.row
      else if (!selected.blocked && selected.candidateId === target.conversationId && selected.create) {
        row = await this.repository.ensureDeliveryCandidate(tx, key, { ...selected.create, id: target.conversationId, context })
      }
    }
    if (!row || row.record.archived) throw new DomainError('CHAT_TARGET_CHANGED', 'The selected conversation changed before admission.', 409)
    if (row.origin_run_id && row.native_session_id === (row.record.origin.kind === 'run_execution' ? row.record.origin.sourceNativeSessionId : undefined)) {
      throw new DomainError('CHAT_TARGET_INVALID', 'A conversation cannot control the original Run session.', 409)
    }
    return row
  }

  private legacyDeliveryRequest(command: ChatSendRequest & { commandId: string }, row: AgentConversationRow,
    intent: DeliveryQualification['appliedIntent']): SendAgentChatMessageRequest {
    return { requestId: command.commandId, expectedConversationId: row.id, content: command.content, intent,
      context: { workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, agentId: row.agent_id,
        ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) },
      ...(command.attachments ? { attachments: command.attachments } : {}),
      ...(command.sessionMode ? { sessionMode: command.sessionMode } : {}),
      ...(intent === 'steer' && row.active_native_turn_id ? { expectedNativeTurnId: row.active_native_turn_id }
        : command.expectedNativeTurnId ? { expectedNativeTurnId: command.expectedNativeTurnId } : {}) }
  }

  qualifyGroupDelivery(tx: TransactionSql, principal: ManagementPrincipal, input: ChatSendRequest,
    channelContext?: string): Promise<DeliveryQualification> {
    if (!this.canonicalDelivery) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Common delivery is not installed.', 503)
    return this.canonicalDelivery.qualifyLocked(tx, principal, input,
      (sql, caller, request) => this.qualifyDelivery(sql, caller, request, channelContext))
  }

  private async qualifyDelivery(tx: TransactionSql, principal: ManagementPrincipal, input: ChatSendRequest,
    channelContext?: string): Promise<DeliveryQualification> {
    if (!input.commandId || input.target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An exact Agent command is required.', 422)
    await this.authorizeDelivery(principal, input.target, 'write', tx)
    const row = await this.lockDeliveryTarget(tx, principal, input.target, true)
    await tx.query('select id from agents where workspace_id=$1 and id=$2 for share', [row.workspace_id, row.agent_id])
    const configuration = await this.pendingConfiguration(row, tx) ?? await this.conversationConfiguration(row)
    const unavailable = this.sessionUnavailable(row, configuration)
    if (unavailable || !configuration) throw new DomainError('AGENT_CHAT_UNAVAILABLE', unavailable?.message ?? 'The accepted configuration is unavailable.', 409)
    const controls = (await tx.query<{ record: unknown }>('select record from conversation_session_controls where conversation_id=$1 for update', [row.id])).rows[0]
    const savedControls = controls ? SessionControlStateSchema.parse(controls.record) : undefined
    const appliedMode = savedControls?.appliedMode ?? 'regular'
    const requestedMode = input.sessionMode ?? savedControls?.desiredMode ?? 'regular'
    const liveSteer = Boolean(row.active_request_id && row.active_native_turn_id && await this.hasQualifiedSteer(row.id))
    const canSteer = liveSteer && configuration.id === row.agent_configuration_version_id
      && !input.attachments?.length && requestedMode === appliedMode
    const appliedIntent = input.intent === 'auto' ? canSteer ? 'steer' : 'next_turn' : input.intent
    if (appliedIntent === 'steer' && !canSteer) throw new DomainError('CHAT_STEER_UNAVAILABLE',
      'This input cannot steer the qualified active turn; use Queue or Interrupt and send.', 409)
    if (appliedIntent === 'interrupt_and_send' && !row.active_request_id) throw new DomainError('CHAT_TURN_NOT_ACTIVE', 'There is no active turn to interrupt.', 409)
    const request = this.legacyDeliveryRequest({ ...input, commandId: input.commandId }, row, appliedIntent)
    validateSessionMessage(request.content, request.sessionMode)
    await validateMessageAttachments(tx, row.id, request.attachments)
    const prepared = await this.prepareOwnerInput(principal, request, row, configuration.id, tx, channelContext)
    const featureContext = await conversationFeatureContext(tx, row, configuration)
    return { appliedIntent, ownerBinding: { configurationVersionId: prepared.configurationVersionId,
      agentIdentity: featureContext.subject.agent,
      acceptedInput: prepared.input, ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
      ...(row.active_request_id ? { ownerRequestId: row.active_request_id } : {}),
      ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
      ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}) } }
  }

  private async journalDelivery(tx: pg.PoolClient, principal: ManagementPrincipal, command: StoredDelivery): Promise<void> {
    if (command.request.target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An Agent target is required.', 422)
    const row = await this.lockDeliveryTarget(tx, principal, command.request.target, false)
    const binding = command.ownerBinding
    if (!binding.acceptedInput || !binding.configurationVersionId) throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The prepared owner input is unavailable.', 503)
    if (command.receipt.appliedIntent !== 'next_turn' && (row.active_request_id !== binding.ownerRequestId
      || row.native_session_id !== binding.nativeSessionId || row.active_native_turn_id !== (binding.nativeTurnId ?? null))) {
      throw new DomainError('CHAT_TARGET_CHANGED', 'The originally addressed native owner changed before dispatch.', 409)
    }
    const request = this.legacyDeliveryRequest(command.request, row, command.receipt.appliedIntent)
    await this.repository.admit({ key: row.agent_key, request, context: { workspaceId: row.workspace_id, ...request.context },
      ownerPrincipalId: principal.id, delivery: request.intent === 'steer' ? 'submitting' : 'queued',
      ...(binding.nativeTurnId ? { targetNativeTurnId: binding.nativeTurnId } : {}),
      prepareInput: async () => ({ input: binding.acceptedInput!, configurationVersionId: binding.configurationVersionId! }) }, tx)
  }

  private async readDelivery(principal: ManagementPrincipal, target: ConversationTarget) {
    if (target.kind !== 'agent_conversation') throw new DomainError('CHAT_TARGET_INVALID', 'An Agent target is required.', 422)
    const row = await this.repository.get(target.conversationId)
    const state = row ? await this.readConversation(principal, target.agent.workspaceId, row.id)
      : await this.read(principal, target.agent.workspaceId, { workflowId: target.agent.workflowId,
        workflowNodeId: target.agent.workflowNodeId, agentId: target.agent.agentId })
    if (!row && (state.deliveryTarget?.kind !== 'agent_conversation' || state.deliveryTarget.conversationId !== target.conversationId)) {
      throw new DomainError('CHAT_TARGET_CHANGED', 'The selected conversation candidate changed; refresh its target before sending.', 409)
    }
    const steer = row && await this.hasQualifiedSteer(row.id) ? 'native_expected_turn' as const : 'unavailable' as const
    return { target, state, receipts: [], delivery: { state: row?.turn_state === 'starting' ? 'starting' as const
      : row?.turn_state === 'canceling' || row?.turn_state === 'uncertain' ? 'settling' as const
        : row?.active_request_id ? 'active' as const : 'idle' as const,
    capabilities: { steer, queue: state.availability.canSend, interruptAndSend: state.availability.canSend },
    ...(row?.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}) } }
  }

  /** Canonical admission has already committed to the existing conversation queue. No new owner is created. */
  async dispatchAdmittedDelivery(principal: ManagementPrincipal, workspaceId: string, id: string, requestId: string) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:write')
    const turn = await this.repository.turn(id, requestId)
    if (!turn || !['queued', 'submitting'].includes(turn.delivery)) return
    if (turn.intent === 'steer') {
      await this.control(id, async () => {
        const row = await this.conversation(workspaceId, id, principal, 'agent_chat:write')
        const runtime = this.runtimes.get(id)
        const expected = turn.targetNativeTurnId
        const retained = await this.canonicalDelivery?.receipts.find(principal.id, requestId)
        const original = retained?.ownerBinding
        if (!expected || row.active_native_turn_id !== expected || !row.active_request_id
          || !original?.ownerRequestId || original.ownerRequestId !== row.active_request_id
          || original.nativeSessionId !== row.native_session_id || original.nativeTurnId !== expected
          || runtime?.session?.nativeSessionId !== row.native_session_id || !runtime?.manager.steerTurn) {
          await this.repository.unknown(id, requestId, 'The selected native turn is no longer available to confirm this steer.')
          return
        }
        const content = await this.repository.turnContent(id, requestId)
        const mode = await this.repository.turnSessionMode(id, requestId)
        if (content === undefined) throw new Error('The admitted steer content is unavailable.')
        runtime.manager.setSessionControlPrincipal?.(principal.id)
        const prepared = await this.repository.turnPreparedInput(id, requestId)
        if (prepared) restoreAcceptedChatInput(runtime.manager, agentChatCorrelation(id, requestId), prepared.input)
        try {
          const result = await runtime.manager.steerTurn(runtime.session, { prompt: prepared?.input.prompt ?? sessionTaskContent(content, mode),
            clientCorrelationId: agentChatCorrelation(id, requestId), expectedTurnId: expected },
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
          if (result.nativeTurnId !== expected) throw new Error('The native owner acknowledged a different steer target.')
          await this.repository.steerAccepted(id, requestId, expected)
        } catch (error) {
          await this.repository.unknown(id, requestId, errorMessage(error, 'Steer delivery is unconfirmed.'))
          this.scheduleReconcile(id)
        }
        this.events.publish(id, 'turn', { requestId })
      })
      return
    }
    if (turn.intent === 'interrupt_and_send') {
      const target = await this.repository.turnInterruptTarget(id, requestId)
      if (target) await this.interruptActive(id, false, target)
    }
    this.pump(id)
  }

  async hasQualifiedSteer(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id)
    if (!runtime?.session || !runtime.manager.steerTurn || runtime.retiring || runtime.disposal || !this.managers.qualifiedSteer) return false
    const row = await this.repository.get(id)
    return Boolean(row && row.harness === 'codex' && await this.managers.qualifiedSteer(row, runtime.configuration))
  }

  interrupt(principal: ManagementPrincipal, workspaceId: string, id: string,
    value: z.infer<typeof InterruptAgentChatRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = InterruptAgentChatRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'interrupt', workspaceId, ...input }, async (markDispatchAttempt) => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
        const target = await this.repository.interrupt(id, input.expectedNativeTurnId, input.scope ?? 'active_and_queued')
        this.runtimes.get(id)?.manager.setSessionControlPrincipal?.(principal.id)
        if (target) markDispatchAttempt()
        await this.interruptActive(id, true, target)
        return this.readConversation(principal, workspaceId, id)
      }, async () => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
        return this.readConversation(principal, workspaceId, id)
      })
    })
  }
  cancelQueued(principal: ManagementPrincipal, workspaceId: string, id: string, turnRequestId: string,
    value: z.infer<typeof CancelQueuedAgentChatTurnRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = CancelQueuedAgentChatTurnRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'cancel_queued', workspaceId, turnRequestId, ...input }, async () => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
        const changed = await this.repository.cancelQueued(id, turnRequestId)
        if (!changed) {
          const turn = await this.repository.turn(id, turnRequestId)
          if (!turn) throw new DomainError('AGENT_CHAT_TURN_NOT_FOUND', 'That message was not found.', 404)
          if (turn.delivery !== 'canceled') throw new DomainError('AGENT_CHAT_TURN_STARTED', 'That message was already sent to the Agent.', 409)
        }
        if (changed) this.events.publish(id, 'turn', { requestId: turnRequestId, delivery: 'canceled' })
        this.pump(id)
        return this.readConversation(principal, workspaceId, id)
      }, async () => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
        return this.readConversation(principal, workspaceId, id)
      })
    })
  }
  respond(principal: ManagementPrincipal, workspaceId: string, id: string,
    value: z.infer<typeof RespondAgentChatInteractionRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = RespondAgentChatInteractionRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
      let providerAcknowledgment: ChatResponseAcknowledgment | undefined
      const acceptedControl = acceptedResponseControl(await this.readConversation(principal, workspaceId, id),
        input.nativeRequestId, input.optionId, input.response)
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'respond', workspaceId, ...input }, async (markDispatchAttempt) => {
        await this.control(id, async () => {
          const row = await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
          const pending = row.pending_interaction
          const runtime = this.runtimes.get(id)
          if (!pending || pending.turn.nativeRequestId !== input.nativeRequestId || !runtime?.session
            || !row.active_request_id && !isSessionNativeInteraction(pending)) {
            throw new DomainError('AGENT_CHAT_INTERACTION_NOT_PENDING', 'This approval is no longer pending.', 409)
          }
          const offered = pending.responseOptions.find((entry) => entry.optionId === input.optionId)
          if (!offered) throw new DomainError('AGENT_CHAT_INTERACTION_OPTION_INVALID', 'That option was not offered.', 422)
          const option = withInteractionResponse(offered, input.response)
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])
          markDispatchAttempt()
          runtime.manager.setSessionControlPrincipal?.(principal.id)
          await runtime.manager.respond(runtime.session, input.nativeRequestId, option, signal)
          if (runtime.manager.reconcileResponse) {
            const history = await runtime.manager.reconcileResponse(runtime.session, { nativeRequestId: input.nativeRequestId,
              nativeRequestType: pending.nativeRequestType, option }, signal)
            const proofs = (history.responseDeliveries ?? []).filter((proof) => proof.nativeSessionId === runtime.session!.nativeSessionId
              && proof.nativeRequestId === input.nativeRequestId)
            if (proofs.length && proofs.every((proof) => proof.harness === runtime.session!.harness
              && proof.providerVersion === runtime.session!.providerVersion && proof.nativeRequestType === pending.nativeRequestType
              && proof.optionId === option.optionId && proof.semantic === option.semantic)) providerAcknowledgment = proofs[0]
          }
          const next = await runtime.manager.pending(runtime.session, signal)
          await this.repository.pending(id, row.active_request_id, next)
          this.events.publish(id, 'state', { pending: Boolean(next) })
        })
        return this.readConversation(principal, workspaceId, id)
      }, async () => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
        return this.readConversation(principal, workspaceId, id)
      }, acceptedControl, () => providerAcknowledgment)
    })
  }

  private async interruptActive(id: string, explicit: boolean, target: AgentChatInterruptTarget | undefined, controlled = false): Promise<void> {
    if (!target) return
    const interrupt = async () => {
      const row = await this.repository.get(id)
      if (!row || row.active_request_id !== target.requestId || !row.cancel_requested
        || (target.nativeTurnId && row.active_native_turn_id !== target.nativeTurnId)) return
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId: target.requestId, sessionState: 'interrupting', explicit })
      const runtime = this.runtimes.get(id)
      if (!runtime?.session || runtime.retiring || runtime.session.nativeSessionId !== row.native_session_id) return
      // Claude submissions have a native message receipt instead of a native turn ID.
      const nativeId = row.active_native_turn_id ?? (await this.repository.turn(id, target.requestId))?.nativeSubmission?.nativeMessageId
      if (!nativeId) return // Submission or exact-history recovery will retry this durable intent.
      if (runtime.acknowledgedCancel?.requestId === target.requestId
        && runtime.acknowledgedCancel.nativeId === nativeId) return
      try {
        const acknowledged = await runtime.manager.cancel(runtime.session,
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]), nativeId)
        if (acknowledged) runtime.acknowledgedCancel = { requestId: target.requestId, nativeId }
      } catch (error) {
        this.events.publish(id, 'error', { message: errorMessage(error, 'Interrupt delivery failed.') })
      }
    }
    if (controlled) await interrupt()
    else await this.control(id, interrupt)
  }

  // ---------------------------------------------------------------- turn execution

  /** Start the next queued turn when the conversation is idle. Safe to call repeatedly. */
  private pump(id: string): void {
    if (this.closing) return
    if (this.tasks.has(id)) { this.wakeups.add(id); return }
    const task = (async () => {
      for (;;) {
        if (this.closing) return
        this.wakeups.delete(id) // This queue scan services admissions already observed.
        const next = await this.repository.nextQueued(id)
        if (!next) {
          await this.retireArchivedConversation(id)
          return
        }
        // Claims cannot overtake a fenced native interrupt. A canceled selection is not a busy queue.
        if (!await this.control(id, () => this.repository.claim(id, next.requestId))) {
          const row = await this.repository.get(id)
          if (!row || row.active_request_id || row.record.sessionUnavailable) return
          // Only a selection that left the queue warrants an immediate rescan. An unchanged
          // queued receipt is fenced (for example by an orphan); let reconciliation repair it.
          if ((await this.repository.turn(id, next.requestId))?.delivery === 'queued') return
          continue
        }
        this.events.publish(id, 'turn', { requestId: next.requestId, delivery: 'submitting' })
        await this.runTurn(id, next)
      }
    })().catch((error: unknown) => {
      this.events.publish(id, 'error', { message: errorMessage(error, 'Agent chat delivery failed.') })
    }).finally(() => {
      this.tasks.delete(id)
      this.scheduleReconcile(id)
      // An admission may have seen this task after its empty-queue read but before teardown.
      if (this.wakeups.delete(id)) this.pump(id)
    })
    this.tasks.set(id, task)
  }

  private startInput(row: AgentConversationRow, configuration: AgentConfigurationVersion, correlationId: string, delivered: boolean): AgentChatNativeSessionStart {
    return {
      kind: 'agent-chat', conversationId: row.id, workflowId: row.workflow_id,
      workflowNodeId: row.workflow_node_id, configuration,
      workingDirectory: row.record.workingDirectory, correlationId, instructionsDelivered: delivered,
      ...(row.record.systemPrompt ? { systemPrompt: row.record.systemPrompt } : {}),
      ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
    }
  }
  private runtimeDirectory(id: string) { return join(resolve(this.runtimeRoot), 'agent-chat', id) }

  private async conversationConfiguration(row: AgentConversationRow): Promise<AgentConfigurationVersion | undefined> {
    const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
    if (!configuration || row.record.origin.kind !== 'run_execution') return configuration
    const run = await this.runs.getForWorkspace(row.workspace_id, row.record.origin.runId)
    const version = run ? await this.workflows.getSavedVersion(run.workflowVersionId) : undefined
    const node = version?.definition.nodes.find(item => item.id === row.workflow_node_id)
    if (!version || !node || node.kind === 'job' || node.agentId !== row.agent_id) {
      throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The originating Run node configuration is unavailable.', 409)
    }
    return node.skills || node.browser?.enabled ? configurationWithNodeSkills(configuration, node.skills, version.nodeSkillSnapshots?.[node.id], node.browser)
      : configuration
  }

  private async pendingConfiguration(row: AgentConversationRow, sql: SqlQuery = this.pool) {
    if (row.origin_run_id && !row.native_session_id && !row.record.startupDelivered) return undefined
    const agent = (await sql.query<{ current_configuration_version_id: string | null }>(
      'select current_configuration_version_id from agents where workspace_id=$1 and id=$2 and archived_at is null',
      [row.workspace_id, row.agent_id])).rows[0]
    if (!agent?.current_configuration_version_id
      || agent.current_configuration_version_id === row.agent_configuration_version_id) return undefined
    const configuration = await this.workflows.getAgentConfiguration(agent.current_configuration_version_id)
    if (!configuration) {
      throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The saved Agent configuration is unavailable.', 409)
    }
    return configuration
  }

  private async applyTurnConfiguration(row: AgentConversationRow, acceptedConfigurationId?: string): Promise<AgentConversationRow> {
    if (acceptedConfigurationId === row.agent_configuration_version_id) return row
    const configuration = acceptedConfigurationId ? await this.workflows.getAgentConfiguration(acceptedConfigurationId) : await this.pendingConfiguration(row)
    if (acceptedConfigurationId && !configuration) throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The accepted configuration is unavailable.', 409)
    if (!configuration) return row
    const previous = await this.conversationConfiguration(row)
    if (!previous) {
      throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The saved Agent configuration is unavailable.', 409)
    }
    const directoryBinding = await agentConfigurationDirectory(this.pool, row, configuration)
    const { previousProfile, replaceSession } = agentConfigurationTransition(row, previous, configuration)
    const runtime = this.runtimes.get(row.id)
    if (!runtime?.session && replaceSession && row.native_session_id && row.worker_conversation_binding) {
      const principalId = await this.repository.turnPrincipalId(row.id, row.active_request_id!)
      if (principalId && this.managers.closeRetainedSession) {
        await this.managers.closeRetainedSession(row.id, previous, principalId, this.lifetime.signal)
      } else if (this.managers.closeRecoveredSession) {
        await this.managers.closeRecoveredSession(row.id, this.lifetime.signal)
      } else {
        throw new DomainError('NATIVE_RUNTIME_RELEASE_UNAVAILABLE',
          'The previous Worker session cannot be closed with its saved owner.', 409)
      }
    }
    await this.release(row.id, previousProfile?.target.hostRef.kind === 'device'
      ? { workerClosure: replaceSession ? 'close' : 'release' } : undefined)
    return this.repository.applyConfiguration(row.id, row.active_request_id!, configuration, { replaceSession, directoryBinding })
  }

  private async runtime(row: AgentConversationRow, configuration: AgentConfigurationVersion, correlationId: string, signal: AbortSignal, controlPrincipalId?: string): Promise<Runtime> {
    this.assertOpen()
    const unavailable = this.sessionUnavailable(row, configuration)
    if (unavailable) throw new DomainError(unavailable.message === EPHEMERAL_SESSION_LOST ? 'AGENT_CHAT_EPHEMERAL_SESSION_LOST' : 'AGENT_CHAT_UNAVAILABLE',
      unavailable.message, 409, { reason: unavailable.reason })
    const accepted = row.active_request_id ? await this.repository.turnPreparedInput(row.id, row.active_request_id) : undefined
    const featureContext = await conversationFeatureContext(this.pool, row, configuration, accepted?.input.conversationContext?.workflowVersionId)
    if (accepted?.input.conversationContext && (commandInputHash(featureContext.subject) !== commandInputHash(accepted.input.conversationContext.subject)
      || featureContext.workingDirectory !== accepted.input.conversationContext.workingDirectory)) {
      throw new DomainError('CHAT_SUBJECT_CHANGED', 'The accepted conversation feature scope changed before dispatch.', 409)
    }
    const featureContextKey = commandInputHash({ subject: featureContext.subject,
      workflowVersionId: featureContext.workflowVersionId, workingDirectory: featureContext.workingDirectory })
    let existing = this.runtimes.get(row.id)
    if (controlPrincipalId) existing?.manager.setSessionControlPrincipal?.(controlPrincipalId)
    if (existing?.session) {
      if (existing.session.nativeSessionId !== row.native_session_id) {
        throw new DomainError('AGENT_CHAT_SESSION_UNBOUND', 'Native session creation has not been durably bound.', 409)
      }
      if (existing.featureContextKey !== featureContextKey) {
        const principalId = controlPrincipalId ?? (row.active_request_id
          ? await this.repository.turnPrincipalId(row.id, row.active_request_id) : undefined)
        if (!this.featureContextBinder || !principalId) throw new DomainError('CHAT_SUBJECT_BINDING_UNAVAILABLE',
          'The resident native session cannot bind the accepted scoped tools.', 503)
        const rebound = await this.featureContextBinder({ conversationId: row.id, principalId, context: featureContext,
          manager: existing.manager, session: existing.session, correlationId, signal })
        if (rebound?.restart) {
          await this.release(row.id, configuration.harnessProfileSelection?.target.hostRef.kind === 'device'
            ? { workerClosure: 'release' } : undefined)
          existing = undefined
        } else existing.featureContextKey = featureContextKey
      }
      if (existing) return existing
    }
    await mkdir(this.runtimeDirectory(row.id), { recursive: true })
    this.assertOpen()
    signal.throwIfAborted()
    const accountSource = row.record.origin.kind === 'run_execution' && !row.record.sourceConfigurationVersionId
      ? { executionId: row.record.origin.executionId } : undefined
    const runtime: Runtime = existing ?? { manager: await this.managers(row.id, configuration, row.record.workingDirectory,
      accountSource, featureContext), configuration, featureContextKey }
    try {
      this.assertOpen()
      signal.throwIfAborted()
    } catch (error) {
      if (!existing) {
        await runtime.manager.dispose?.()
        this.managers.release?.(row.id)
      }
      throw error
    }
    if (controlPrincipalId) runtime.manager.setSessionControlPrincipal?.(controlPrincipalId)
    if (!existing) {
      const preferences = await this.sessionControls.preferences(row.id)
      if (preferences) await runtime.manager.configureSessionPreferences?.(preferences)
    }
    this.runtimes.set(row.id, runtime)
    if (row.native_session_id && row.provider_version) {
      // Resume the exact stored session. Its startup instructions are already in native history.
      const attached = await runtime.manager.attachSession({ harness: row.harness, providerVersion: row.provider_version,
        nativeSessionId: row.native_session_id }, this.startInput(row, configuration, correlationId, true), signal)
      if (attached.nativeSessionId !== row.native_session_id || attached.harness !== row.harness) {
        throw new DomainError('AGENT_CHAT_SESSION_ID_MISMATCH', 'The native adapter returned a different chat session. No turn was sent.', 409)
      }
      runtime.session = attached
    } else {
      if (!row.active_request_id || !await this.repository.beginSessionCreation(row.id, row.active_request_id)) {
        throw new DomainError('AGENT_CHAT_SESSION_CREATION_UNCERTAIN', 'A native session may already exist. A replacement will not be created.', 409)
      }
      let creationRequested = false
      try {
        if (forksRunHistory(row) && row.record.origin.kind === 'run_execution') {
          const origin = row.record.origin
          if (!runtime.manager.forkSession) throw new DomainError('AGENT_CHAT_FORK_UNAVAILABLE', 'This harness cannot continue a Run session in chat.', 409)
          const providerVersion = await this.sourceProviderVersion(origin, runtime)
          runtime.creationInput = this.startInput(row, configuration, correlationId, true)
          creationRequested = true
          const forked = await runtime.manager.forkSession({ harness: row.harness, providerVersion, nativeSessionId: origin.sourceNativeSessionId },
            runtime.creationInput, signal)
          if (forked.nativeSessionId === origin.sourceNativeSessionId || forked.harness !== row.harness) {
            // Do not adopt or close a returned source/foreign session, even during failure cleanup.
            throw new DomainError('AGENT_CHAT_FORK_UNAVAILABLE', 'The harness did not create an independent chat fork. The Run session will not be changed.', 409)
          }
          runtime.session = forked
          await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
          await this.repository.markStartupDelivered(row.id)
        } else {
          // Keep the durable creation fence; this provider cannot expose SID before its first admitted input.
          runtime.creationInput = this.startInput(row, configuration, correlationId, false)
          if (runtime.manager.startInitialTurn) return runtime
          creationRequested = true
          runtime.session = await runtime.manager.createSession(runtime.creationInput, signal)
          await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
        }
      } catch (error) {
        // Binding/activation failure after successful creation must never authorize a replacement.
        if (!runtime.session && (!creationRequested || definiteNonCreation(error))) {
          if (!await this.repository.recordNonSubmission(row.id, row.active_request_id!, 'session_creation', failure(error))) {
            throw new Error('Non-creation ownership was lost.', { cause: error })
          }
          await this.release(row.id) // A cleanup failure keeps the original durable fence.
          throw new RejectedSessionCreation(error)
        }
        throw error
      }
    }
    return runtime
  }
  private async sourceProviderVersion(origin: Extract<AgentChatOrigin, { kind: 'run_execution' }>, runtime: Runtime): Promise<string> {
    // Provider metadata belongs to the same physical Run execution, never an unrelated
    // lane with a colliding native id (nor an Agent's most recently updated session).
    const row = (await this.pool.query<{ reference: unknown }>(`
      select s.reference from execution_native_sessions s
      join harness_executions e on e.id=s.execution_id
      where s.execution_id=$1 and e.run_id=$2`, [origin.executionId, origin.runId])).rows[0]
    if (row) {
      const reference = NativeSessionReferenceSchema.safeParse(row.reference)
      if (!reference.success || reference.data.nativeSessionId !== origin.sourceNativeSessionId
        || reference.data.harness !== runtime.manager.harness) {
        throw new DomainError('AGENT_CHAT_SESSION_ID_MISMATCH', 'The stored Run source session does not match this execution.', 409)
      }
      return reference.data.providerVersion
    }
    // Legacy executions may predate the native reference table. The exact source id still
    // goes to forkSession, which must prove it exists; no replacement create is attempted.
    return (await runtime.manager.capabilities(this.lifetime.signal)).providerVersion
  }

  private async runTurn(id: string, turn: AgentChatTurn): Promise<void> {
    const correlationId = agentChatCorrelation(id, turn.requestId)
    const signal = this.lifetime.signal
    const observer = new AbortController()
    let submitted = false
    let creatingSession = false
    let initialOffered = false
    let nativeSubmission: NativeMessageSubmission | undefined
    let nativeTurnId: string | null = null
    let initialStream: Awaited<ReturnType<typeof primeInitialNativeStream>> | undefined
    let runtime: Runtime | undefined
    let textStream: ReturnType<typeof createNativeTextStream> | undefined
    let prepared!: () => void
    const preparation = { requestId: turn.requestId, done: new Promise<void>((resolve) => { prepared = resolve }) }
    this.preparations.set(id, preparation)
    const finishPreparation = () => {
      if (this.preparations.get(id) === preparation) this.preparations.delete(id)
      prepared()
    }
    try {
      let row = await this.repository.get(id)
      if (!row || row.active_request_id !== turn.requestId) return
      if (row.cancel_requested) { await this.settle(id, turn.requestId, { outcome: 'canceled' }); return }
      const principalId = await this.repository.turnPrincipalId(id, turn.requestId)
      if (principalId) this.runtimes.get(id)?.manager.setSessionControlPrincipal?.(principalId)
      const acceptedInput = await this.repository.turnPreparedInput(id, turn.requestId)
      row = await this.control(id, () => this.applyTurnConfiguration(row!, acceptedInput?.configurationVersionId))
      const configuration = await this.conversationConfiguration(row)
      if (!configuration) throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The pinned Agent configuration is unavailable.', 409)
      const selectedMode = await this.repository.turnSessionMode(id, turn.requestId)
      if (principalId) await this.sessionControls.read({ conversationId: id, principalId,
        defaultSubject: `${row.workspace_id}:${row.agent_id}`, profileKey: row.agent_configuration_version_id,
        ...(selectedMode ? { initialMode: selectedMode } : {}), busyReason: null })
      creatingSession = !row.native_session_id
      runtime = await this.runtime(row, configuration, correlationId, signal, principalId)
      if (acceptedInput) restoreAcceptedChatInput(runtime.manager, correlationId, acceptedInput.input)
      creatingSession = !runtime.session
      const onSubmitted = async (nativeId: string) => {
        nativeTurnId = nativeId; submitted = true
        await this.repository.accepted(id, turn.requestId, nativeId)
        this.scheduleReconcile(id)
        textStream?.flush()
        this.events.publish(id, 'turn', { requestId: turn.requestId, delivery: 'accepted', nativeTurnId: nativeId })
        void this.interruptActive(id, false, { requestId: turn.requestId, nativeTurnId: nativeId })
          .catch(ignoreError('harness', 'interrupt active turn', { chatId: id, requestId: turn.requestId }))
      }
      const turnSettings = (nativeSessionId: string | null) => acceptedInput?.input.settings
        ? this.sessionControls.settingsForAccepted(id, () => ({ requestId: turn.requestId, nativeSessionId: nativeSessionId ?? runtime?.session?.nativeSessionId ?? null }), acceptedInput.input.settings)
        : this.sessionControls.turnSettings(id, () => ({ requestId: turn.requestId, nativeSessionId: nativeSessionId ?? runtime?.session?.nativeSessionId ?? null }), selectedMode)
      let session = runtime.session
      const content = await this.repository.turnContent(id, turn.requestId)
      if (content === undefined) throw new Error('The accepted message content is missing.')
      const fresh = await this.repository.get(id)
      if (!fresh || fresh.active_request_id !== turn.requestId) return
      // Stop may have committed while the first session was being created/bound. No turn was sent.
      if (fresh.cancel_requested) { await this.settle(id, turn.requestId, { outcome: 'canceled' }); return }
      signal.throwIfAborted()
      const prompt = acceptedInput ? { text: acceptedInput.input.prompt, startup: acceptedInput.input.startup }
        : agentMessagePrompt(fresh.record, configuration, nativeChatPrompt(sessionTaskContent(content, selectedMode), !content.trim()))
      if (!session) {
        if (!runtime.manager.startInitialTurn || forksRunHistory(fresh)) throw new DomainError('AGENT_INITIAL_TURN_UNAVAILABLE', 'No admitted initial native lifecycle is available.', 409)
        await this.repository.markInitialInputOffered(id, turn.requestId)
        initialOffered = true // A failure after offer is not a definite prompt rejection/create failure.
        initialStream = await primeInitialNativeStream(runtime.manager.startInitialTurn(this.startInput(fresh, configuration, correlationId, false), {
          ...await turnSettings(null),
          onSubmitted,
          prompt: prompt.text, clientCorrelationId: correlationId,
          onSessionObserved: async (observed) => {
            await this.control(id, async () => {
              const current = await this.repository.get(id)
              if (!current || current.active_request_id !== turn.requestId || current.agent_configuration_version_id !== fresh.agent_configuration_version_id) throw new Error('Initial Agent session ownership was lost.')
              runtime!.session = observed
              session = observed
              await this.repository.bindSession(id, observed.providerVersion, observed.nativeSessionId)
            })
          },
          onMessageSubmitted: async (receipt) => {
            submitted = true
            await this.control(id, async () => {
              if (!session || receipt.nativeSessionId !== session.nativeSessionId || receipt.clientCorrelationId !== correlationId
                || !await this.repository.acceptedMessage(id, turn.requestId, receipt)) throw new Error('Initial Agent message ownership was lost.')
              nativeSubmission = receipt
            })
          },
        }, signal))
        if (!session) throw new Error('Initial Agent input has no observed native session.')
      }
      creatingSession = false
      const observedSession = session
      let scope: ActivityScope = { kind: 'agent_chat', conversationId: id, workspaceId: fresh.workspace_id,
        workflowId: fresh.workflow_id, nodeId: fresh.workflow_node_id, agentId: fresh.agent_id }
      if (fresh.origin_run_id) {
        const loaded = await this.repository.state(id)
        if (!loaded || loaded.row.active_request_id !== turn.requestId || loaded.row.native_session_id !== observedSession.nativeSessionId
          || loaded.row.origin_run_id !== fresh.origin_run_id || loaded.row.origin_execution_id !== fresh.origin_execution_id) return
        scope = agentActivitySnapshot(loaded).scope
      }
      const streamSignal = AbortSignal.any([signal, observer.signal])
      const textOwner = () => ({ scope, requestId: turn.requestId, sessionId: observedSession.nativeSessionId,
        ...(nativeTurnId ? { turnId: nativeTurnId } : {}) })
      const redact = nativePersistenceRedactor([])
      const committed = committedNativeText({ id, requestId: turn.requestId, repository: this.messages,
        harness: runtime.manager.harness, session: observedSession, owner: textOwner, sanitize: (operation) => redact.value(operation),
        reconcile: () => this.scheduleReconcile(id) })
      textStream = createNativeTextStream({
        signal: streamSignal, harness: runtime.manager.harness,
        owner: textOwner,
        publish: (operation) => {
          if (operation.identity.channel !== 'assistant') return
          const message = committed.message(operation)
          this.events.publish(id, 'delta', { requestId: turn.requestId,
            ...(message ? { message } : {}),
            activityChange: activityTextEnvelope(redact.value(operation), runtime!.manager.harness),
            ...(committed.revision() ? { scopeRevision: committed.revision() } : {}) })
        },
        reconcile: () => this.events.publish(id, 'state', { requestId: turn.requestId, snapshotRequired: true }),
      })
      finishPreparation()
      runtime.observer = { requestId: turn.requestId, controller: observer }
      for await (const event_ of initialStream?.output ?? runtime.manager.startTurn(observedSession, {
        ...await turnSettings(observedSession.nativeSessionId),
        prompt: prompt.text, clientCorrelationId: correlationId,
        onMessageSubmitted: async (receipt) => {
          submitted = true
          await this.control(id, async () => {
            if (receipt.nativeSessionId !== session!.nativeSessionId || receipt.clientCorrelationId !== correlationId
              || !await this.repository.acceptedMessage(id, turn.requestId, receipt)) throw new Error('Agent native message ownership was lost.')
            nativeSubmission = receipt
          })
        },
        onSubmitted,
      }, streamSignal)) {
        submitted = true
        const event = event_
        textStream.before(event)
        const text = await committed.record(event, nativeTurnId, nativeSubmission)
        const recorded = await this.record(id, turn.requestId, runtime, event, redact, nativeTurnId, false, text.handled, nativeSubmission)
        if (recorded && text.allowed) textStream.push(event)
        else textStream.rejected(event)
        if (text.final) this.events.publish(id, 'message', { requestId: turn.requestId, snapshotRequired: true,
          scopeRevision: committed.revision() })
        if (event.type === 'interaction.pending' || event.type === 'permission.asked') {
          // Share the response lock so an older observation cannot overwrite its next approval.
          await this.control(id, async () => {
            const pending = await runtime!.manager.pending(observedSession, signal)
            await this.repository.pending(id, turn.requestId, pending)
            this.events.publish(id, 'state', { requestId: turn.requestId, pending: Boolean(pending) })
          })
        }
      }
      textStream.flush()
      await this.observe(id, turn.requestId, runtime!, correlationId)
    } catch (error) {
      await this.failedTurn(id, turn.requestId, error, { signal, observer, submitted, creatingSession, initialOffered,
        ...(textStream ? { textStream } : {}) })
    } finally {
      await initialStream?.close()
      textStream?.dispose()
      finishPreparation()
      if (runtime?.observer?.controller === observer) delete runtime.observer
    }
  }

  private async failedTurn(id: string, requestId: string, error: unknown,
    delivery: { signal: AbortSignal; observer: AbortController; submitted: boolean; creatingSession: boolean; initialOffered: boolean;
    textStream?: ReturnType<typeof createNativeTextStream> }): Promise<void> {
    const { signal, observer, submitted, creatingSession, initialOffered, textStream } = delivery
    const code = failure(error).error?.code
    componentLogger('harness').error({
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      ...(code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? { errorCode: code } : {}),
      stackFrames: error instanceof Error
        ? error.stack?.split('\n').filter(frame => /^\s+at\s/.test(frame)).slice(0, 8) ?? [] : [],
    }, 'Agent native turn failed')
    if (signal.aborted || observer.signal.aborted) textStream?.dispose(); else textStream?.flush()
    if (error instanceof RejectedSessionCreation) {
      // Retire the matching creation marker and terminal receipt in ONE ownership-fenced commit.
      // finish() also honors a Stop that committed while disposal was being confirmed.
      await this.settle(id, requestId, failure(error.rejection), undefined, true)
      return
    }
    if (this.closing || observer.signal.aborted) return // Restart recovery reconciles in-flight work.
    const current = await this.repository.get(id)
    const uncertainCodexCreation = creatingSession && current?.harness === 'codex'
    const unavailable = uncertainCodexCreation ? false : await this.markNativeUnavailable(id, error)
    if (!unavailable && creatingSession && current?.record.sessionCreation) {
      // No reliable identity/commit means read-only, not another create/fork attempt.
      await this.repository.abandon(id, requestId, 'Native session creation or binding is unconfirmed.')
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId: requestId, delivery: 'unknown' })
      return
    }
    if (!submitted && !initialOffered && (unavailable || definiteRejection(error) || error instanceof DomainError)) {
      const current = await this.repository.get(id)
      if (error instanceof NativeDeliveryError && error.delivery === 'not_sent') {
        if (!await this.repository.recordNonSubmission(id, requestId, error.operation, failure(error))) {
          throw new Error('Non-submission ownership was lost.', { cause: error })
        }
        await this.release(id)
      }
      if (unavailable || error && typeof error === 'object'
        && 'deliveryState' in error && error.deliveryState === 'not-delivered') await this.release(id)
      await this.settle(id, requestId, current?.cancel_requested ? { outcome: 'canceled' } : failure(error))
    } else {
      await this.repository.abandon(id, requestId, errorMessage(error, 'Native delivery is unconfirmed.'))
      // Retain the manager: it may still own a late acknowledgement or a live native turn.
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId: requestId, delivery: 'unknown' })
    }
  }

  private async record(id: string, requestId: string, runtime: Runtime, event: NativeHarnessEvent, redact: ReturnType<typeof nativePersistenceRedactor>, nativeTurnId: string | null, authoritativeReconciliation = false, textHandled = false, nativeSubmission?: NativeMessageSubmission, options: { retiring?: true } = {}) {
    const context = runtime.session ? runtime.manager.contextSnapshot?.(runtime.session) : null
    if (context) {
      const snapshot = structuredClone(context)
      if (options.retiring) await this.sessionControls.observeContext(id, snapshot, runtime.configuration.id)
      else {
        void this.control(id, () => this.sessionControls.observeContext(id, snapshot, runtime.configuration.id)).catch(error => {
          this.events.publish(id, 'error', { message: errorMessage(error, 'Context usage could not be saved.') })
        })
      }
    }
    const known = knownNativeActivity(event, runtime.manager.harness)
    const independent = known && (known.native.sessionId !== runtime.session?.nativeSessionId
      || known.native.turnId !== nativeTurnId)
    const settled = independent ? await this.activity.settleKnownByNative(id, known.change, known.native, redact) : undefined
    if (settled) this.events.publish(id, 'activity', settled)
    const change = operatorActivity(event, runtime.manager.harness, requestId)
    if (!settled && change && change.kind !== 'thinking'
      && (!known || known.native.sessionId === runtime.session?.nativeSessionId && known.native.turnId === nativeTurnId)) {
      if (!runtime.session || !nativeTurnId && !nativeSubmission) { this.scheduleReconcile(id); return true }
      const accepted = await this.activity.append(id, requestId, redact.value(change), {
        ...nativeActivityFence(runtime.session, nativeTurnId, event, authoritativeReconciliation, nativeSubmission),
        onReconciliationRequired: () => this.scheduleReconcile(id),
      })
      if (accepted) this.events.publish(id, 'activity', accepted)
    }
    if (textHandled) return true
    const message = completedNativeAssistantMessage(event, runtime.manager.harness)
    if (!message) return true
    if (await this.messages.appendAssistantMessage(id, requestId, message.id, message.text,
      message.parentMessageId || message.truncation ? {
        ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
        ...(message.truncation ? { truncation: message.truncation } : {}), complete: message.complete === true,
      } : undefined)) {
      this.events.publish(id, 'message', { requestId, nativeMessageId: message.id })
      return true
    }
    return false
  }

  /** Settle from native history: identity must match, and only terminal evidence completes a turn. */
  private async observe(id: string, requestId: string, runtime: Runtime, correlationId: string, controlled = false,
    options: { signal?: AbortSignal; retiring?: true } = {}): Promise<void> {
    const row = await this.repository.get(id)
    if (!row || row.active_request_id !== requestId) return
    const history = await runtime.manager.reconcile(runtime.session!, correlationId,
      options.signal ?? AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
    if (options.retiring && !history.terminalResult && !history.nonSubmission) return
    const rejected = history.nonSubmission
    if (rejected && rejected.nativeSessionId === row.native_session_id
      && rejected.clientCorrelationId === correlationId && !row.active_native_turn_id) {
      if (!await this.repository.recordNonSubmission(id, requestId, 'turn_submission', rejected.result)) return
      if (!options.retiring) await this.release(id)
      await this.settle(id, requestId, row.cancel_requested ? { outcome: 'canceled' } : rejected.result)
      return
    }
    const receipt = history.nativeSubmission
    const messageIdentity = receipt?.kind === 'message' && receipt.nativeSessionId === runtime.session!.nativeSessionId && receipt.clientCorrelationId === correlationId
    const providerId = history.nativeTurnId ?? (messageIdentity ? receipt.nativeMessageId : undefined)
    if (runtime.session?.nativeSessionId !== row.native_session_id || history.correlationId !== correlationId || !providerId
      || row.active_native_turn_id && history.nativeTurnId !== row.active_native_turn_id
      || history.terminalTurn && (history.terminalTurn.correlationId !== correlationId || history.terminalTurn.providerId !== providerId)) {
      await this.repository.abandon(id, requestId, 'The provider has not proven this exact message and native turn. It will not be resent automatically.')
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId, delivery: 'unknown' })
      return
    }
    if (messageIdentity) { if (!await this.repository.acceptedMessage(id, requestId, receipt!)) return }
    else await this.repository.accepted(id, requestId, history.nativeTurnId!)
    const redact = nativePersistenceRedactor([])
    for (const event of currentOperatorHistory(history, runtime.manager.harness)) await this.record(id, requestId, runtime, event, redact, history.nativeTurnId ?? null, true, false, messageIdentity ? receipt : undefined, options)
    const current = await this.repository.get(id)
    if (!current || current.active_request_id !== requestId || current.native_session_id !== row.native_session_id) return
    const pending = pendingInteractionAfterHistory(current.pending_interaction, history)
    if (messageIdentity || history.responseDeliveries?.length) {
      const sender = (await this.pool.query<{ principal_id: string }>(`select payload->>'ownerPrincipalId' as principal_id
        from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]
      if (sender?.principal_id) {
        const principal = await readLiveManagementPrincipal(this.pool, sender.principal_id)
        const state = await this.readConversation(principal, row.workspace_id, id)
        const scope = state.activitySnapshot?.scope
        if (scope) {
          if (messageIdentity) {
            await this.commands.reconcileStoredResponses(id, requestId, scope, runtime.session!, receipt!, state)
          }
          for (const proof of history.responseDeliveries ?? []) {
            const identity = proof.nativeIdentity ?? (history.nativeTurnId
              ? { kind: 'turn' as const, nativeTurnId: history.nativeTurnId } : undefined)
            if (identity) await this.commands.reconcileResponses(id, requestId, scope, runtime.session!,
              identity, history.responseDeliveries!, state)
          }
        }
      }
    }
    if (history.terminalResult && !pending) {
      await this.settle(id, requestId, history.terminalResult, history.nativeMessageId)
    } else {
      // Acknowledged but not terminal (including approvals) still owns the native session.
      if (controlled) await this.repository.pending(id, requestId, pending)
      else await this.control(id, () => this.repository.pending(id, requestId, pending))
      // Acceptance can be learned without onSubmitted (lost ACK or restart after Stop's commit).
      // A cancel acknowledgement is not terminal proof and never releases the queue.
      if (!options.retiring && (history.nativeTurnId || messageIdentity)) await this.interruptActive(id, false, { requestId, nativeTurnId: history.nativeTurnId ?? null }, controlled)
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId, delivery: 'accepted' })
    }
  }

  private async settle(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, rejectedSessionCreation = false): Promise<void> {
    if (await this.repository.finish(id, requestId, result, nativeMessageId, rejectedSessionCreation)) {
      const runtime = this.runtimes.get(id)
      if (runtime?.session) {
        const retirement = await runtime.manager.retireTurn?.(runtime.session, agentChatCorrelation(id, requestId))
        // Retirement may settle inside release(); its existing disposal owns the remaining cleanup.
        if (retirement?.runtimeReleased && !runtime.disposal) await this.release(id)
      }
      const observer = runtime?.observer
      if (observer?.requestId === requestId) observer.controller.abort(new Error('Agent chat turn settled.'))
      this.events.publish(id, 'message', { requestId })
      this.scheduleReconcile(id)
      // Rejected creation may have become canceled under the repository lock. Invalidate rather
      // than publishing an outcome chosen before that concurrent Stop committed.
      this.events.publish(id, 'state', { requestId,
        ...(rejectedSessionCreation ? {} : { delivery: result.outcome === 'succeeded' ? 'completed' : result.outcome }) })
    }
  }

  /** Poll exact native history even when the event stream or an interrupt notification is silent. */
  private scheduleReconcile(id: string): void {
    if (this.closing || this.reconciliationTimers.has(id)) return
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(id)
      // Own the complete repair, including its post-control SQL reads, until shutdown drains it.
      void this.command(() => this.repair(id)).catch((error: unknown) => {
        this.events.publish(id, 'error', { message: errorMessage(error, 'Native reconciliation failed.') })
        this.scheduleReconcile(id)
      })
    }, 1_000)
    timer.unref()
    this.reconciliationTimers.set(id, timer)
  }

  private async recoverCreation(row: AgentConversationRow): Promise<boolean> {
    const requestId = row.active_request_id
    if (!requestId || row.record.sessionCreation?.requestId !== requestId) return false
    let runtime = this.runtimes.get(row.id)
    if (!runtime) {
      const configuration = await this.conversationConfiguration(row)
      if (!configuration) return false
      const accountSource = row.record.origin.kind === 'run_execution' && !row.record.sourceConfigurationVersionId
        ? { executionId: row.record.origin.executionId } : undefined
      const accepted = await this.repository.turnPreparedInput(row.id, requestId)
      const featureContext = await conversationFeatureContext(this.pool, row, configuration, accepted?.input.conversationContext?.workflowVersionId)
      if (accepted?.input.conversationContext && (commandInputHash(featureContext.subject) !== commandInputHash(accepted.input.conversationContext.subject)
        || featureContext.workingDirectory !== accepted.input.conversationContext.workingDirectory)) {
        throw new DomainError('CHAT_SUBJECT_CHANGED', 'The accepted conversation feature scope changed before recovery.', 409)
      }
      const manager = await this.managers(row.id, configuration, row.record.workingDirectory, accountSource, featureContext)
      if (!manager.reconcileSessionCreation) {
        await manager.dispose?.()
        this.managers.release?.(row.id)
        return false
      }
      runtime = { manager, configuration, creationInput: this.startInput(row, configuration, agentChatCorrelation(row.id, requestId),
          forksRunHistory(row)) }
      this.runtimes.set(row.id, runtime)
      const preferences = await this.sessionControls.preferences(row.id)
      if (preferences) await runtime.manager.configureSessionPreferences?.(preferences)
    }
    const input = runtime.creationInput
    if (!input
      || runtime.retiring || runtime.disposal) return false
    if (input.kind === 'operator' || input.correlationId !== agentChatCorrelation(row.id, requestId)
      || sessionStartConfiguration(input).id !== row.agent_configuration_version_id) return false
    const source = forksRunHistory(row) && row.record.origin.kind === 'run_execution'
      ? { harness: row.harness, providerVersion: await this.sourceProviderVersion(row.record.origin, runtime),
          nativeSessionId: row.record.origin.sourceNativeSessionId }
      : undefined
    let session: NativeSessionReference | undefined
    try {
      session = runtime.session ?? await runtime.manager.reconcileSessionCreation?.(input, this.lifetime.signal, source)
    } catch (error) {
      if (!definiteNonCreation(error)) throw error
      if (!await this.repository.recordNonSubmission(row.id, requestId, 'session_creation', failure(error))) {
        throw new Error('Non-creation ownership was lost.', { cause: error })
      }
      await this.release(row.id)
      await this.settle(row.id, requestId, failure(error), undefined, true)
      return true
    }
    if (!session || session.harness !== row.harness) return false
    this.lifetime.signal.throwIfAborted()
    if (this.runtimes.get(row.id) !== runtime || runtime.retiring || runtime.disposal) return false
    runtime.session = session
    if (!forksRunHistory(row) && (await this.repository.initialInputOffered(row.id, requestId)
      || row.harness === 'claude')) {
      await this.repository.bindSession(row.id, session.providerVersion, session.nativeSessionId)
      await this.observe(row.id, requestId, runtime, agentChatCorrelation(row.id, requestId), true)
      return true
    }
    const result = failure(new Error('The original session was recovered before the message was sent. Send the message again.'))
    await this.repository.bindCreatedSession(row.id, requestId, row.agent_configuration_version_id, session, result)
    const current = await this.repository.get(row.id)
    await this.settle(row.id, requestId, current?.cancel_requested ? { outcome: 'canceled' } : result)
    return true
  }

  private async repair(id: string): Promise<void> {
    await this.control(id, async () => {
      const row = await this.repository.restoreUnsettled(id)
      if (!row || row.harness === 'opencode' || row.record.sessionUnavailable) return
      if (row.active_request_id && this.preparations.get(id)?.requestId === row.active_request_id) {
        this.scheduleReconcile(id)
        return // The live owner must finish creation/binding; a temporarily null identity is not loss.
      }
      const steers = await this.repository.unconfirmedSteers(id)
      const requestId = row.active_request_id
      // A steer-only recovery attaches using its ORIGINAL turn, never the steer as an active turn.
      const target = steers.find((entry) => entry.targetRequestId && entry.targetNativeTurnId)
      const recoveryRequestId = requestId ?? target?.targetRequestId
      if (!recoveryRequestId) {
        const remaining = await reconcileKnownActivities({ kind: 'agent', conversationId: id, activity: this.activity,
          observations: this.activityObservations,
          onObservation: candidate => this.events.publish(candidate, 'state', { snapshotRequired: true }),
          signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
          runtimeFor: (candidate) => {
            const runtime = this.runtimes.get(candidate)
            return runtime?.session && !runtime.disposal && !runtime.retiring ? { manager: runtime.manager, session: runtime.session } : undefined
          }, publish: (candidate, settled) => this.events.publish(candidate, 'activity', settled) })
        if (remaining && this.runtimes.get(id)?.manager.harness === 'codex') this.scheduleReconcile(id)
        for (const steer of steers) if (steer.delivery === 'submitting') {
          await this.repository.unknown(id, steer.requestId, 'The original steering target is not established. No input was resent.')
          this.events.publish(id, 'turn', { requestId: steer.requestId, delivery: 'unknown' })
        }
        if (steers.length) this.scheduleReconcile(id)
        return
      }
      const correlationId = agentChatCorrelation(id, recoveryRequestId)
      try {
        const nonSubmission = requestId && nativeNonSubmission(row.record, requestId)
        if (nonSubmission) {
          await this.release(id)
          await this.settle(id, nonSubmission.requestId,
            row.cancel_requested ? { outcome: 'canceled' } : nonSubmission.result, undefined,
            nonSubmission.operation === 'session_creation')
          return
        }
        if (!row.native_session_id) {
          if (await this.recoverCreation(row)) return
          if (this.runtimes.has(id)) {
            this.scheduleReconcile(id)
            return
          }
          await this.repository.markSessionUnavailable(id, 'No native session identity was stored before recovery. This conversation is read-only; no replacement session will be created automatically.')
          if (requestId) await this.repository.abandon(id, requestId, 'Native session creation is unconfirmed.')
          this.events.publish(id, 'state', { delivery: 'unknown' })
          return
        }
        const configuration = await this.conversationConfiguration(row)
        if (!configuration) throw new Error('The pinned Agent configuration is unavailable.')
        const binding = requestId ? row : { ...row, active_native_turn_id: target!.targetNativeTurnId }
        const principalId = await this.repository.turnPrincipalId(id, recoveryRequestId)
        const runtime = await this.runtime(binding, configuration, correlationId,
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]), principalId)
        if (requestId) await this.observe(id, requestId, runtime, correlationId, true)
        if (steers.length) {
          const identities = steers.flatMap((entry) => entry.targetNativeTurnId
            ? [{ clientCorrelationId: agentChatCorrelation(id, entry.requestId), expectedTurnId: entry.targetNativeTurnId }] : [])
          // This read must not retarget the manager's active correlation, even when a later turn owns it.
          const evidence = await runtime.manager.reconcileSteers?.(runtime.session!, identities,
            AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])).catch((error: unknown) => {
              // Failure to read an OLD steer is not loss of the independently proven active turn.
              this.events.publish(id, 'error', { message: errorMessage(error, 'Steer receipt lookup failed.') })
              return []
            }) ?? []
          let unresolved = false
          for (const steer of steers) {
            const proven = evidence.some((entry) => entry.nativeSessionId === row.native_session_id
              && entry.correlationId === agentChatCorrelation(id, steer.requestId)
              && entry.nativeTurnId === steer.targetNativeTurnId)
            if (proven) {
              await this.repository.steerAccepted(id, steer.requestId, steer.targetNativeTurnId!)
              this.events.publish(id, 'turn', { requestId: steer.requestId })
            } else {
              unresolved = true
              await this.repository.unknown(id, steer.requestId, 'The provider has not proven this steering input. It will not be resent automatically.')
              if (steer.delivery === 'submitting') this.events.publish(id, 'turn', { requestId: steer.requestId, delivery: 'unknown' })
            }
          }
          if (unresolved) this.scheduleReconcile(id)
        }
      } catch (error) {
        const unavailable = await this.markNativeUnavailable(id, error)
        if (requestId) await this.repository.abandon(id, requestId,
          `Native delivery is not yet confirmed. ${errorMessage(error, '')}`.trim())
        // Also convert a crash-left provisional steer; missing evidence never means acceptance.
        for (const steer of steers) await this.repository.unknown(id, steer.requestId, 'Steer delivery is not yet confirmed.')
        if (unavailable || error && typeof error === 'object'
          && 'deliveryState' in error && error.deliveryState === 'not-delivered') await this.release(id)
        else this.scheduleReconcile(id)
        this.events.publish(id, 'state', { delivery: 'unknown' })
      }
    })
    const current = await this.repository.get(id)
    if (current && !current.active_request_id && !current.record.sessionUnavailable && await this.repository.nextQueued(id)) this.pump(id)
  }

  private async reconcileRetiringRuntime(id: string, runtime: Runtime): Promise<void> {
    if (!this.closing || !runtime.session || !runtime.manager.requiresSettledDisposal?.()) return
    const row = await this.repository.get(id)
    if (!row) return
    const signal = AbortSignal.timeout(30_000)
    await this.sessionControls.reconcileForRetirement(id, runtime.manager, runtime.session, signal)
    if (!row.active_request_id) return
    const principalId = await this.repository.turnPrincipalId(id, row.active_request_id)
    if (principalId) runtime.manager.setSessionControlPrincipal?.(principalId)
    await this.observe(id, row.active_request_id, runtime, agentChatCorrelation(id, row.active_request_id), true,
      { signal, retiring: true })
    if ((await this.repository.get(id))?.active_request_id) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'Native completion is unconfirmed; chat cleanup remains owned.', 409)
    }
  }

  private async release(id: string, options?: { workerClosure: 'close' | 'release' }): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.retiring = true
    const disposal = runtime.disposal ??= Promise.resolve().then(async () => {
      await this.reconcileRetiringRuntime(id, runtime)
      if (options && runtime.session) {
        if (options.workerClosure === 'close') await runtime.manager.close(runtime.session)
        else {
          if (!runtime.manager.closeForResume) throw new DomainError('NATIVE_RUNTIME_RELEASE_UNAVAILABLE',
            'The Worker cannot confirm closure of its resumable process.', 409)
          await runtime.manager.closeForResume(runtime.session)
        }
      }
      if (runtime.manager.dispose) await runtime.manager.dispose()
      else if (runtime.session) await runtime.manager.close(runtime.session)
      else throw new Error('The unbound Agent chat manager cannot prove native disposal.')
      // Both maps retain ownership until cleanup positively succeeds.
      this.managers.release?.(id)
      this.runtimes.delete(id)
      this.pendingObservations.delete(id)
    })
    try { await disposal } catch (error) {
      if (runtime.disposal === disposal) delete runtime.disposal
      throw error
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Recover exact stored sessions; unresolved work remains fenced and is polled without resubmission. */
  recover(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.recovery) return this.recovery
    const task = Promise.resolve().then(() => this.recoverConversations())
    this.recovery = task
    void task.finally(() => { if (this.recovery === task) this.recovery = undefined }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return task
  }
  private async recoverConversations(): Promise<void> {
    if (this.closing) return
    for (const row of await this.repository.open()) {
      if (this.closing) return
      if (row.harness === 'opencode') continue
      await this.repair(row.id)
    }
  }

  shutdown(): Promise<void> {
    this.closing = true
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer)
    this.reconciliationTimers.clear()
    this.lifetime.abort(new Error('Agent chat is shutting down.'))
    if (this.shutdownAttempt) return this.shutdownAttempt
    const attempt = Promise.resolve().then(async () => {
      // An admitted command/recovery pass may still be awaiting SQL or publishing control work.
      // Drain producers before disposing managers or allowing the production owner to unlock.
      while (this.inflightCommands.size || this.tasks.size || this.controls.size || this.preparations.size || this.recovery) {
        await Promise.allSettled([...this.inflightCommands, ...this.tasks.values(), ...this.controls.values(),
          ...[...this.preparations.values()].map((entry) => entry.done), ...(this.recovery ? [this.recovery] : [])])
      }
      await this.commands.drain()
      const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.release(id)))
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Agent chat native cleanup was incomplete; ownership is retained for retry.')
    })
    this.shutdownAttempt = attempt
    void attempt.catch(() => { if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined })
    return attempt
  }
}
