import { matchingChatResponseAcknowledgment, AcceptedChatResponseControlSchema } from '@foreman-code/contracts/interaction-activity'
import type pg from 'pg'
import { DurableInteractionSchema, PendingNativeInteractionSchema, type ApprovalResponseOption, type NativeSessionReference } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorAuthority } from '../../access/runAuthority.js'
import { requireAuthorization } from '../../access/policy.js'
import { credentialAuthority } from '../../interactions/wave25/credentialAuthority.js'
import type { RunOwnership } from '../../runs/ownership.js'
import type { PostgresOperatorConversationRepository } from '../../conversations/operatorChatRepository.js'
import type { PostgresAgentChatRepository } from '../../conversations/agentChatRepository.js'
import { DomainError } from '../../errors.js'
import { PostgresClaudeCallbackJournal } from './callbackJournal.js'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity, type ClaudeInteractionAnswer, type ClaudeInteractionAuthority } from './interactions.js'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'

export type ClaudeDomainBinding =
  | { kind: 'workflow'; runId: string; executionId: string; attempt: number; getOwner(): RunOwnership | undefined }
  | { kind: 'operator'; conversationId: string; controlPrincipalId?: string; observationPrincipalId?: string; repository: Pick<PostgresOperatorConversationRepository, 'pending'> }
  | { kind: 'agent'; conversationId: string; workspaceId: string; controlPrincipalId?: string; observationPrincipalId?: string; repository: Pick<PostgresAgentChatRepository, 'pending'> }
export interface ClaudeCurrentCallbackOwner {
  nativeCallbackContext(sessionId: string, toolUseId: string): { nativeSessionId: string; nativeMessageId: string; clientCorrelationId: string; generation: string } | undefined
}
type Database = Pick<pg.Pool, 'query'>
interface ChatRow {
  kind: 'operator' | 'agent'; owner_principal_id: string | null; sender_id: string | null
  workspace_id: string | null; workflow_id: string | null; origin_run_id: string | null
  active_request_id: string | null; native_session_id: string | null; provider_version: string | null
  cancel_requested: boolean; deleted_at: Date | null; record: { status?: string }
  payload: { nativeSubmission?: { kind: string; nativeSessionId: string; nativeMessageId: string; clientCorrelationId: string }; ownerPrincipalId?: string }
  pending_interaction: unknown; response_delivery: string | null
}
function denied(code = 'CLAUDE_CALLBACK_SCOPE_DENIED'): never { throw new DomainError(code, 'The current admitted callback, owner or response claim no longer matches.', 409) }

/** Concrete reads of existing admissions and response receipts. No credential issuer or second request store. */
export class PostgresClaudeInteractionAuthority implements ClaudeInteractionAuthority {
  private bridge: ClaudeInteractionBridge | undefined
  readonly callbackJournal: PostgresClaudeCallbackJournal
  constructor(private readonly database: Database, readonly binding: ClaudeDomainBinding,
    private readonly manager: ClaudeCurrentCallbackOwner) {
    const owner = binding.kind === 'workflow' ? `execution:${binding.executionId}:${binding.attempt}`
      : `${binding.kind}:${binding.conversationId}`
    this.callbackJournal = new PostgresClaudeCallbackJournal(database, owner)
  }
  bind(bridge: ClaudeInteractionBridge): void { if (this.bridge) denied(); this.bridge = bridge }

  /** HRT calls this on the admitted turn/technical attempt before constructing SDK callbacks. */
  async callbackAdmission(): Promise<{ ownerPrincipalId: string; attemptId: string }> {
    if (this.binding.kind === 'workflow') {
      const owner = this.binding.getOwner()
      if (!owner || owner.runId !== this.binding.runId) denied()
      owner.assertOwned()
      await owner.readOneShotFence(owner.client)
      const admission = await this.workflowAdmission(owner.client)
      owner.assertOwned()
      return admission
    }
    const row = await this.chat()
    const ownerPrincipalId = this.binding.kind === 'operator' ? row.owner_principal_id : row.payload.ownerPrincipalId
    if (!ownerPrincipalId) denied()
    await this.chatPrincipal(ownerPrincipalId, row, 'write')
    return { ownerPrincipalId, attemptId: row.active_request_id! }
  }

