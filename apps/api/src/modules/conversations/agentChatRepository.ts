import { omitProperties } from '../../shared/omitProperties.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { boundedConversationMessages } from './snapshotMessages.js'
import { admitSessionMessage } from './sessionControls/messageAdmission.js'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { assertAgentChatDirectoryAvailable } from './agentChatDirectory.js'
import type { NativeMessageSubmission } from '../harnesses/port.js'
import type { AcceptedChatInput } from './nativeChatInput.js'
import { recordNativeNonSubmission, type NativeNonSubmission } from './nativeNonSubmission.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { messageAttachmentIdentity } from '@foreman-code/contracts/files'

import { validateMessageAttachments, withMessageAttachmentRefs, hydrateMessageAttachments } from './messageAttachments.js'

import { ExecutionResultSchema, MessageSchema, PendingNativeInteractionSchema, type ExecutionResult, type ActivitySourceRevision, type AgentHarness, type RecordedAgentHarness, type Message, type NativeSessionReference, type PendingNativeInteraction, type PromptSettingSnapshot, type ActivityScope } from '@foreman-code/contracts'
import {
  AgentChatTurnSchema, AgentConversationSchema, type AgentChatContext, type AgentChatIntent, type AgentChatOrigin,
  type AgentChatTurn, type AgentConversation, type AgentChatReplayWarning, type SendAgentChatMessageRequest,
  type AgentChatDirectoryBinding,
} from '@foreman-code/contracts/agent-chat'

