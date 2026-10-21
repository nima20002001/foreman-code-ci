import assert from 'node:assert/strict'
import type pg from 'pg'
import type { AgentChatContext, AgentChatTurn, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { AgentConfigurationVersion, AgentHarness, ExecutionResult, Message, NativeSessionReference, SessionControlState, SessionMode } from '@foreman-code/contracts'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { qualifiedAgentChatSteer } from '../../src/modules/conversations/chatSteerQualification.js'
import { agentChatKey, type AgentConversationRow, PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import type { OperatorActivityChange } from '../../src/modules/conversations/operatorActivity.js'
import type { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { NativeTurnNotActiveError } from '../../src/modules/harnesses/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSteerInput, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import type { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { chatWorkflowVersionRow, isCurrentVersionRead } from './chatWorkflowVersion.js'
import { deferred } from './deferred.js'

export async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise<void>((done) => setImmediate(done))
  }
  assert.fail('The gated lifecycle transition did not occur.')
}

export const context: AgentChatContext = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const configuration: AgentConfigurationVersion = {
  id: 'configuration', workspaceId: context.workspaceId, agentId: context.agentId, version: 1,
  prompt: {}, assignedSkills: [], contentHash: 'fixture', createdAt: new Date().toISOString(),
  harness: { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
}
const principal: ManagementPrincipal = {
  id: 'caller', name: 'F1 unit-test caller', audience: 'operator', revokedAt: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  grants: [{ scope: { workspaceIds: [context.workspaceId], workflowIds: [context.workflowId] },
    actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'] }],
}
interface Receipt {
  request_id: string; turn_sequence: string; intent: AgentChatTurn['intent']; delivery: AgentChatTurn['delivery']
  message_id: string; native_turn_id: string | null; target_native_turn_id: string | null
  delivery_error: { code: string; message: string } | null; input_hash: string
  payload: { content: string; sessionMode?: SessionMode; interruptRequestId?: string; ownerPrincipalId?: string; nativeSubmission?: { kind: string; nativeSessionId: string; nativeMessageId: string; clientCorrelationId: string } }; result?: ExecutionResult
  created_at: Date; updated_at: Date; started_at?: Date | null
}

/** Executes the production repository against a strict scripted SQL store. This is NOT PostgreSQL:
 * it checks query fences/order and durable-state transitions, not SQL validity or lock isolation. */
export class F1Store {
  workspaceArchived = false
  readonly row: AgentConversationRow & { deleted_at: Date | null } = {
    deleted_at: null, id: 'conversation', agent_key: agentChatKey(context), workspace_id: context.workspaceId, workflow_id: context.workflowId,
    workflow_node_id: context.workflowNodeId, agent_id: context.agentId, agent_configuration_version_id: configuration.id,
    origin_run_id: null, origin_execution_id: null, harness: 'codex', provider_version: 'fixture', native_session_id: 'session',
    active_request_id: null, active_native_turn_id: null, cancel_requested: false, turn_state: 'idle', last_error: null,
    revision: 0, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: process.cwd(), runtimeDirectory: '/unused', startupDelivered: true },
    created_at: new Date(), updated_at: new Date(),
  }
  readonly turns = new Map<string, Receipt>()
  readonly messages = new Map<string, Message>()
  readonly sessionControls = new Map<string, SessionControlState>()
  readonly publications: Array<{ binding: string; owner_principal_id: string; request_id: string; file_id: string; revision_id: string }> = []
  readonly allocations: Array<{ owner_principal_id: string; request_id: string; file_id: string; revision_id: string; state: string }> = []
  readonly files = new Map<string, { owner_principal_id: string; activity_record_revision: string; state: string }>()
  readonly activityRows: Array<{ record: OperatorActivityChange; sequence: string; revision: string }> = []
  readonly statements: Array<{ sql: string; values: unknown[]; connection: number }> = []
  private connections = 0
  readonly pool = {
    query: (sql: string, values: unknown[] = []) => this.query(sql, values, 0),
    connect: async () => {
      const connection = ++this.connections
      return { query: (sql: string, values: unknown[] = []) => this.query(sql, values, connection), release() {} }
    },
  } as unknown as pg.Pool

  private async query(text: string, values: unknown[], connection: number) {
    const sql = text.replace(/\s+/g, ' ').trim()
    this.statements.push({ sql, values: structuredClone(values), connection })
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount })
    if (sql === 'select current_configuration_version_id from agents where workspace_id=$1 and id=$2 and archived_at is null') {
      return result([{ current_configuration_version_id: configuration.id }])
    }
    const id = String(values[1])
    const receipt = this.turns.get(id)
    if (sql.startsWith('update operator_conversations c') && sql.includes('nativeNonSubmission')) {
      if (this.row.id !== values[0] || this.row.active_request_id !== id || this.row.active_native_turn_id
        || values[4] === 'session_creation' && this.row.native_session_id
        || !receipt || receipt.native_turn_id || 'nativeSubmission' in receipt.payload) return result()
      this.row.record.nativeNonSubmission = JSON.parse(String(values[2]))
      this.row.turn_state = 'uncertain'
      this.row.last_error = values[3] as string | null
      this.row.revision = Number(this.row.revision) + 1
      return result([], 1)
    }
    if (sql.startsWith('select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals')) {
      return result(values[0] === principal.id ? [{ id: principal.id, name: principal.name, audience: principal.audience,
        grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [])
    }
    if (['begin', 'commit', 'rollback', 'begin isolation level repeatable read read only'].includes(sql) || sql.startsWith('select pg_advisory_xact_lock')) return result()
    if (sql === 'select archived_at from workspaces where id = $1 for share') {
      return result([{ archived_at: this.workspaceArchived ? new Date() : null }])
    }
    if (sql.startsWith("select c.record->>'workingDirectory' as path,")) {
      return result(values[0] === this.row.id ? [{ path: this.row.record.workingDirectory, host_kind: 'main' }] : [])
    }
    if (sql.startsWith('select record, revision, current_version_id from application_settings')) return result()
    if (isCurrentVersionRead(sql)) {
      return result(values[0] === context.workspaceId && values[1] === context.workflowId ? [chatWorkflowVersionRow({ ...context,
        configurationId: configuration.id })] : [])
    }
    if (sql.startsWith("update operator_conversations set record=record || jsonb_build_object('systemPrompt'")) {
      if (this.row.id !== values[0]) return result()
      this.row.record.systemPrompt = JSON.parse(String(values[1]))
      return result([], 1)
    }
    if (sql === 'select record from conversation_session_controls where conversation_id=$1'
      || sql === 'select record from conversation_session_controls where conversation_id=$1 for update') {
      const record = this.sessionControls.get(String(values[0]))
      return result(record ? [{ record }] : [])
    }
    if (sql === 'update conversation_session_controls set record=$2::jsonb where conversation_id=$1') {
      const conversationId = String(values[0])
      if (!this.sessionControls.has(conversationId)) return result()
      this.sessionControls.set(conversationId, JSON.parse(String(values[1])) as SessionControlState)
      return result([], 1)
    }
    if (sql.startsWith('with target as materialized') && sql.includes('update conversation_session_controls')) {
      const conversationId = String(values[0])
      const previous = this.sessionControls.get(conversationId)
      if (!previous || this.row.id !== conversationId || this.row.active_request_id !== values[1]
        || this.row.native_session_id !== values[2] || this.row.deleted_at
        || previous.profileKey !== values[3]) return result()
      const applied = JSON.parse(String(values[4])) as Pick<SessionControlState, 'appliedMode'>
      const matchesDesired = previous.desiredMode === applied.appliedMode
        && JSON.stringify(previous.desired) === JSON.stringify(previous.applied)
      const next = { ...previous, ...applied, revision: previous.revision + 1,
        applicability: matchesDesired ? 'applied' as const : previous.applicability }
      this.sessionControls.set(conversationId, next)
      return result([], 1)
    }
    if (sql.startsWith('select record from conversation_session_defaults')) return result()
    if (sql.startsWith('insert into conversation_session_controls(conversation_id,record)')) {
      const conversationId = String(values[0])
      if (this.sessionControls.has(conversationId)) return result()
      this.sessionControls.set(conversationId, JSON.parse(String(values[1])) as SessionControlState)
      return result([], 1)
    }
    if (sql.startsWith("update conversation_session_controls set record=jsonb_set($2::jsonb,'{context}',")
      || sql === "update conversation_session_controls set record=$2::jsonb where conversation_id=$1 and (record->>'revision')::bigint=$3") {
      const conversationId = String(values[0])
      if (this.sessionControls.get(conversationId)?.revision !== Number(values[2])) return result()
      const next = JSON.parse(String(values[1])) as SessionControlState
      const previous = this.sessionControls.get(conversationId)
      if (sql.includes("jsonb_set") && previous?.profileKey === next.profileKey) next.context = previous.context
      this.sessionControls.set(conversationId, next)
      return result([], 1)
    }
    // This message fixture has no admitted compaction command receipts.
    if (sql.startsWith("select result#>'{state,compaction}' as compaction from management_command_receipts")) return result()
    if (sql.startsWith('with candidates as materialized ( select r.principal_id,r.operation,r.command_id')) return result() // No accepted controls in this fixture.
    if (sql.startsWith('select a.conversation_id,a.request_id,a.activity_id,a.source_provenance')) {
      assert.equal(values[0], 'agent')
      assert(values[1] === null || values[1] === this.row.id)
      assert(sql.includes("a.source_provenance->>'ownerInputHash'=t.input_hash") && sql.endsWith('order by a.sequence limit 101'))
      assert(this.activityRows.every(entry => entry.record.kind === 'thinking'
        || !['pending', 'running', 'unknown'].includes(entry.record.status)), 'this fixture has no unfinished native activity owners')
      return result()
    }
    if (sql.startsWith('select m.id,t.request_id,t.payload')) {
      if (values[0] !== this.row.id) return result()
      return result([...this.turns.values()].flatMap(turn => {
        const message = this.messages.get(turn.message_id)
        return message?.role === 'user' && message.requestId === turn.request_id && (values[1] as string[]).includes(message.id)
          ? [{ id: message.id, request_id: turn.request_id, content: turn.payload.content, input_pins: [] }] : []
      }))
    }
    // This text/control fixture has no file publication relations. The exact
    // relation guard returns no candidates; other publication SQL stays unsupported.
    if (sql.startsWith('select t.message_id,t.native_turn_id,')
      && sql.includes("where c.id=$1 and c.kind in ('agent','operator') and c.harness='codex'")
      && sql.includes("to_regclass('file_tool_publications') is not null")
      && sql.includes("to_regclass('file_allocations') is not null") && values[0] === this.row.id) return result()
    // Model the Claude reader's admitted-message and finalized-ledger joins.
    // Codex-only text fixtures have no Claude candidates, not synthetic publications.
    if (sql.startsWith('select t.message_id, case when c.kind=')
      && sql.includes("where c.id=$1 and c.harness='claude' and c.deleted_at is null")
      && sql.includes("m.client_request_id=t.request_id and m.role='user'")
      && sql.includes("t.payload->'nativeSubmission'->>'kind'='message'")) {
      if (values[0] !== this.row.id || this.row.harness !== 'claude' || this.row.deleted_at != null) return result()
      return result([...this.turns.values()].flatMap(turn => {
        const message = this.messages.get(turn.message_id), native = turn.payload.nativeSubmission
        return turn.intent !== 'steer' && (values[1] as string[]).includes(turn.message_id)
          && message?.conversationId === this.row.id && message.role === 'user' && message.requestId === turn.request_id
          && native?.kind === 'message' && native.nativeSessionId && native.nativeMessageId && native.clientCorrelationId
          && turn.payload.ownerPrincipalId != null && this.row.workspace_id != null && this.row.workflow_id != null && this.row.agent_id != null
          ? [{ message_id: turn.message_id, owner_principal_id: turn.payload.ownerPrincipalId,
            native_session_id: native.nativeSessionId, native_message_id: native.nativeMessageId,
            kind: 'agent', operator_id: null, workspace_id: this.row.workspace_id, workflow_id: this.row.workflow_id,
            agent_id: this.row.agent_id, origin_run_id: this.row.origin_run_id, origin_execution_id: this.row.origin_execution_id }] : []
      }))
    }
    if (sql.startsWith('select p.binding,p.owner_principal_id,p.file_id,p.revision_id,p.request_id,')
      && sql.includes('from file_tool_publications p') && sql.includes('join files f')
      && sql.includes('a.request_id=p.request_id') && sql.includes('a.revision_id=p.revision_id')
      && sql.includes("a.state='finalized'") && sql.includes('where p.binding=any($1::text[])')) {
      return result(this.publications.filter(publication => (values[0] as string[]).includes(publication.binding))
        .sort((a, b) => a.request_id.localeCompare(b.request_id)).flatMap(publication => {
          const file = this.files.get(publication.file_id)
          const allocated = this.allocations.some(allocation => allocation.owner_principal_id === publication.owner_principal_id
            && allocation.request_id === publication.request_id && allocation.file_id === publication.file_id
            && allocation.revision_id === publication.revision_id && allocation.state === 'finalized')
          return allocated && file?.owner_principal_id === publication.owner_principal_id
            ? [{ ...publication, file_activity_revision: file.activity_record_revision, file_state: file.state }] : []
        }))
    }
    if (sql.startsWith('select (select started_at from operator_conversation_turns')) {
      const latest = [...this.turns.values()].sort((a, b) => Number(a.turn_sequence) - Number(b.turn_sequence)).at(-1)
      return result([{ started_at: receipt?.started_at ?? null, latest_request_id: latest?.request_id ?? null }])
    }
    if (sql.startsWith('select * from operator_conversations') || sql.startsWith('select id from operator_conversations')) return result([this.row])
    if (sql.startsWith('select delivery from operator_conversation_turns')) {
      return result([...this.turns.values()].filter((entry) => entry.native_turn_id === values[1] && entry.intent !== 'steer'
        && ['completed', 'failed', 'canceled'].includes(entry.delivery)).slice(-1))
    }
    if (sql.startsWith('select s.request_id as "requestId"')) {
      return result([...this.turns.values()].filter((entry) => entry.intent === 'steer'
        && (entry.delivery === 'submitting' || entry.delivery === 'unknown')).map((entry) => ({
        requestId: entry.request_id, targetNativeTurnId: entry.target_native_turn_id, delivery: entry.delivery,
        targetRequestId: [...this.turns.values()].reverse().find((target) => target.intent !== 'steer'
          && target.native_turn_id === entry.target_native_turn_id)?.request_id ?? null,
      })))
    }
    if (sql.startsWith('select count(*)::text as count from operator_conversation_turns')) {
      const deliveries = values[1] as string[]
      return result([{ count: String([...this.turns.values()].filter((entry) => entry.intent !== null
        && deliveries.includes(entry.delivery)).length) }])
    }
    if (sql.startsWith('select 1 from operator_conversation_turns')) {
      return result([...this.turns.values()].filter((entry) => entry.intent !== 'steer'
        && ['submitting', 'accepted', 'unknown'].includes(entry.delivery)).slice(0, 1).map(() => ({ '1': 1 })))
    }
    if (sql.startsWith('select payload')) return result(receipt ? [{
      content: receipt.payload.content,
      mode: receipt.payload.sessionMode ?? null,
      owner: receipt.payload.ownerPrincipalId ?? null,
    }] : [])
    if (sql.startsWith('with open as (')) {
      const deliveries = values[1] as string[]
      const limit = Number(values[2])
      const turns = [...this.turns.values()]
      const open = turns.filter((entry) => entry.intent !== null && deliveries.includes(entry.delivery)).slice(0, limit + 1)
      const recentLimit = Math.min(50, Math.max(0, limit - open.length))
      const recent = recentLimit ? turns.filter((entry) => entry.intent !== null && !deliveries.includes(entry.delivery))
        .slice(-recentLimit) : []
      return result([...open, ...recent].sort((a, b) => Number(a.turn_sequence) - Number(b.turn_sequence)))
    }
    if (sql.startsWith('with candidates as (')) {
      return result([{ messages: [...this.messages.values()], has_earlier: false, next_cursor: null }])
    }
    if (sql.startsWith('select request_id')) {
      if (sql.includes("delivery='queued'")) return result([...this.turns.values()].filter((entry) => entry.delivery === 'queued')
        .sort((a, b) => Number(b.intent === 'interrupt_and_send') - Number(a.intent === 'interrupt_and_send')
          || Number(a.turn_sequence) - Number(b.turn_sequence)).slice(0, 1))
      return result(receipt ? [receipt] : [])
    }
    if (sql.startsWith('select record,sequence::text from operator_conversation_messages')) {
      return result([...this.messages.values()].reverse().map((record, index) => ({ record, sequence: String(index + 1) })))
    }
    if (sql.startsWith('select record,sequence::text,revision::text from operator_conversation_activity')) {
      if (sql.includes("record->>'status' in")) return result(this.activityRows.filter((entry) => entry.record.kind !== 'thinking'
        && ['pending', 'running', 'unknown'].includes(entry.record.status)).slice(0, Number(values[1])))
      return result([...this.activityRows].reverse().filter((entry) => values[1] === null || BigInt(entry.sequence) < BigInt(String(values[1])))
        .slice(0, Number(values[2])))
    }
    if (sql.startsWith('insert into operator_conversation_messages')) {
      this.messages.set(String(values[0]), JSON.parse(String(values[4])) as Message)
      return result([], 1)
    }
    if (sql.startsWith('insert into operator_conversation_turns')) {
      assert(!receipt, 'A request receipt must never be inserted twice.')
      const inserted: Receipt = { request_id: id, turn_sequence: String(this.turns.size + 1), payload: JSON.parse(String(values[2])) as Receipt['payload'],
        input_hash: String(values[3]), intent: values[4] as Receipt['intent'], delivery: values[5] as Receipt['delivery'],
        message_id: String(values[6]), target_native_turn_id: values[7] as string | null, native_turn_id: null,
        delivery_error: null, created_at: new Date(), updated_at: new Date() }
      this.turns.set(id, inserted); return result([inserted])
    }
    if (sql.startsWith('delete from operator_conversation_turns')) {
      if (receipt?.delivery !== 'submitting') return result()
      this.turns.delete(id); return result([{ message_id: receipt.message_id }])
    }
    if (sql.startsWith('delete from operator_conversation_messages')) { this.messages.delete(id); return result([], 1) }
    if (sql.startsWith('update operator_conversation_turns')) {
      if (sql.includes("set delivery='canceled'")) {
        const queued = [...this.turns.values()].filter((entry) => entry.delivery === 'queued' && (values[1] === null || entry.request_id === values[1]))
        for (const entry of queued) entry.delivery = 'canceled'
        return result([], queued.length)
      }
      if (sql.includes("and intent='steer' and native_turn_id=$2")) {
        const steers = [...this.turns.values()].filter((entry) => entry.intent === 'steer' && entry.native_turn_id === values[1] && entry.delivery === 'accepted')
        for (const entry of steers) entry.delivery = values[2] as Receipt['delivery']
        return result([], steers.length)
      }
      if (!receipt) return result()
      if (sql.includes("set delivery='submitting'")) {
        if (receipt.delivery !== 'queued') return result()
        receipt.delivery = 'submitting'; receipt.started_at ??= new Date()
      } else if (sql.includes("set delivery='accepted'") || sql.includes('set delivery=$4')) {
        if (!['submitting', 'unknown'].includes(receipt.delivery)) return result()
        if (sql.includes('target_native_turn_id=$3') && receipt.target_native_turn_id !== values[2]) return result()
        receipt.delivery = sql.includes('set delivery=$4') ? values[3] as Receipt['delivery'] : 'accepted'
        receipt.native_turn_id = String(values[2])
        if (sql.includes('delivery_error=null')) receipt.delivery_error = null
      } else if (sql.includes("set delivery='unknown'")) {
        if (!['submitting', 'accepted'].includes(receipt.delivery)) return result()
        receipt.delivery = 'unknown'; receipt.delivery_error = JSON.parse(String(values[2])) as Receipt['delivery_error']
      } else if (sql.includes('set delivery=$3,delivery_error=')) {
        if (!['submitting', 'accepted', 'unknown'].includes(receipt.delivery)) return result()
        receipt.delivery = values[2] as Receipt['delivery']; receipt.result = JSON.parse(String(values[4])) as ExecutionResult
        receipt.delivery_error = values[3] === null ? null : JSON.parse(String(values[3])) as Receipt['delivery_error']
      } else throw new Error(`Unhandled turn update: ${sql}`)
      return result([], 1)
    }
    if (sql.startsWith('update operator_conversation_activity')) {
      for (const entry of this.activityRows) if (entry.record.requestId === values[1] && ['pending', 'running'].includes(entry.record.status)) {
        entry.record.status = entry.record.kind === 'thinking' ? values[2] ? 'canceled' : 'completed' : 'unknown'
        entry.revision = String(Number(entry.revision) + 1)
      }
      return result()
    }
    if (sql.startsWith('update operator_conversations')) {
      if (sql.includes('and active_request_id=$2') && this.row.active_request_id !== values[1]) return result()
      if (sql.includes('set active_request_id=$2')) {
        Object.assign(this.row, { active_request_id: id, active_native_turn_id: null, cancel_requested: false, turn_state: 'starting', last_result: null })
      } else if (sql.includes('set active_native_turn_id=$3')) {
        this.row.active_native_turn_id = String(values[2]); this.row.turn_state = this.row.cancel_requested ? 'canceling' : 'active'
      } else if (sql.includes('set cancel_requested=true')) {
        this.row.cancel_requested = true; this.row.turn_state = 'canceling'
      } else if (sql.includes('set pending_interaction=$3::jsonb')) {
        this.row.pending_interaction = values[2] === null ? null : JSON.parse(String(values[2])) as AgentConversationRow['pending_interaction']
      } else if (sql.includes('set active_request_id=null')) {
        Object.assign(this.row, { active_request_id: null, active_native_turn_id: null, cancel_requested: false, pending_interaction: null })
        if (sql.includes('last_result=$4')) {
          this.row.turn_state = values[1] as AgentConversationRow['turn_state']; this.row.last_result = JSON.parse(String(values[3])) as ExecutionResult
        }
      } else if (sql.includes("set turn_state='uncertain'")) this.row.turn_state = 'uncertain'
      else if (!sql.startsWith('update operator_conversations set revision=')) throw new Error(`Unhandled conversation update: ${sql}`)
      this.row.revision = Number(this.row.revision) + 1
      return result([], 1)
    }
    throw new Error(`Unhandled F1 SQL: ${sql}`)
  }
}

export class F1Native implements NativeHarnessSessionManager {
  readonly harness: AgentHarness = 'codex'
  readonly session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'session' }
  readonly starts: string[] = []
  readonly modes: Array<NativeTurnInput['sessionMode']> = []
  readonly prompts: string[] = []
  readonly cancels: string[] = []
  readonly steers: NativeSteerInput[] = []
  readonly holds = new Map<string, ReturnType<typeof deferred<void>>>()
  readonly histories = new Map<string, NativeHistory>()
  active: string | undefined
  steerReply: ((input: NativeSteerInput) => Promise<{ nativeTurnId: string }>) | undefined
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('Unused: no native discovery.') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('Unused: no MCP environment.') }
  async createSession(): Promise<NativeSessionReference> { throw new Error('Unused: fixture session is already resident.') }
  async attachSession(): Promise<NativeSessionReference> { throw new Error('Unused: fixture session is already resident.') }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    const requestId = input.clientCorrelationId.split(':').at(-1)!
    this.starts.push(requestId)
    this.modes.push(input.sessionMode)
    this.prompts.push(input.prompt)
    this.active = requestId
    const history: NativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: `turn-${requestId}`, events: [], pendingInteractions: [] }
    this.histories.set(input.clientCorrelationId, history)
    await input.onSettingsApplied?.()
    await input.onSubmitted?.(history.nativeTurnId!)
    const hold = this.holds.get(requestId)
    if (hold) {
      const onAbort: () => void = hold.resolve
      signal?.addEventListener('abort', onAbort, { once: true })
      try { if (!signal?.aborted) await hold.promise } finally { signal?.removeEventListener('abort', onAbort) }
    }
    signal?.throwIfAborted()
    history.terminalResult ??= { outcome: 'succeeded' }
    if (this.active === requestId) this.active = undefined
    yield* []
  }
  finish(requestId: string, result: ExecutionResult = { outcome: 'succeeded' }) {
    const history = [...this.histories.values()].find((entry) => entry.nativeTurnId === `turn-${requestId}`)
    assert(history, `No native history for ${requestId}`)
    history.terminalResult = result; this.holds.get(requestId)?.resolve()
  }
  async steerTurn(_session: NativeSessionReference, input: NativeSteerInput) {
    if (`turn-${this.active}` !== input.expectedTurnId) throw new NativeTurnNotActiveError()
    this.steers.push(input)
    return this.steerReply ? this.steerReply(input) : { nativeTurnId: input.expectedTurnId }
  }
  async cancel(_session: NativeSessionReference, _signal?: AbortSignal, nativeTurnId?: string) {
    assert(nativeTurnId, 'A native interrupt must always be fenced.')
    this.cancels.push(nativeTurnId)
    if (!this.active || `turn-${this.active}` !== nativeTurnId) return false
    this.finish(this.active, { outcome: 'canceled' }); return true
  }
  async reconcile(_session: NativeSessionReference, correlation: string) { return structuredClone(this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }) }
  async history() { return { events: [], pendingInteractions: [] } }
  async pending() { return undefined }
  async respond() { throw new Error('Unused: no approvals in F1 tests.') }
  async close() {}
}