  async profileAdmission(): Promise<void> {
    if (this.binding.kind === 'workflow') { await this.callbackAdmission(); return }
    const row = (await this.database.query<ChatRow>(
      'select * from operator_conversations where id=$1', [this.binding.conversationId])).rows[0]
    if (!row || row.kind !== this.binding.kind || row.deleted_at
      || row.cancel_requested && !this.binding.observationPrincipalId || row.record.status === 'archived'
      || this.binding.kind === 'agent' && row.workspace_id !== this.binding.workspaceId) denied()
    if (this.binding.observationPrincipalId) {
      const caller = this.binding.observationPrincipalId
      if (this.binding.kind === 'operator' && row.owner_principal_id !== caller) denied()
      await this.chatPrincipal(caller, row, 'read')
      return
    }
    if (row.active_request_id) { await this.callbackAdmission(); return }
    const caller = this.binding.controlPrincipalId
    if (!caller || this.binding.kind === 'operator' && row.owner_principal_id !== caller) denied()
    await this.chatPrincipal(caller, row, 'write')
  }

  async callbackAdmissionIfActive() {
    if (this.binding.kind === 'workflow') return this.callbackAdmission()
    const row = (await this.database.query<{ active_request_id: string | null }>(
      'select active_request_id from operator_conversations where id=$1', [this.binding.conversationId])).rows[0]
    return row?.active_request_id ? this.callbackAdmission() : undefined
  }