import { DomainError } from '../errors.js'
import { readSystemPromptSetting } from '../settings/foundation.js'
import { assertConversationCursor, withConversationPageRead } from './activityCursor.js'
import { readActivityCommands } from './activityCommands.js'
import { readConversationPublicationReceipts, type ConversationPublicationReceipt } from './messagePublications.js'
import { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { OPERATOR_SNAPSHOT_MESSAGE_BYTES, OPERATOR_HISTORY_PAGE_BYTES } from './operatorChatRepository.js'
import { agentConfigurationHandoff } from './agentConfigurationTransition.js'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { legacyProviderAccountBinding, readProviderAccountBinding, type AcceptedProviderAccountBindings }
  from '../provider-accounts/acceptedBindings.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'

type Queryable = SqlQuery
type State = NonNullable<Awaited<ReturnType<PostgresAgentChatRepository['state']>>>
export function agentActivityScope(loaded: Pick<State, 'row' | 'selection'>): ActivityScope {
  const { row } = loaded
  const scope: ActivityScope = row.origin_run_id && row.origin_execution_id && loaded.selection
    ? { kind: 'selected_run_chat', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
      nodeId: row.workflow_node_id, agentId: row.agent_id, selection: { workspaceId: row.workspace_id, workflowId: row.workflow_id,
        runId: row.origin_run_id, workflowVersionId: loaded.selection.workflowVersionId, executionId: row.origin_execution_id, attemptKey: loaded.selection.attemptKey } }
    : { kind: 'agent_chat', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id, nodeId: row.workflow_node_id, agentId: row.agent_id }
  if (row.origin_run_id && !loaded.selection) throw new Error('Selected Run chat lost its exact persisted origin.')
  return scope
}

/** Agent rows in the shared conversation table. Operator columns stay null. */
export interface AgentConversationRow {
  worker_conversation_binding?: unknown
  providerAccountBinding?: AcceptedProviderAccountBinding
  id: string
  agent_key: string
  workspace_id: string
  workflow_id: string
  workflow_node_id: string
  agent_id: string
  agent_configuration_version_id: string
  origin_run_id: string | null
  origin_execution_id: string | null
  harness: RecordedAgentHarness
  provider_version: string | null
  native_session_id: string | null
  active_request_id: string | null
  active_native_turn_id: string | null
  cancel_requested: boolean
  turn_state: 'idle' | 'starting' | 'active' | 'canceling' | 'uncertain' | 'error'
  last_error: string | null
  revision: string | number
  pending_interaction: PendingNativeInteraction | null
  last_result: ExecutionResult | null
  record: {
    previousConversationId?: string
    archived?: boolean
    freshSession?: boolean
    origin: AgentChatOrigin; workingDirectory: string; runtimeDirectory: string; startupDelivered?: boolean; sessionUnavailable?: string
    directoryBinding?: AgentChatDirectoryBinding
    systemPrompt?: PromptSettingSnapshot
    sessionUnavailableReason?: 'native_session_missing' | 'harness_unavailable'
    /** Durable fence: an unbound native creation is never permission to create a replacement. */
    sessionCreation?: { requestId: string }
    nativeNonSubmission?: NativeNonSubmission
    startupReceipt?: { requestId: string; nativeSessionId: string }
    sourceConfigurationVersionId?: string
    workerGeneration?: string
    handoffContext?: string
  }
  created_at: Date
  updated_at: Date
}

interface TurnRow {
  request_id: string
  turn_sequence: string
  intent: AgentChatIntent
  delivery: AgentChatTurn['delivery']
  message_id: string
  native_turn_id: string | null
  target_native_turn_id: string | null
  delivery_error: { code: string; message: string } | null
  input_hash: string
  payload: { content: string; interruptRequestId?: string; targetRequestId?: string; requestIdentityVersion?: 1; ownerPrincipalId?: string; nativeSubmission?: NativeMessageSubmission }
  created_at: Date
  updated_at: Date
  started_at: Date | null
}

export const AGENT_CHAT_MESSAGE_LIMIT = 100
/** Every unfinished receipt must fit in the frozen AgentChatState.turns window. */
export const AGENT_CHAT_OPEN_TURN_LIMIT = 100
const OPEN_DELIVERIES = ['queued', 'submitting', 'accepted', 'unknown'] as const

/** Stable selection key. `runId` absent is its own key, never a wildcard. */
export function agentChatKey(context: AgentChatContext): string {
  return JSON.stringify([context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId, context.runId ?? null])
}
/** Native correlation for one chat turn. Distinct from Operator and workflow correlations. */
export function agentChatCorrelation(conversationId: string, requestId: string): string {
  return `agent-chat:${conversationId}:${requestId}`
}
export function agentChatInputHash(input: Pick<SendAgentChatMessageRequest, 'content' | 'intent' | 'context' | 'expectedNativeTurnId'>
  & Partial<Pick<SendAgentChatMessageRequest, 'requestId' | 'attachments' | 'sessionMode'>>): string {
  // Keep untargeted receipt identities stable; a supplied native precondition is part of the command.
  return createHash('sha256').update(JSON.stringify([input.content, input.intent, input.context,
    ...(input.expectedNativeTurnId === undefined ? [] : [input.expectedNativeTurnId]),
    ...(input.sessionMode ? [{ sessionMode: input.sessionMode }] : []),
    ...(input.attachments?.length ? [{ attachmentIdentity: messageAttachmentIdentity({ requestId: input.requestId!, attachments: input.attachments }) }] : [])])).digest('hex')
}

export function agentConversation(row: AgentConversationRow): AgentConversation {
  return AgentConversationSchema.parse({
    id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
    agentId: row.agent_id, agentConfigurationVersionId: row.agent_configuration_version_id, harness: row.harness,
    origin: row.record.origin,
    ...(row.record.previousConversationId ? { previousConversationId: row.record.previousConversationId } : {}),
    ...(row.record.archived ? { archived: true } : {}),
    ...(row.providerAccountBinding ? { providerAccountBinding: row.providerAccountBinding } : {}),
    ...(row.record.systemPrompt ? { systemPrompt: row.record.systemPrompt } : {}),
    nativeSession: row.native_session_id && row.provider_version
      ? { nativeSessionId: row.native_session_id, providerVersion: row.provider_version } : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  })
}
function turn(row: TurnRow): AgentChatTurn {
  return AgentChatTurnSchema.parse({
    requestId: row.request_id, sequence: row.turn_sequence, intent: row.intent, delivery: row.delivery, messageId: row.message_id,
    ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    ...(row.payload.nativeSubmission ? { nativeSubmission: row.payload.nativeSubmission } : {}),
    ...(row.target_native_turn_id ? { targetNativeTurnId: row.target_native_turn_id } : {}),
    ...(row.delivery_error ? { error: row.delivery_error } : {}),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  })
}
const TURN_COLUMNS = `request_id,turn_sequence::text,intent,delivery,message_id,native_turn_id,target_native_turn_id,
  delivery_error,input_hash,payload,created_at,updated_at,started_at`

/** Captured while holding the conversation row lock, never resolved from a later active request. */
export interface AgentChatInterruptTarget {
  requestId: string
  nativeTurnId: string | null
}

export interface NewAgentConversation {
  /** A read-only resolver may reserve a deterministic exact candidate, without creating it. */
  id?: string
  freshSession?: boolean
  context: AgentChatContext
  agentConfigurationVersionId: string
  harness: AgentHarness
  origin: AgentChatOrigin
  workingDirectory: string
  runtimeDirectory: string
  directoryBinding?: AgentChatDirectoryBinding
  systemPrompt?: PromptSettingSnapshot
}

export class PostgresAgentChatRepository {
  private settledProjection?: (tx: TransactionSql, input: { row: AgentConversationRow; requestId: string;
    result: ExecutionResult; nativeMessageId?: string }) => Promise<void>
  constructor(readonly pool: pg.Pool, private readonly accountBindings?: AcceptedProviderAccountBindings) {}

  /** Installed once by C's feature composition. The native terminal journal and pending projection commit together. */
  setCommittedChatProjection(project: NonNullable<PostgresAgentChatRepository['settledProjection']>): void {
    if (this.settledProjection) throw new Error('The committed Agent chat projection is already installed.')
    this.settledProjection = project
  }

  private async acceptAccount(sql: Queryable, row: AgentConversationRow) {
    if (!this.accountBindings) return
    const found = (await sql.query<{ record: unknown }>(
      'select record from agent_configuration_versions where id=$1', [row.agent_configuration_version_id])).rows[0]
    if (!found) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The accepted chat configuration is unavailable.', 409)
    const configuration = AgentConfigurationVersionSchema.parse(found.record)
    const origin = row.record.origin
    const source = origin.kind === 'run_execution'
      ? await readProviderAccountBinding(sql, 'run-node', `${origin.runId}:${row.workflow_node_id}`)
        ?? legacyProviderAccountBinding(configuration.harness, configuration.harnessProfileSelection)
      : undefined
    const binding = await this.accountBindings.accept(sql, 'agent-conversation', row.id,
      configuration.harness, configuration.harnessProfileSelection, { source })
    if (binding) row.providerAccountBinding = binding
  }

  private async accountReadback(query: Queryable, row: AgentConversationRow | undefined) {
    if (!row || !this.accountBindings) return row
    let binding = await readProviderAccountBinding(query, 'agent-conversation', row.id)
    if (!binding) {
      const configuration = (await query.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1', [row.agent_configuration_version_id])).rows[0]
      if (configuration) {
        const saved = AgentConfigurationVersionSchema.parse(configuration.record)
        binding = legacyProviderAccountBinding(saved.harness, saved.harnessProfileSelection)
      }
    }
    if (binding) row.providerAccountBinding = binding
    return row
  }

  unfinishedActivityOwners(conversationId?: string) { return new PostgresOperatorActivityRepository(this.pool).unfinishedOwners('agent', conversationId) }

  async byKey(key: string, query: Queryable = this.pool): Promise<AgentConversationRow | undefined> {
    return this.accountReadback(query, (await query.query<AgentConversationRow>(
      `select * from operator_conversations where kind='agent' and agent_key=$1 and deleted_at is null`, [key])).rows[0])
  }
  async ensureForControls(key: string, create: NewAgentConversation,
    authorize: (client: pg.PoolClient) => Promise<void>, client?: pg.PoolClient): Promise<AgentConversationRow> {
    const ensure = async (client: pg.PoolClient) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${key}`])
      await authorize(client)
      let row = await this.byKey(key, client)
      if (!row) {
        const id = create.id ?? randomUUID()
        const { context, origin, workingDirectory, runtimeDirectory, directoryBinding } = create
        const systemPrompt = origin.kind === 'run_execution' ? create.systemPrompt : undefined
        await client.query(`insert into operator_conversations
          (id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,
           origin_run_id,origin_execution_id,harness,record)
          values($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [id,key,context.workspaceId,context.workflowId,context.workflowNodeId,context.agentId,
          create.agentConfigurationVersionId,origin.kind === 'run_execution' ? origin.runId : null,
          origin.kind === 'run_execution' ? origin.executionId : null,create.harness,
          JSON.stringify({ origin, workingDirectory, runtimeDirectory,
            ...(create.freshSession ? { freshSession: true } : {}),
            ...(directoryBinding ? { directoryBinding } : {}), ...(systemPrompt ? { systemPrompt } : {}) })])
        row = (await this.get(id, client))!
        await this.acceptAccount(client, row)
      }
      return row
    }
    return client ? ensure(client) : withTransaction(this.pool, ensure)
  }

  async get(id: string, query: Queryable = this.pool): Promise<AgentConversationRow | undefined> {
    return this.accountReadback(query, (await query.query<AgentConversationRow>(
      `select * from operator_conversations where kind='agent' and id=$1 and deleted_at is null`, [id])).rows[0])
  }

  /** Only the caller holding the context/admission lock may materialize a read-resolved candidate. */
  async ensureDeliveryCandidate(tx: TransactionSql, key: string, create: NewAgentConversation & { id: string }): Promise<AgentConversationRow> {
    const current = await this.byKey(key, tx)
    if (current) {
      if (current.id !== create.id) throw new DomainError('CHAT_TARGET_CHANGED', 'The selected conversation changed before admission.', 409)
      return current
    }
    const { context, origin, workingDirectory, runtimeDirectory, directoryBinding } = create
    const systemPrompt = origin.kind === 'fresh' ? await readSystemPromptSetting(tx) : create.systemPrompt
    await tx.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
      agent_configuration_version_id,origin_run_id,origin_execution_id,harness,record)
      values($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [create.id, key, context.workspaceId,
    context.workflowId, context.workflowNodeId, context.agentId, create.agentConfigurationVersionId,
    origin.kind === 'run_execution' ? origin.runId : null, origin.kind === 'run_execution' ? origin.executionId : null,
    create.harness, JSON.stringify({ origin, workingDirectory, runtimeDirectory,
      ...(directoryBinding ? { directoryBinding } : {}), ...(systemPrompt ? { systemPrompt } : {}) })])
    const row = (await this.get(create.id, tx))!
    await this.acceptAccount(tx, row)
    return row
  }

  async replaceConversation(client: pg.PoolClient, row: AgentConversationRow): Promise<string> {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${row.agent_key}`])
    const current = (await client.query<AgentConversationRow>(
      "select * from operator_conversations where id=$1 and kind='agent' and deleted_at is null for update", [row.id])).rows[0]
    if (!current || current.agent_key !== row.agent_key || current.record.archived) {
      throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'Refresh before starting a new conversation.', 409)
    }
    const id = randomUUID()
    const { origin, workingDirectory, directoryBinding, systemPrompt, sourceConfigurationVersionId } = current.record
    await client.query(`update operator_conversations set agent_key=$2,
      record=record || '{"archived":true}'::jsonb,revision=revision+1 where id=$1`, [row.id, `history:${row.id}`])
    await client.query(`insert into operator_conversations
      (id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,
       origin_run_id,origin_execution_id,harness,record)
      values($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [id,current.agent_key,current.workspace_id,current.workflow_id,current.workflow_node_id,current.agent_id,
      current.agent_configuration_version_id,current.origin_run_id,current.origin_execution_id,current.harness,
      JSON.stringify({ origin, workingDirectory, runtimeDirectory: '', directoryBinding, systemPrompt,
        sourceConfigurationVersionId, previousConversationId: row.id, freshSession: true })])
    await this.acceptAccount(client, (await this.get(id, client))!)
    return id
  }
  /** Conversations with an in-flight or queued turn, oldest first. */
  async open(): Promise<AgentConversationRow[]> {
    return (await this.pool.query<AgentConversationRow>(`select c.* from operator_conversations c
      where c.kind='agent' and c.deleted_at is null and (c.active_request_id is not null or exists (
        select 1 from operator_conversation_turns t where t.conversation_id=c.id and t.delivery in ('queued','submitting','accepted','unknown')))
      order by c.updated_at,c.id`)).rows
  }

  /** Restore ownership for receipts left orphaned by an older process. Never re-submit them. */
  async restoreUnsettled(id: string): Promise<AgentConversationRow | undefined> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations
        where id=$1 and kind='agent' and deleted_at is null for update`, [id])).rows[0]
      if (row?.harness === 'opencode') {
        return row
      }
      if (row && !row.active_request_id) {
        const unresolved = (await client.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
          where conversation_id=$1 and intent <> 'steer' and delivery in ('submitting','accepted','unknown')
          order by turn_sequence limit 1`, [id])).rows[0]
        if (unresolved) {
          await client.query(`update operator_conversations set active_request_id=$2,active_native_turn_id=$3,
            active_phase=case when $3::text is null then 'accepted' else 'submitted' end,
            turn_state='uncertain',revision=revision+1,updated_at=now() where id=$1`,
          [id, unresolved.request_id, unresolved.native_turn_id])
        }
      }
      if (row?.record.sessionUnavailable) {
        // Older unavailable conversations skip native repair, but must not retain a running UI claim.
        // The conversation lock and exact unknown-receipt join preserve concurrent terminal evidence.
        const activity = await client.query(`update operator_conversation_activity as activity set revision=activity.revision+1,
          record=jsonb_set(activity.record,'{status}','"unknown"'::jsonb)
          where activity.conversation_id=$1 and activity.record->>'status' in ('pending','running')
            and exists (select 1 from operator_conversation_turns receipt
              where receipt.conversation_id=activity.conversation_id and receipt.request_id=activity.request_id
                and receipt.delivery='unknown')`, [id])
        if (activity.rowCount) await this.bump(id, client)
      }
      const restored = row ? await this.get(id, client) : undefined
      return restored
    })
  }

  async turn(id: string, requestId: string, query: Queryable = this.pool): Promise<AgentChatTurn | undefined> {
    const row = (await query.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
      where conversation_id=$1 and request_id=$2 and intent is not null`, [id, requestId])).rows[0]
    return row ? turn(row) : undefined
  }
  async turnPrincipalId(id: string, requestId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ owner: string | null }>(`select payload->>'ownerPrincipalId' as owner
      from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])
    return result.rows[0]?.owner ?? undefined
  }

  async turnSessionMode(id: string, requestId: string): Promise<'regular' | 'plan' | undefined> {
    const result = await this.pool.query<{ mode: unknown }>(`select payload->>'sessionMode' as mode
      from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])
    const mode = result.rows[0]?.mode
    return mode === 'regular' || mode === 'plan' ? mode : undefined
  }

  async turnContent(id: string, requestId: string): Promise<string | undefined> {
    return (await this.pool.query<{ content: string }>(`select payload->>'content' as content from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]?.content
  }

  async markInitialInputOffered(id: string, requestId: string): Promise<void> {
    const changed = await this.pool.query(`update operator_conversation_turns t
      set payload=payload || '{"initialInputOffered":true}'::jsonb
      from operator_conversations c where c.id=t.conversation_id and c.id=$1
        and c.active_request_id=$2 and t.request_id=$2 and c.deleted_at is null`, [id, requestId])
    if (changed.rowCount !== 1) throw new DomainError('CHAT_OWNER_CHANGED', 'The initial native input lost its admitted owner.', 409)
  }

  async initialInputOffered(id: string, requestId: string): Promise<boolean> {
    const row = (await this.pool.query<{ offered: boolean }>(`select
      coalesce((payload->>'initialInputOffered')::boolean,false) as offered
      from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]
    return row?.offered === true
  }

  async turnPreparedInput(id: string, requestId: string, query: Queryable = this.pool): Promise<{
    input: AcceptedChatInput; configurationVersionId: string
  } | undefined> {
    return (await query.query<{ prepared: { input: AcceptedChatInput; configurationVersionId: string } | null }>(`
      select payload->'preparedInput' as prepared from operator_conversation_turns where conversation_id=$1 and request_id=$2`,
    [id, requestId])).rows[0]?.prepared ?? undefined
  }

  async turnInterruptTarget(id: string, requestId: string): Promise<AgentChatInterruptTarget | undefined> {
    const row = (await this.pool.query<{ request_id: string | null; native_turn_id: string | null }>(`
      select payload->>'interruptRequestId' as request_id,target_native_turn_id as native_turn_id
      from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]
    return row?.request_id ? { requestId: row.request_id, nativeTurnId: row.native_turn_id } : undefined
  }
  /** Steers never own the session. Keep their original turn identity for cold evidence-only reads. */
  async unconfirmedSteers(id: string): Promise<Array<{
    requestId: string; targetNativeTurnId: string | null; targetRequestId: string | null; delivery: 'submitting' | 'unknown'
  }>> {
    return (await this.pool.query<{ requestId: string; targetNativeTurnId: string | null; targetRequestId: string | null; delivery: 'submitting' | 'unknown' }>(`
      select s.request_id as "requestId",s.target_native_turn_id as "targetNativeTurnId",s.delivery,
        coalesce(s.payload->>'targetRequestId', (select t.request_id from operator_conversation_turns t where t.conversation_id=s.conversation_id
          and t.intent <> 'steer' and t.native_turn_id=s.target_native_turn_id order by t.turn_sequence desc limit 1)) as "targetRequestId"
      from operator_conversation_turns s where s.conversation_id=$1 and s.intent='steer'
        and s.delivery in ('submitting','unknown') order by s.turn_sequence`, [id])).rows
  }
  /** Next queued turn. Interrupt-and-send goes ahead of ordinary queued turns. */
  async nextQueued(id: string, query: Queryable = this.pool): Promise<AgentChatTurn | undefined> {
    const row = (await query.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
      where conversation_id=$1 and delivery='queued'
      order by (intent='interrupt_and_send') desc, operator_conversation_turns.turn_sequence limit 1`, [id])).rows[0]
    return row ? turn(row) : undefined
  }

  /**
   * Persist conversation (if new), user message and queued receipt in one transaction.
   * A replay of the same request ID with the same input returns the stored receipt.
   */
  async admit(input: {
    key: string; request: SendAgentChatMessageRequest; context: AgentChatContext; create?: NewAgentConversation; ownerPrincipalId?: string
    delivery: 'queued' | 'submitting'; targetNativeTurnId?: string
    prepareInput?: (row: AgentConversationRow, sql: pg.PoolClient) => Promise<{ input: AcceptedChatInput; configurationVersionId: string }>
    assertCurrent?: (transaction: pg.PoolClient) => Promise<void>
    validateInput?: (transaction: pg.PoolClient, row: AgentConversationRow) => Promise<void>
  }, supplied?: pg.PoolClient): Promise<{ conversationId: string; turn: AgentChatTurn; replayed: boolean; created: boolean; interruptTarget?: AgentChatInterruptTarget; replayWarning?: AgentChatReplayWarning }> {
    const admit = async (client: pg.PoolClient) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.context.workspaceId}`])
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${input.key}`])
      let row = await this.byKey(input.key, client)
      const hash = agentChatInputHash(input.request)
      if (row) {
        // Claim/finish/interrupt use this same lock: admission cannot retarget a later queued turn.
        row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [row.id])).rows[0]!
      }
      // Revalidate after both admission locks, before replay or any durable write.
      // The principal/delegation share locks remain held until this transaction ends.
      await input.assertCurrent?.(client)
      if (row) {
        const prior = (await client.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
          where conversation_id=$1 and request_id=$2`, [row.id, input.request.requestId])).rows[0]
        if (prior) {
          // Pre-F1 steers retained their native target, but omitted it from the hash. Only that
          // durable target can establish a legacy replay; never infer it from the current owner.
          const sameSteerTarget = input.request.intent === 'steer' && input.request.expectedNativeTurnId !== undefined
            && prior.target_native_turn_id === input.request.expectedNativeTurnId
          const legacySteerReplay = !input.request.attachments?.length && sameSteerTarget && prior.intent === 'steer'
            && prior.input_hash === agentChatInputHash({ content: input.request.content, intent: input.request.intent, context: input.request.context })
          // Unversioned urgent receipts with no retained target cannot prove the old precondition.
          // Return READBACK ONLY, explicitly marked unverifiable for every claimed target (or none).
          // Never adopt the retry's target, consult the current owner, or rewrite the legacy identity.
          const legacyUrgentReadback = !input.request.attachments?.length && prior.intent === 'interrupt_and_send' && input.request.intent === prior.intent
            && prior.target_native_turn_id === null && prior.payload.requestIdentityVersion === undefined
            && prior.input_hash === agentChatInputHash({ content: input.request.content, intent: input.request.intent, context: input.request.context })
          if (input.request.intent === 'steer' && !sameSteerTarget || prior.input_hash !== hash && !legacySteerReplay && !legacyUrgentReadback) {
            throw new DomainError('AGENT_CHAT_REQUEST_CONFLICT', 'This request ID was already used with a different message.', 409)
          }
          return { conversationId: row.id, turn: turn(prior), replayed: true, created: false,
            ...(legacyUrgentReadback ? { replayWarning: {
              code: 'AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE' as const,
              message: 'Stored receipt readback only: the original interrupt target was not recorded. The supplied target was not verified or applied; nothing was resent.',
            } } : {}) }
        }
      }
      await lockActiveWorkspace(client, input.context.workspaceId)
      if ((row?.id ?? null) !== input.request.expectedConversationId) {
        throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The conversation for this Agent changed. Reload it before sending.', 409)
      }
      if (row) {
        // The selection-key advisory lock serializes this check with every new admission.
        // Replays above do not consume capacity; reject before writing a message or receipt.
        const open = (await client.query<{ count: string }>(`select count(*)::text as count from operator_conversation_turns
          where conversation_id=$1 and intent is not null and delivery = any($2::text[])`, [row.id, OPEN_DELIVERIES])).rows[0]!
        if (Number(open.count) >= AGENT_CHAT_OPEN_TURN_LIMIT) {
          throw new DomainError('AGENT_CHAT_CAPACITY_EXCEEDED',
            'This chat has 100 unfinished messages. Wait for completion or cancel a queued message before sending another.',
            409, { limit: AGENT_CHAT_OPEN_TURN_LIMIT })
        }
      }
      // Uploads require an existing conversation. Never adopt pre-Run/other-Run files
      // while creating a new chat, even when its Agent or filename matches.
      if (!row && input.request.attachments?.length) throw new DomainError(
        'MESSAGE_ATTACHMENT_CONVERSATION_REQUIRED', 'Upload files to an existing conversation before attaching them.', 409)
      let created = false
      if (!row) {
        if (!input.create) throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The conversation for this Agent changed. Reload it before sending.', 409)
        const id = input.create.id ?? randomUUID()
        const { context, origin, workingDirectory, runtimeDirectory, directoryBinding } = input.create
        const systemPrompt = origin.kind === 'fresh'
          ? await readSystemPromptSetting(client)
          : input.create.systemPrompt
        await client.query(`insert into operator_conversations (id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
            agent_configuration_version_id,origin_run_id,origin_execution_id,harness,record)
          values ($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [id, input.key, context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId,
          input.create.agentConfigurationVersionId, origin.kind === 'run_execution' ? origin.runId : null,
          origin.kind === 'run_execution' ? origin.executionId : null, input.create.harness,
          JSON.stringify({ origin, workingDirectory, runtimeDirectory,
            ...(directoryBinding ? { directoryBinding } : {}), ...(systemPrompt ? { systemPrompt } : {}) })])
        row = (await this.get(id, client))!
        await this.acceptAccount(client, row)
        created = true
      }
      if (row.record.origin.kind === 'fresh' && !row.native_session_id && !row.record.startupDelivered
        && !row.record.sessionCreation && !row.record.systemPrompt) {
        const systemPrompt = await readSystemPromptSetting(client)
        await client.query(`update operator_conversations set record=record || jsonb_build_object('systemPrompt',$2::jsonb)
          where id=$1 and kind='agent'`, [row.id, JSON.stringify(systemPrompt)])
        row.record.systemPrompt = systemPrompt
      }
      if (input.request.intent === 'steer' && (!row.active_request_id || !input.request.expectedNativeTurnId
        || input.request.expectedNativeTurnId !== row.active_native_turn_id)) {
        throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The expected turn is not active. Send it as the next turn instead.', 409)
      }
      const interruptTarget = input.request.intent === 'interrupt_and_send' && row.active_request_id
        && (!input.request.expectedNativeTurnId || input.request.expectedNativeTurnId === row.active_native_turn_id)
        ? { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id } : undefined
      const targetNativeTurnId = input.request.intent === 'interrupt_and_send'
        ? input.request.expectedNativeTurnId ?? interruptTarget?.nativeTurnId : input.targetNativeTurnId
      await input.validateInput?.(client, row)
      await admitSessionMessage(client, row.id, input.request)
      await validateMessageAttachments(client, row.id, input.request.attachments)
      await assertAgentChatDirectoryAvailable(client, row.id)
      const preparedInput = await input.prepareInput?.(row, client)
      const now = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId: row.id, role: 'user', requestId: input.request.requestId,
        content: input.request.content, createdAt: now, updatedAt: now })
      await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,client_request_id,record)
        values ($1,$2,'user',$3,$4,$5::jsonb)`, [message.id, row.id, message.content, message.requestId, JSON.stringify(withMessageAttachmentRefs(message, input.request.attachments))])
      const inserted = (await client.query<TurnRow>(`insert into operator_conversation_turns
          (conversation_id,request_id,payload,input_hash,intent,delivery,message_id,target_native_turn_id)
        values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) returning ${TURN_COLUMNS}`,
      [row.id, input.request.requestId, JSON.stringify({ content: input.request.content, ...(input.request.sessionMode ? { sessionMode: input.request.sessionMode } : {}), requestIdentityVersion: 1,
          ...(input.ownerPrincipalId ? { ownerPrincipalId: input.ownerPrincipalId } : {}),
          ...(preparedInput ? { preparedInput } : {}),
          ...(input.request.intent === 'steer' ? { targetRequestId: row.active_request_id } : {}),
          ...(interruptTarget ? { interruptRequestId: interruptTarget.requestId } : {}) }), hash, input.request.intent,
        input.delivery, message.id, targetNativeTurnId ?? null])).rows[0]!
      // Durable cancel belongs to the pre-admission owner, not to the newly queued urgent input.
      if (interruptTarget) await this.requestCancel(row.id, interruptTarget.requestId, client)
      await this.bump(row.id, client)
      return { conversationId: row.id, turn: turn(inserted), replayed: false, created, ...(interruptTarget ? { interruptTarget } : {}) }
    }
    return supplied ? admit(supplied) : withTransaction(this.pool, admit)
  }

  /** A definitely rejected steer leaves no receipt or message behind. */
  async discard(id: string, requestId: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      // Keep the conversation → receipt lock order used by acceptance and settlement.
      await client.query(`select id from operator_conversations where id=$1 and kind='agent' for update`, [id])
      const removed = await client.query<{ message_id: string }>(`delete from operator_conversation_turns
        where conversation_id=$1 and request_id=$2 and delivery='submitting' returning message_id`, [id, requestId])
      if (removed.rows[0]) {
        await client.query('delete from operator_conversation_messages where conversation_id=$1 and id=$2', [id, removed.rows[0].message_id])
        await this.bump(id, client)
      }
    })
  }

  /** Claim the conversation for this turn. False when another turn is active or the turn left the queue. */
  async claim(id: string, requestId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id || row.record.sessionUnavailable) return false
      // A legacy orphan must be reconciled before any queued input can own this session.
      const unresolved = await client.query(`select 1 from operator_conversation_turns
        where conversation_id=$1 and intent <> 'steer' and delivery in ('submitting','accepted','unknown') limit 1`, [id])
      if (unresolved.rowCount) return false
      const claimed = await client.query(`update operator_conversation_turns set delivery='submitting',started_at=coalesce(started_at,now()),updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery='queued'`, [id, requestId])
      if (claimed.rowCount !== 1) return false
      const prepared = await this.turnPreparedInput(id, requestId, client)
      if (prepared) {
        const selected: AcceptedChatInput = row.record.startupDelivered && prepared.input.subsequent ? prepared.input.subsequent : prepared.input
        const input = omitProperties(selected, ['subsequent'])
        await client.query(`update operator_conversation_turns set payload=jsonb_set(payload,'{preparedInput}',$3::jsonb)
          where conversation_id=$1 and request_id=$2`, [id, requestId, JSON.stringify({ ...prepared, input })])
      }
      await client.query(`update operator_conversations set active_request_id=$2,active_native_turn_id=null,active_phase='accepted',
        cancel_requested=false,turn_state='starting',last_error=null,last_result=null,pending_interaction=null,
        revision=revision+1,updated_at=now() where id=$1`, [id, requestId])
      return true
    })
  }

  async beginSessionCreation(id: string, requestId: string): Promise<boolean> {
    return (await this.pool.query(`update operator_conversations
      set record=record || jsonb_build_object('sessionCreation',jsonb_build_object('requestId',$2::text)),
        revision=revision+1,updated_at=now()
      where id=$1 and kind='agent' and active_request_id=$2 and native_session_id is null
        and not (record ? 'sessionCreation')`, [id, requestId])).rowCount === 1
  }

  async applyConfiguration(id: string, requestId: string, configuration: AgentConfigurationVersion,
    options: { replaceSession: boolean; directoryBinding?: AgentChatDirectoryBinding | undefined }): Promise<AgentConversationRow> {
    return withTransaction(this.pool, async client => {
      const row = (await client.query<AgentConversationRow>(
        `select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id !== requestId || row.active_native_turn_id || row.cancel_requested) {
        throw new DomainError('AGENT_CHAT_CONFIGURATION_CONFLICT', 'The active chat turn changed before applying settings.', 409)
      }
      if (configuration.workspaceId !== row.workspace_id || configuration.agentId !== row.agent_id) {
        throw new DomainError('AGENT_CHAT_CONFIGURATION_CONFLICT', 'The configuration belongs to another Agent.', 409)
      }
      const record = { ...row.record }
      if (options.directoryBinding) record.directoryBinding = options.directoryBinding
      if (row.origin_run_id) record.sourceConfigurationVersionId ??= row.agent_configuration_version_id
      if (options.replaceSession) {
        if (row.native_session_id) record.workerGeneration = randomUUID()
        record.handoffContext = await agentConfigurationHandoff(client, id, requestId)
        record.startupDelivered = false
        delete record.startupReceipt
        delete record.sessionCreation
        delete record.nativeNonSubmission
        await client.query(`delete from provider_account_accepted_bindings where owner_kind='agent-conversation' and owner_id=$1`, [id])
      }
      const updated = (await client.query<AgentConversationRow>(`update operator_conversations
        set agent_configuration_version_id=$3,harness=$4,record=$5::jsonb,
          native_session_id=case when $6 then null else native_session_id end,
          provider_version=case when $6 then null else provider_version end,
          worker_conversation_binding=case when $6 then null else worker_conversation_binding end,
          revision=revision+1,updated_at=now()
        where id=$1 and active_request_id=$2 returning *`,
      [id, requestId, configuration.id, configuration.harness.harness, JSON.stringify(record), options.replaceSession])).rows[0]!
      if (options.replaceSession && this.accountBindings) {
        await this.accountBindings.accept(client, 'agent-conversation', id, configuration.harness,
          configuration.harnessProfileSelection)
      }
      return (await this.accountReadback(client, updated))!
    })
  }

  recordNonSubmission(id: string, requestId: string, operation: NativeNonSubmission['operation'],
    result: ExecutionResult): Promise<boolean> {
    return recordNativeNonSubmission(this.pool, id, requestId, operation, result)
  }

  async bindSession(id: string, providerVersion: string, nativeSessionId: string): Promise<void> {
    const bound = await this.pool.query(`update operator_conversations set provider_version=$2,native_session_id=$3,revision=revision+1,updated_at=now()
      where id=$1 and kind='agent' and (native_session_id is null or native_session_id=$3)`, [id, providerVersion, nativeSessionId])
    if (bound.rowCount !== 1) throw new DomainError('AGENT_CHAT_SESSION_CONFLICT', 'The native session binding changed.', 409)
  }
  async bindCreatedSession(id: string, requestId: string, configurationId: string, session: NativeSessionReference,
    unsentResult: ExecutionResult): Promise<void> {
    const nonSubmission: NativeNonSubmission = { requestId, operation: 'turn_submission',
      result: ExecutionResultSchema.parse(unsentResult) }
    if (unsentResult.outcome === 'succeeded') throw new Error('The recovered creation has no submitted prompt.')
    const bound = await this.pool.query(`update operator_conversations
      set provider_version=$4,native_session_id=$5,record=record || jsonb_build_object('nativeNonSubmission',$7::jsonb)
        || case when record->'origin'->>'kind'='run_execution' then '{"startupDelivered":true}'::jsonb else '{}'::jsonb end,
        revision=revision+1,updated_at=now()
      where id=$1 and kind='agent' and active_request_id=$2 and agent_configuration_version_id=$3
        and record->'sessionCreation'->>'requestId'=$2 and native_session_id is null and harness=$6
        and active_native_turn_id is null and (provider_version is null or provider_version=$4)`,
    [id, requestId, configurationId, session.providerVersion, session.nativeSessionId, session.harness,
      JSON.stringify(nonSubmission)])
    if (bound.rowCount !== 1) throw new DomainError('AGENT_CHAT_SESSION_CONFLICT', 'The native session creation owner changed.', 409)
  }
  async markStartupDelivered(id: string): Promise<void> {
    await this.pool.query(`update operator_conversations set record=record || '{"startupDelivered":true}'::jsonb where id=$1 and kind='agent'`, [id])
  }
  async markSessionUnavailable(id: string, reason: string, blockedReason: 'native_session_missing' | 'harness_unavailable' = 'native_session_missing'): Promise<void> {
    await this.pool.query(`update operator_conversations set record=record || jsonb_build_object('sessionUnavailable',$2::text,'sessionUnavailableReason',$3::text),
      revision=revision+1,updated_at=now() where id=$1 and kind='agent'`, [id, reason, blockedReason])
  }

  /** Provider acknowledged the turn. This is not evidence the model consumed it. */
  async acceptedMessage(id: string, requestId: string, receipt: NativeMessageSubmission): Promise<boolean> {
    if (receipt.clientCorrelationId !== agentChatCorrelation(id, requestId) || !receipt.nativeMessageId) return false
    const result = await this.pool.query(`with owned_session as materialized (
      select c.id,c.native_session_id,c.active_phase from operator_conversations c
      where c.id=$1 and c.active_request_id=$2 and c.native_session_id=$4 and c.harness='claude' and c.kind='agent' and c.deleted_at is null for update
    ), existing as (
      select c.id from owned_session c join operator_conversation_turns t on t.conversation_id=c.id
      where t.request_id=$2 and c.active_phase='submitted' and t.payload->'nativeSubmission'=$3::jsonb
    ), receipt as (
      update operator_conversation_turns t set delivery='accepted',
        payload=t.payload || jsonb_build_object('nativeSubmission',$3::jsonb),delivery_error=null,updated_at=now()
      from owned_session c where t.conversation_id=c.id and t.request_id=$2
        and (t.payload->'nativeSubmission' is null or t.payload->'nativeSubmission'=$3::jsonb)
        and t.delivery in ('submitting','unknown','accepted') and not exists (select 1 from existing)
      returning t.conversation_id
    ), updated as (
      update operator_conversations c set active_phase='submitted',
        record=c.record || jsonb_build_object('startupDelivered',true,'startupReceipt',
        coalesce(c.record->'startupReceipt',jsonb_build_object('requestId',$2::text,'nativeSessionId',c.native_session_id))),
      turn_state=case when c.cancel_requested then 'canceling' else 'active' end,revision=c.revision+1,updated_at=now()
      where c.id=$1 and c.active_request_id=$2 and exists (select 1 from receipt r where r.conversation_id=c.id)
      returning c.id
    ) select id from updated union select id from existing`,
      [id, requestId, JSON.stringify(receipt), receipt.nativeSessionId])
    return result.rowCount === 1
  }


  async accepted(id: string, requestId: string, nativeTurnId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id !== requestId) return false
      if (row.active_native_turn_id && row.active_native_turn_id !== nativeTurnId) {
        throw new DomainError('AGENT_CHAT_NATIVE_TURN_MISMATCH', 'Native evidence addressed a different turn.', 409)
      }
      const updated = await client.query(`update operator_conversation_turns set delivery='accepted',native_turn_id=$3,delivery_error=null,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','unknown')`, [id, requestId, nativeTurnId])
      if (!updated.rowCount && row.active_native_turn_id === nativeTurnId && row.record.startupDelivered
        && row.record.startupReceipt?.nativeSessionId === row.native_session_id) {
        return false
      }
      // Acceptance and startup delivery are one commit, including positive recovery evidence.
      await client.query(`update operator_conversations set active_native_turn_id=$3,active_phase='submitted',
        record=record || jsonb_build_object('startupDelivered',true,'startupReceipt',
          coalesce(record->'startupReceipt',jsonb_build_object('requestId',$2::text,'nativeSessionId',native_session_id))),
        turn_state=case when cancel_requested then 'canceling' else 'active' end,last_error=null,revision=revision+1,updated_at=now()
        where id=$1 and active_request_id=$2`, [id, requestId, nativeTurnId])
      return updated.rowCount === 1
    })
  }
  /** A steer receipt accepted into the active turn. */
  async steerAccepted(id: string, requestId: string, nativeTurnId: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      // Serialize with finish(), including when its terminal pass won before the steer ACK arrived.
      await client.query(`select id from operator_conversations where id=$1 and kind='agent' for update`, [id])
      const terminal = (await client.query<{ delivery: 'completed' | 'failed' | 'canceled' }>(`select delivery from operator_conversation_turns
        where conversation_id=$1 and native_turn_id=$2 and intent <> 'steer' and delivery in ('completed','failed','canceled')
        order by turn_sequence desc limit 1`, [id, nativeTurnId])).rows[0]
      await client.query(`update operator_conversation_turns set delivery=$4,native_turn_id=$3,delivery_error=null,updated_at=now()
        where conversation_id=$1 and request_id=$2 and intent='steer' and target_native_turn_id=$3
          and delivery in ('submitting','unknown')`, [id, requestId, nativeTurnId, terminal?.delivery ?? 'accepted'])
      await this.bump(id, client)
    })
  }
  /** Accepted steers settle with their target. Unconfirmed steers require ACK/history evidence first;
   * steerAccepted reads the target's durable receipt even after restart or a subsequent turn. */
  async settleSteers(id: string, nativeTurnId: string, delivery: 'completed' | 'failed' | 'canceled', query: Queryable = this.pool): Promise<void> {
    await query.query(`update operator_conversation_turns set delivery=$3,updated_at=now()
      where conversation_id=$1 and intent='steer' and native_turn_id=$2 and delivery='accepted'`, [id, nativeTurnId, delivery])
  }

  async pending(id: string, requestId: string | null, pending: PendingNativeInteraction | undefined): Promise<void> {
    await this.pool.query(`update operator_conversations set pending_interaction=$3::jsonb,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id is not distinct from $2 and pending_interaction is distinct from $3::jsonb`,
    [id, requestId, pending ? JSON.stringify(PendingNativeInteractionSchema.parse(pending)) : null])
  }
  async requestCancel(id: string, requestId: string, query: Queryable = this.pool): Promise<boolean> {
    return (await query.query(`update operator_conversations set cancel_requested=true,turn_state='canceling',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2`, [id, requestId])).rowCount === 1
  }

  /** Plain Stop linearizes its expected-turn check, queue cancellation and active cancel intent. */
  async interrupt(id: string, expectedNativeTurnId?: string, scope: 'active_turn' | 'active_and_queued' = 'active_and_queued'): Promise<AgentChatInterruptTarget | undefined> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      if (expectedNativeTurnId && row.active_native_turn_id !== expectedNativeTurnId) {
        throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'That turn already finished.', 409)
      }
      const target = row.active_request_id ? { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id } : undefined
      if (scope === 'active_and_queued') await this.cancelQueued(id, undefined, client)
      if (target) await this.requestCancel(id, target.requestId, client)
      return target
    })
  }

  /** Terminal settlement of the active turn; clears the conversation's active identity. */
  async finish(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, rejectedSessionCreation = false): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const row = (await client.query<AgentConversationRow>(`select * from operator_conversations where id=$1 and kind='agent' for update`, [id])).rows[0]
      if (!row || row.active_request_id !== requestId) return false
      if (rejectedSessionCreation) {
        // A negative creation result only retires ITS unbound marker, never a later owner/binding.
        if (row.native_session_id || row.active_native_turn_id || row.record.sessionUnavailable
          || row.record.sessionCreation?.requestId !== requestId || result.outcome === 'succeeded') {
          return false
        }
        const retired = await client.query(`update operator_conversations set record=record - 'sessionCreation'
          where id=$1 and kind='agent' and active_request_id=$2 and native_session_id is null
            and record->'sessionCreation'->>'requestId'=$2`, [id, requestId])
        if (retired.rowCount !== 1) return false
        if (row.cancel_requested) result = { outcome: 'canceled' }
      }
      const delivery = result.outcome === 'succeeded' ? 'completed' : result.outcome
      // Cold Codex history has a terminal answer/identity without an item.completed event.
      // Persist it in the settlement transaction, deduplicating native messages and blocks.
      if (result.outcome === 'succeeded' && nativeMessageId) {
        const output = result.output
        const content = typeof output === 'string' ? output : output && typeof output === 'object' && !Array.isArray(output)
          ? typeof output.text === 'string' ? output.text : typeof output.content === 'string' ? output.content : undefined : undefined
        const prior = await client.query(`select 1 from operator_conversation_messages
          where conversation_id=$1 and (native_message_id=$2 or
            (record->>'nativeParentMessageId'=$2 and record->>'requestId'=$3)) limit 1`, [id, nativeMessageId, requestId])
        if (content !== undefined && !prior.rowCount) {
          const activity = await client.query<{ sequence: string }>(
            'select coalesce(max(sequence),0)::text as sequence from operator_conversation_activity where conversation_id=$1 and request_id=$2', [id, requestId])
          const now = new Date().toISOString()
          const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'assistant', requestId, content,
            nativeMessageId, nativeMessageComplete: true, afterActivitySequence: activity.rows[0]!.sequence, createdAt: now, updatedAt: now })
          await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,native_message_id,record)
            values ($1,$2,'assistant',$3,$4,$5::jsonb)`, [message.id, id, content, nativeMessageId, JSON.stringify(message)])
        }
      }
      await client.query(`update operator_conversation_turns set delivery=$3,delivery_error=$4::jsonb,result=$5::jsonb,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','accepted','unknown')`,
      [id, requestId, delivery, result.error ? JSON.stringify({ code: result.error.code, message: result.error.message }) : null,
        JSON.stringify(ExecutionResultSchema.parse(result))])
      if (row.active_native_turn_id) await this.settleSteers(id, row.active_native_turn_id, delivery, client)
      await client.query(`update operator_conversation_activity set revision=revision+1,
        record=jsonb_set(record,'{status}',to_jsonb(case when record->>'kind'='thinking' then case when $3 then 'canceled' else 'completed' end else 'unknown' end::text))
        where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')`, [id, requestId, result.outcome === 'canceled'])
      await client.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null,active_phase=null,
        record=record - 'nativeNonSubmission',cancel_requested=false,pending_interaction=null,
        turn_state=$2,last_error=$3,last_result=$4::jsonb,revision=revision+1,updated_at=now()
        where id=$1`, [id, result.outcome === 'failed' ? 'error' : 'idle', result.error?.message ?? null, JSON.stringify(result)])
      await this.settledProjection?.(client, { row, requestId, result, ...(nativeMessageId ? { nativeMessageId } : {}) })
      return true
    })
  }

  /** Acceptance or settlement cannot be proven. The receipt is kept and never resubmitted automatically. */
  async unknown(id: string, requestId: string, message: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      // Match accepted()/finish(): never hold a receipt lock while waiting for its conversation.
      await client.query(`select id from operator_conversations where id=$1 and kind='agent' for update`, [id])
      const receipt = await client.query(`update operator_conversation_turns set delivery='unknown',delivery_error=$3::jsonb,updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery in ('submitting','accepted')`,
      [id, requestId, JSON.stringify({ code: 'DELIVERY_UNCONFIRMED', message })])
      // Uncertainty ends the claim that a public activity is still running, not native ownership.
      await client.query(`update operator_conversation_activity set revision=revision+1,
        record=jsonb_set(record,'{status}','"unknown"'::jsonb)
        where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')
          and exists (select 1 from operator_conversation_turns t where t.conversation_id=$1
            and t.request_id=$2 and t.delivery='unknown')`, [id, requestId])
      const owner = await client.query(`update operator_conversations set turn_state='uncertain',last_error=$3,revision=revision+1,updated_at=now()
        where id=$1 and active_request_id=$2`, [id, requestId, message])
      if (receipt.rowCount && !owner.rowCount) await this.bump(id, client) // A steer changes readback, not active ownership.
    })
  }

  /** Missing evidence never releases ownership, cancellation or pending native interactions. */
  async abandon(id: string, requestId: string, message: string): Promise<void> {
    await this.unknown(id, requestId, message)
  }

  async cancelQueued(id: string, requestId?: string, query: Queryable = this.pool): Promise<number> {
    const result = await query.query(`update operator_conversation_turns set delivery='canceled',updated_at=now()
      where conversation_id=$1 and delivery='queued' and ($2::text is null or request_id=$2)`, [id, requestId ?? null])
    if (result.rowCount) await this.bump(id, query)
    return result.rowCount ?? 0
  }

  async state(id: string, options: { recoverOverflow?: boolean } = {}): Promise<{
    fileSourceRevisions?: ActivitySourceRevision[]; commandActivity?: Awaited<ReturnType<typeof readActivityCommands>>; publicationReceipts?: ConversationPublicationReceipt[]; row: AgentConversationRow; turns: AgentChatTurn[]; messages: Message[]; hasEarlierMessages: boolean; hasMoreTurns?: true; selection: { workflowVersionId: string; attemptKey: string } | null; latestRequestId: string | null; activeStartedAt: Date | null; unfinishedActivities: Awaited<ReturnType<PostgresOperatorActivityRepository['unfinished']>>['activities']; hasMoreActivities?: true; activityPage: Awaited<ReturnType<PostgresOperatorActivityRepository['page']>> & { itemProvenance?: Record<string, unknown> }
  } | undefined> {
    return withTransaction(this.pool, async (client) => {
      const row = await this.get(id, client)
      if (!row) return undefined
      // Open receipts have priority over recent terminal history, in one SQL snapshot.
      // Fetch one extra open receipt to detect overflow before selecting an explicit recovery window.
      const receiptRows = (await client.query<TurnRow>(`with open as (
          select ${TURN_COLUMNS} from operator_conversation_turns where conversation_id=$1 and intent is not null
            and delivery = any($2::text[]) order by operator_conversation_turns.turn_sequence limit $3::int + 1
        ), recent as (
          select ${TURN_COLUMNS} from operator_conversation_turns where conversation_id=$1 and intent is not null
            and not (delivery = any($2::text[])) order by operator_conversation_turns.turn_sequence desc
            limit least(50, greatest(0, $3::int - (select count(*) from open)))
        ) select * from (select * from open union all select * from recent) visible order by turn_sequence::bigint`,
      [id, OPEN_DELIVERIES, AGENT_CHAT_OPEN_TURN_LIMIT])).rows
      const overflow = receiptRows.length > AGENT_CHAT_OPEN_TURN_LIMIT
      if (overflow && !options.recoverOverflow) {
        throw new DomainError('AGENT_CHAT_RECEIPT_OVERFLOW',
          'This chat exceeds the unfinished-message limit. Settle unfinished turns or cancel queued messages before reading state.',
          409, { limit: AGENT_CHAT_OPEN_TURN_LIMIT })
      }
      const turns = receiptRows.slice(0, AGENT_CHAT_OPEN_TURN_LIMIT).map(turn)
      if (overflow) {
        // Make cleanup reachable even when the oldest 100 receipts are all unconfirmed.
        // Reads never cancel, delete, or settle anything; the omitted receipts remain pageable.
        const queued = await this.nextQueued(id, client)
        if (queued && !turns.some((entry) => entry.requestId === queued.requestId)) {
          turns[turns.length - 1] = queued
          turns.sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
        }
      }
      // Keep the newest contiguous window within the same byte budget as Operator
      // chat. Oversized/older messages are retained in storage and paged over HTTP/MCP.
      const recent = (await client.query<{ messages: unknown[]; has_earlier: boolean }>(`with candidates as (
        select m.*,row_number() over (order by m.sequence desc) as ordinal,
          sum(octet_length(m.record::text)) over (order by m.sequence desc) as bytes
        from (select record || jsonb_build_object('revision',activity_record_revision::text,'sequence',sequence::text) as record,sequence from operator_conversation_messages
          where conversation_id=$1 order by sequence desc limit ($2::integer+1)) m
      ), selected as (select * from candidates where ordinal<=$2 and (bytes<=$3 or ordinal=1))
      select coalesce((select jsonb_agg(record order by sequence) from selected),'[]'::jsonb) as messages,
        (select count(*) from candidates)>(select count(*) from selected) as has_earlier`,
      [id, AGENT_CHAT_MESSAGE_LIMIT, OPERATOR_SNAPSHOT_MESSAGE_BYTES])).rows[0]!
      const fileSourceRevisions: ActivitySourceRevision[] = []
      const messages = boundedConversationMessages(await hydrateMessageAttachments(client, id, recent.messages,
        (source) => fileSourceRevisions.push(source)), OPERATOR_SNAPSHOT_MESSAGE_BYTES)
      const publicationReceipts = await readConversationPublicationReceipts(client, id, messages.filter((message) => message.role === 'user').map((message) => message.id))
      const activity = new PostgresOperatorActivityRepository(this.pool)
      const activityPage = await activity.snapshotPage(id, { limit: 100 }, client)
      const unfinished = await activity.unfinished(id, client)
      const ownership = (await client.query<{ started_at: Date | null; latest_request_id: string | null }>(`select
        (select started_at from operator_conversation_turns where conversation_id=$1 and request_id=$2) as started_at,
        (select request_id from operator_conversation_turns where conversation_id=$1 and intent is not null order by turn_sequence desc limit 1) as latest_request_id`,
      [id, row.active_request_id])).rows[0]!
      const selection = row.origin_run_id && row.origin_execution_id
        ? (await client.query<{ workflowVersionId: string; attemptKey: string }>(`select r.workflow_version_id as "workflowVersionId", e.attempt::text as "attemptKey"
            from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`, [row.origin_run_id, row.origin_execution_id])).rows[0] ?? null : null
      const loaded = { fileSourceRevisions, publicationReceipts, row, turns, messages, activityPage, unfinishedActivities: unfinished.activities, selection, activeStartedAt: ownership.started_at, latestRequestId: ownership.latest_request_id, hasEarlierMessages: recent.has_earlier || messages.length < recent.messages.length,
        ...(overflow ? { hasMoreTurns: true as const } : {}),
        ...(unfinished.hasMore ? { hasMoreActivities: true as const } : {}) }
      const commandActivity = await readActivityCommands(client, id, agentActivityScope(loaded), String(row.revision))
      return { ...loaded, commandActivity }
    }, { isolation: 'repeatable read', readOnly: true })
  }
  async receipts(id: string, before: string | undefined, limit: number, query: Queryable = this.pool): Promise<{ turns: AgentChatTurn[]; nextCursor: string | null }> {
    if (query === this.pool && before !== undefined) return withConversationPageRead(this.pool, (sql) => this.receipts(id, before, limit, sql))
    await assertConversationCursor(query, id, before, 'turns')
    const rows = (await query.query<TurnRow>(`select ${TURN_COLUMNS} from operator_conversation_turns
      where conversation_id=$1 and intent is not null and ($2::bigint is null or turn_sequence<$2::bigint)
      order by operator_conversation_turns.turn_sequence desc limit ($3::integer+1)`, [id, before ?? null, limit])).rows
    const selected = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? selected[selected.length - 1]!.turn_sequence : null
    return { turns: selected.reverse().map(turn), nextCursor }
  }
  async history(id: string, before: string | undefined, limit: number, query: Queryable = this.pool): Promise<{ messages: Message[]; nextCursor: string | null }> {
    if (query === this.pool) return withConversationPageRead(this.pool, (sql) => this.history(id, before, limit, sql))
    await assertConversationCursor(query, id, before, 'messages')
    const page = (await query.query<{ messages: unknown[]; next_cursor: string | null }>(`with candidates as (
      select m.*,row_number() over (order by m.sequence desc) as ordinal,
        sum(octet_length(m.record::text)) over (order by m.sequence desc) as bytes
      from (select record || jsonb_build_object('revision',activity_record_revision::text,'sequence',sequence::text) as record,sequence from operator_conversation_messages
        where conversation_id=$1 and ($2::bigint is null or sequence<$2::bigint)
        order by sequence desc limit ($3::integer+1)) m
    ), selected as (select * from candidates where ordinal<=$3 and (bytes<=$4 or ordinal=1))
    select coalesce((select jsonb_agg(record order by sequence) from selected),'[]'::jsonb) as messages,
      case when exists(select 1 from candidates where sequence<(select min(sequence) from selected))
        then (select min(sequence)::text from selected) else null end as next_cursor`,
    [id, before ?? null, limit, OPERATOR_HISTORY_PAGE_BYTES])).rows[0]!
    // One oversized message is allowed over HTTP/MCP readback, ensuring cursor progress
    // without truncating native content or putting it back in a live snapshot.
    return { messages: await hydrateMessageAttachments(query, id, page.messages), nextCursor: page.next_cursor }
  }

  private async bump(id: string, query: Queryable = this.pool): Promise<void> {
    await query.query('update operator_conversations set revision=revision+1,updated_at=now() where id=$1', [id])
  }
}