export function fixture(store = new F1Store()) {
  const repository = new PostgresAgentChatRepository(store.pool)
  const manager = new F1Native()
  const workflows = {
    getAgentConfiguration: async () => configuration,
    getCurrentSavedVersion: async () => ({ definition: { nodes: [{ id: context.workflowNodeId, agentId: context.agentId }] } }),
    getSavedVersion: async () => { throw new Error('Unused: no Run-origin selection.') },
  } as unknown as Pick<PostgresWorkflowRepository, 'getAgentConfiguration' | 'getCurrentSavedVersion' | 'getSavedVersion'>
  const service = new AgentChatService(store.pool, repository, {} as PostgresOperatorConversationRepository,
    workflows, { getForWorkspace: () => { throw new Error('No Run access in F1 tests.') },
      getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages: () => { throw new Error('No execution access in F1 tests.') } },
    // Production composition qualifies Codex steering for the live owner; this fixture composes the same port.
    Object.assign(() => manager, { qualifiedSteer: qualifiedAgentChatSteer }), '/unused')
  // Keep the service/pump/observation code real; only the already-resident native owner is injected.
  const internals = service as unknown as {
    runtimes: Map<string, { manager: NativeHarnessSessionManager; session: NativeSessionReference; configuration: AgentConfigurationVersion }>
    tasks: Map<string, Promise<void>>
    control<T>(id: string, operation: () => Promise<T>): Promise<T>
    pump(id: string): void
  }
  const dispatchAttempts: string[] = []
  ;(service as unknown as { commands: { execute: (...args: unknown[]) => Promise<unknown>; drain: () => Promise<void> } }).commands = {
    execute: async (...args: unknown[]) => (args[5] as (markDispatchAttempt: () => void) => Promise<unknown>)(
      () => { dispatchAttempts.push(String(args[3])) }), drain: async () => undefined,
  }
  internals.runtimes.set(store.row.id, { manager, session: manager.session, configuration })
  const request = (requestId: string, extra: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest => ({
    requestId, content: requestId, intent: 'next_turn', expectedConversationId: store.row.id,
    context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }, ...extra,
  })
  const send = (requestId: string, extra: Partial<SendAgentChatMessageRequest> = {}) => service.send(principal, context.workspaceId, request(requestId, extra))
  return { store, repository, manager, service, internals, principal, request, send, dispatchAttempts,
    read: () => service.readConversation(principal, context.workspaceId, store.row.id),
    async active(requestId = 'A') {
      manager.holds.set(requestId, deferred()); await send(requestId)
      await eventually(() => store.row.active_native_turn_id === `turn-${requestId}`)
    },
    async idle() { await eventually(() => !store.row.active_request_id && !internals.tasks.has(store.row.id)) },
  }
}