  private async workflowAdmission(database: Database): Promise<{ ownerPrincipalId: string; attemptId: string }> {
    if (this.binding.kind !== 'workflow') return denied()
    const current = await credentialAuthority(database, this.binding.executionId, 'workflow')
    if (current.run.id !== this.binding.runId || current.execution.attempt !== this.binding.attempt) denied()
    const row = (await database.query<{ principal_id: string }>("select record->>'authorizationPrincipalId' as principal_id from runs where id=$1", [this.binding.runId])).rows[0]
    if (!row?.principal_id) denied()
    const principal = (await currentOperatorAuthority(database, row.principal_id)).principal
    requireAuthorization(principal, 'runs:start', { workspaceId: current.run.workspaceId, workflowId: current.run.workflowId })
    return { ownerPrincipalId: row.principal_id, attemptId: String(current.execution.attempt) }
  }
  private async chat(expectedRequestId?: string): Promise<ChatRow> {
    if (this.binding.kind === 'workflow') return denied()
    const row = (await this.database.query<ChatRow>(`select c.*,t.payload,t.payload->>'ownerPrincipalId' as sender_id
      from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      where c.id=$1 and ($2::text is null or c.active_request_id=$2)`, [this.binding.conversationId, expectedRequestId ?? null])).rows[0]
    if (!row || row.kind !== this.binding.kind || !row.active_request_id || expectedRequestId !== undefined && row.active_request_id !== expectedRequestId || row.cancel_requested
      || row.deleted_at || row.record.status === 'archived' || this.binding.kind === 'agent' && row.workspace_id !== this.binding.workspaceId) denied()
    return row
  }
  private async chatPrincipal(id: string, row: ChatRow, action: 'read' | 'write' | 'respond'): Promise<ManagementPrincipal> {
    const principal = (await currentOperatorAuthority(this.database, id)).principal
    if (this.binding.kind === 'workflow') return denied()
    const scope = this.binding.kind === 'agent' ? { workspaceId: row.workspace_id!, workflowId: row.workflow_id!, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) } : {}
    requireAuthorization(principal, this.binding.kind === 'agent' ? 'agent_chat:read' : 'operator_chat:read', scope)
    if (action === 'read') return principal
    requireAuthorization(principal, this.binding.kind === 'agent' ? action === 'write' ? 'agent_chat:write' : 'agent_chat:respond' : action === 'write' ? 'operator_chat:write' : 'operator_chat:respond', scope)
    return principal
  }
  async validate(identity: ClaudeCallbackIdentity): Promise<void> {
    const admission = this.binding.kind === 'workflow' ? await this.workflowAdmission(this.database) : await this.callbackAdmission()
    if (identity.ownerPrincipalId !== admission.ownerPrincipalId || identity.attemptId !== admission.attemptId || identity.agentId || identity.parentToolUseId) denied()
    const actual = this.manager.nativeCallbackContext(identity.nativeSessionId, identity.toolUseId)
    if (!actual || actual.nativeMessageId !== identity.nativeMessageId || actual.generation !== identity.generation
      || actual.nativeSessionId !== identity.nativeSessionId || actual.clientCorrelationId !== identity.clientCorrelationId) denied()
    if (this.binding.kind === 'workflow') {
      const current = await credentialAuthority(this.database, this.binding.executionId, 'workflow')
      if (current.nativeSessionId !== identity.nativeSessionId || actual.clientCorrelationId !== `execution:${this.binding.executionId}`) denied()
    } else {
      const row = await this.chat(identity.attemptId), receipt = row.payload.nativeSubmission
      if (!receipt || receipt.kind !== 'message' || row.native_session_id !== identity.nativeSessionId
        || receipt.nativeSessionId !== identity.nativeSessionId || receipt.nativeMessageId !== identity.nativeMessageId
        || receipt.clientCorrelationId !== actual.clientCorrelationId) denied('CLAUDE_NATIVE_MESSAGE_NOT_ADMITTED')
    }
  }
  async deliveryPersisted(identity: ClaudeCallbackIdentity, optionId: string): Promise<boolean> {
    if (this.binding.kind === 'workflow') {
      const rows = (await this.database.query<{ record: unknown }>(`select record from durable_interactions
        where execution_id=$1 and native_session_id=$2 and native_request_id=$3 and record->>'deliveryState'='delivered'`,
      [this.binding.executionId, identity.nativeSessionId, identity.nativeRequestId])).rows
      return rows.some(row => {
        const parsed = DurableInteractionSchema.safeParse(row.record)
        if (!parsed.success) return false
        const interaction = parsed.data
        const request = interaction.request as Record<string, unknown>
        return interaction.selectedOptionId === optionId && request.nativeMessageId === identity.nativeMessageId
          && request.generation === identity.generation && request.toolUseId === identity.toolUseId
      })
    }
    const rows = (await this.database.query<{ result: { acceptedControl?: unknown; providerAcknowledgment?: unknown } }>(`
      select result from management_command_receipts where operation=$1 and target_key=$2
        and result#>>'{acceptedControl,modelRequestId}'=$3
        and result#>>'{acceptedControl,native,requestId}'=$4`,
    [this.binding.kind === 'operator' ? 'operator_chat_control' : 'agent_chat_control',
      this.binding.conversationId, identity.attemptId, identity.nativeRequestId])).rows
    return rows.some(row => {
      const parsed = AcceptedChatResponseControlSchema.safeParse(row.result.acceptedControl)
      if (!parsed.success) return false
      const control = parsed.data
      return control.native.sessionId === identity.nativeSessionId && control.native.messageId === identity.nativeMessageId
        && control.native.generation === identity.generation && control.choice.optionId === optionId
        && Boolean(matchingChatResponseAcknowledgment(control, row.result.providerAcknowledgment))
    })
  }
  async messageSubmitted(correlationId: string): Promise<boolean> {
    if (this.binding.kind === 'workflow') return false
    return (await this.database.query(`select 1 from operator_conversation_turns
      where conversation_id=$1 and payload#>>'{nativeSubmission,clientCorrelationId}'=$2 limit 1`,
    [this.binding.conversationId, correlationId])).rowCount === 1
  }
  async request(identity: ClaudeCallbackIdentity, toolName: string, _input: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeInteractionAnswer> {
    await this.validate(identity)
    signal.throwIfAborted()
    if (toolName === 'AskUserQuestion') return { outcome: 'deny', reason: 'Structured native question answers are not supported by the current persisted response contract.' }
    if (!this.bridge) denied()
    // Workflow requests are published ONLY by the owned history observer/original-source update.
    if (this.binding.kind !== 'workflow') {
      const row = await this.chat(identity.attemptId)
      if (!row.provider_version) denied()
      const pending = this.bridge.pendingInteractions({ harness: 'claude', nativeSessionId: identity.nativeSessionId,
        providerVersion: row.provider_version }).find(item => item.turn.nativeRequestId === identity.nativeRequestId)
      if (!pending) denied()
      await this.publishPending(identity, pending)
    }
    return this.bridge.waitForResponse(identity)
  }
  /** The paired worker retains the SDK callback; Main publishes its existing conversation interaction. */
  async publishPending(identity: ClaudeCallbackIdentity, raw: unknown): Promise<void> {
    await this.validate(identity)
    if (this.binding.kind === 'workflow') denied()
    const pending = PendingNativeInteractionSchema.parse(raw)
    const row = await this.chat(identity.attemptId)
    const request = pending.request as Record<string, unknown>
    if (!identity.nativeRequestId || pending.session.harness !== 'claude'
      || pending.session.nativeSessionId !== identity.nativeSessionId || pending.session.providerVersion !== row.provider_version
      || pending.turn.nativeRequestId !== identity.nativeRequestId || pending.nativeRequestType !== identity.nativeRequestType
      || request.toolUseId !== identity.toolUseId || request.generation !== identity.generation
      || request.nativeMessageId !== identity.nativeMessageId || request.attemptId !== identity.attemptId) denied()
    await this.binding.repository.pending(this.binding.conversationId, identity.attemptId, pending)
  }
  async validateResponse(identity: ClaudeCallbackIdentity, answer: ClaudeInteractionAnswer): Promise<void> {
    await this.validate(identity)
    const optionId = answer.outcome
    if (!['allow_once', 'deny', 'cancel'].includes(optionId)) denied('CLAUDE_RESPONSE_CONTRACT_UNSUPPORTED')
    if (this.binding.kind === 'workflow') {
      const row = (await this.database.query<{ record: unknown; claimed: boolean }>(`select d.record,exists(select 1 from interaction_delivery_attempts a
          where a.interaction_id=d.id and a.state='submitted' and a.lease_owner=d.delivery_owner
            and a.delivery_fence=d.delivery_fence and a.lease_expires_at>clock_timestamp()
            and d.delivery_lease_expires_at>clock_timestamp()) as claimed from durable_interactions d
        where d.execution_id=$1 and d.harness='claude' and d.native_session_id=$2 and d.native_request_id=$3`,
      [this.binding.executionId, identity.nativeSessionId, identity.nativeRequestId])).rows[0]
      if (!row) denied('APPROVAL_ORIGINAL_SOURCE_REQUIRED')
      const interaction = DurableInteractionSchema.parse(row.record)
      const metadata = interaction.request as Record<string, unknown>
      if (!row.claimed || interaction.executionId !== this.binding.executionId || interaction.runId !== this.binding.runId
        || interaction.harness !== 'claude' || interaction.nativeSessionId !== identity.nativeSessionId || interaction.nativeRequestId !== identity.nativeRequestId
        || interaction.selectedSemantic !== (optionId === 'allow_once' ? 'approve_once' : optionId === 'deny' ? 'reject' : 'cancel') || interaction.nativeRequestType !== identity.nativeRequestType
        || interaction.selectedOptionId !== optionId || interaction.status !== 'delivery_pending'
        || metadata.generation !== identity.generation || metadata.toolUseId !== identity.toolUseId || metadata.nativeMessageId !== identity.nativeMessageId) denied()
      return
    }
    const row = await this.chat(identity.attemptId), pending = PendingNativeInteractionSchema.parse(row.pending_interaction)
    if (pending.session.nativeSessionId !== identity.nativeSessionId || pending.turn.nativeRequestId !== identity.nativeRequestId
      || (pending.request as Record<string, unknown>).generation !== identity.generation
      || this.binding.kind === 'operator' && row.response_delivery !== 'submitted') denied()
    const receipt = (await this.database.query<{ principal_id: string; result: { acceptedControl: { modelRequestId: string; conversationId: string; scope: { kind: string; conversationId: string; workspaceId?: string; workflowId?: string }; native: { harness: string; providerVersion?: string; sessionId: string; messageId?: string; generation?: string; requestId: string; requestType: string }; choice: { optionId: string; semantic: string } } } }>(`select principal_id,result from management_command_receipts
      where operation=$1 and target_key=$2 and result->>'status'='pending'
        and result->'acceptedControl'->>'modelRequestId'=$3
        and result->'acceptedControl'->'native'->>'requestId'=$4
        and result->'acceptedControl'->'choice'->>'optionId'=$5`,
    [this.binding.kind === 'operator' ? 'operator_chat_control' : 'agent_chat_control', this.binding.conversationId, identity.attemptId, identity.nativeRequestId, optionId])).rows
    if (receipt.length !== 1) denied('CLAUDE_RESPONSE_CLAIM_REQUIRED')
    const control = receipt[0]!.result.acceptedControl
    if (control.choice.semantic !== (optionId === 'allow_once' ? 'approve_once' : optionId === 'deny' ? 'reject' : 'cancel')
      || control.conversationId !== this.binding.conversationId || control.scope.conversationId !== this.binding.conversationId
      || control.native.harness !== 'claude' || control.native.providerVersion !== row.provider_version
      || (this.binding.kind === 'operator' ? control.scope.kind !== 'operator_chat' : !['agent_chat', 'selected_run_chat'].includes(control.scope.kind)
        || control.scope.workspaceId !== row.workspace_id || control.scope.workflowId !== row.workflow_id)
      || control.native.sessionId !== identity.nativeSessionId || control.native.messageId !== identity.nativeMessageId
      || control.native.generation !== identity.generation || control.native.requestType !== identity.nativeRequestType
      || !pending.responseOptions.some((option) => option.optionId === optionId && option.semantic === (optionId === 'allow_once' ? 'approve_once' : optionId === 'deny' ? 'reject' : 'cancel'))) denied()
    await this.chatPrincipal(receipt[0]!.principal_id, row, 'respond')
  }
}

/** Actual concrete authority + the ONE SDK callback map; history publication stays in existing owners. */
export function createPostgresClaudeInteractionBridge(input: {
  database: Database; binding: ClaudeDomainBinding; manager: ClaudeCurrentCallbackOwner; configuration: ClaudeHarnessConfiguration
}) {
  const authority = new PostgresClaudeInteractionAuthority(input.database, input.binding, input.manager)
  const bridge = new ClaudeInteractionBridge(input.configuration, authority)
  authority.bind(bridge)
  return { authority, bridge, callbackAdmission: () => authority.callbackAdmission(),
    callbackAdmissionIfActive: () => authority.callbackAdmissionIfActive(),
    interactionPort: {
      async pending(session: NativeSessionReference, signal?: AbortSignal) { signal?.throwIfAborted(); return bridge.pendingInteractions(session)[0] },
      respond: (session: NativeSessionReference, requestId: string, option: ApprovalResponseOption, signal?: AbortSignal) => bridge.respond(session, requestId, option, signal),
      async reconcileResponse(session: NativeSessionReference, response: { nativeRequestId: string; option: ApprovalResponseOption }, signal?: AbortSignal) {
        const observation = await bridge.observeResponse(session, response.nativeRequestId, response.option, signal)
        return { events: [], pendingInteractions: bridge.pendingInteractions(session), interactionDeliveries: [observation],
          responseDeliveries: (await bridge.deliveryEvidence(session)).filter(proof => proof.nativeRequestId === response.nativeRequestId) }
      },
      stopAutomaticResponses() { bridge.close() },
    } }
}
