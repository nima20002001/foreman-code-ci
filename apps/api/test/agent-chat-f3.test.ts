import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, it } from 'vitest'
import {
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, type ExecutionResult,
  type HarnessExecution, type NativeHarnessEvent, type NativeSessionReference,
} from '@foreman-code/contracts'
import type { AgentChatContext, AgentChatOrigin, AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, type AgentConversationRow, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { immutableVersionRow, isCurrentVersionRead, isRunVersionRead, isSavedVersionRead } from './helpers/chatWorkflowVersion.js'
import { deferred } from './helpers/deferred.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'

// Isolated service regressions. SQL persistence and provider I/O are deliberately substituted here.
// The existing authenticated HTTP/MCP PostgreSQL suite remains a separate integration gate.
const principal: ManagementPrincipal = { id: 'f3-reader', name: 'F3 fixture', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ scope: {}, actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'] }] }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

class MemoryConversations {
  row: AgentConversationRow | undefined
  selection: { workflowVersionId: string; attemptKey: string } | null = null
  readonly turns: AgentChatTurn[] = []
  readonly unavailable: Array<{ message: string; reason: string }> = []
  abandonments = 0
  cancels = 0
  beforeCancel: (() => Promise<void>) | undefined
  openRead: (() => Promise<AgentConversationRow[]>) | undefined
  async byKey() { return this.row }
  async get() { return this.row }
  async state() { return { row: this.row!, turns: this.turns, messages: [], hasEarlierMessages: false,
    selection: this.selection, activeStartedAt: null, latestRequestId: this.turns.at(-1)?.requestId ?? null,
    unfinishedActivities: [], activityPage: { activities: [], nextCursor: null, itemRevisions: {} } } }
  async open() { return this.openRead ? this.openRead() : this.row ? [this.row] : [] }
  async restoreUnsettled() { return this.row }
  async unconfirmedSteers() { return [] }
  async nextQueued() { return undefined }
  async turn(_id: string, requestId: string) { return this.turns.find((turn) => turn.requestId === requestId) }
  async turnContent(_id: string, requestId: string) { return `content-${requestId}` }
  async turnSessionMode() { return undefined }
  async turnPrincipalId() { return undefined }
  async turnPreparedInput() { return undefined }
  async cancelQueued() { await this.beforeCancel?.(); this.cancels++; return true }
  async beginSessionCreation(_id: string, requestId: string) {
    if (this.row?.active_request_id !== requestId || this.row.record.sessionCreation) return false
    this.row.record.sessionCreation = { requestId }
    return true
  }
  async bindSession(_id: string, version: string, nativeId: string) { this.row!.provider_version = version; this.row!.native_session_id = nativeId }
  async recordNonSubmission(_id: string, requestId: string,
    operation: 'session_creation' | 'turn_submission', result: ExecutionResult) {
    if (!this.row || this.row.active_request_id !== requestId || this.row.active_native_turn_id
      || operation === 'session_creation' && this.row.native_session_id) return false
    this.row.record.nativeNonSubmission = { requestId, operation, result }
    this.row.turn_state = 'uncertain'
    return true
  }
  async markStartupDelivered() { this.row!.record.startupDelivered = true }
  async markSessionUnavailable(_id: string, message: string, reason: 'native_session_missing' | 'harness_unavailable' = 'native_session_missing') {
    this.unavailable.push({ message, reason }); this.row!.record.sessionUnavailable = message; this.row!.record.sessionUnavailableReason = reason
  }
  async accepted(_id: string, requestId: string, nativeTurnId: string) {
    const turn = this.turns.find((value) => value.requestId === requestId)!
    turn.delivery = 'accepted'; turn.nativeTurnId = nativeTurnId; this.row!.active_native_turn_id = nativeTurnId
    this.row!.record.startupDelivered = true
    this.row!.record.startupReceipt ??= { requestId, nativeSessionId: this.row!.native_session_id! }
    return true
  }
  async finish(_id: string, requestId: string, result: ExecutionResult, _nativeMessageId?: string, rejectedCreation = false) {
    if (rejectedCreation) {
      if (this.row?.active_request_id !== requestId || this.row.record.sessionCreation?.requestId !== requestId
        || this.row.native_session_id || this.row.active_native_turn_id || this.row.record.sessionUnavailable
        || result.outcome === 'succeeded') return false
      delete this.row.record.sessionCreation
    }
    delete this.row!.record.nativeNonSubmission
    this.turns.find((value) => value.requestId === requestId)!.delivery = result.outcome === 'succeeded' ? 'completed' : result.outcome
    this.row!.last_result = result; this.row!.active_request_id = null; this.row!.active_native_turn_id = null; this.row!.turn_state = 'idle'
    return true
  }
  async abandon(_id: string, requestId: string) {
    this.abandonments++; this.turns.find((value) => value.requestId === requestId)!.delivery = 'unknown'
    this.row!.turn_state = 'uncertain'
  }
  begin(requestId = 'first'): AgentChatTurn {
    this.row!.active_request_id = requestId; this.row!.turn_state = 'starting'
    const turn: AgentChatTurn = { requestId, sequence: String(this.turns.length + 1), intent: 'next_turn', delivery: 'submitting',
      messageId: `message-${requestId}`, createdAt: this.row!.created_at.toISOString(), updatedAt: this.row!.updated_at.toISOString() }
    this.turns.push(turn); return turn
  }
}

class NativeFixture implements NativeHarnessSessionManager {
  readonly calls: Array<{ kind: 'create' | 'attach' | 'fork'; input: NativeSessionStart; source?: string }> = []
  readonly prompts: Array<{ session: string; prompt: string }> = []
  failure: Error | undefined
  failDispose = false
  disposals = 0
  readonly harness = 'codex' as const
  async capabilities() { return { provider: this.harness, providerVersion: 'fixture-only', persistentSessions: true, reconnect: true,
    sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] } }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('No MCP authority in this fixture') }
  async createSession(input: NativeSessionStart) {
    this.calls.push({ kind: 'create', input }); if (this.failure) throw this.failure
    return { harness: this.harness, providerVersion: 'fixture-only', nativeSessionId: 'chat-native' }
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    this.calls.push({ kind: 'attach', input, source: session.nativeSessionId }); if (this.failure) throw this.failure
    return session
  }
  async forkSession(session: NativeSessionReference, input: NativeSessionStart) {
    this.calls.push({ kind: 'fork', input, source: session.nativeSessionId }); if (this.failure) throw this.failure
    return { ...session, nativeSessionId: 'chat-fork' }
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput): AsyncIterable<NativeHarnessEvent> {
    this.prompts.push({ session: session.nativeSessionId, prompt: input.prompt })
    await input.onSubmitted?.(`native-turn-${input.clientCorrelationId}`)
    // No fabricated provider events: completed-message/history behavior belongs to the recovery lane.
    yield* []
  }
  async reconcile(_session: NativeSessionReference, correlationId: string): Promise<NativeHistory> {
    return { correlationId, nativeTurnId: `native-turn-${correlationId}`, terminalResult: { outcome: 'succeeded' }, events: [], pendingInteractions: [] }
  }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return false }
  async history(): Promise<NativeHistory> { return { events: [], pendingInteractions: [] } }
  async close() { await this.dispose() }
  async dispose() { this.disposals++; if (this.failDispose) throw new Error('fixture disposal not proven') }
}

async function setup(options: { ephemeral?: boolean; stored?: boolean; origin?: AgentChatOrigin; repeat?: boolean } = {}) {
  const fixture = makeCurrentWorkflowFixture('f3', options.repeat ? 'repeat' : 'single')
  const configuration = structuredClone(fixture.configurations[0]!)
  if (options.ephemeral && configuration.harness.harness === 'codex') {
    configuration.harness.advanced = { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), sessionPersistence: 'ephemeral' }
  }
  if (configuration.harness.harness === 'claude') throw new Error('The fixture must select Codex.')
  const node = fixture.version.definition.nodes[0]!
  const context: AgentChatContext = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
    workflowNodeId: node.id, agentId: node.agentId }
  const repository = new MemoryConversations()
  const origin: AgentChatOrigin = options.origin ?? { kind: 'fresh' }
  if (origin.kind === 'run_execution') context.runId = origin.runId
  if (origin.kind === 'run_execution') repository.selection = {
    workflowVersionId: fixture.run.workflowVersionId, attemptKey: String(fixture.identities[0]!.attempt),
  }
  repository.row = { id: 'conversation-f3', agent_key: agentChatKey(context), workspace_id: context.workspaceId, workflow_id: context.workflowId,
    workflow_node_id: node.id, agent_id: node.agentId, agent_configuration_version_id: configuration.id,
    origin_run_id: origin.kind === 'run_execution' ? origin.runId : null, origin_execution_id: origin.kind === 'run_execution' ? origin.executionId : null,
    harness: configuration.harness.harness, provider_version: options.stored ? 'fixture-only' : null, native_session_id: options.stored ? 'stored-native' : null,
    active_request_id: null, active_native_turn_id: null, cancel_requested: false, turn_state: 'idle', last_error: null, revision: 1,
    pending_interaction: null, last_result: null, record: { origin, workingDirectory: '/fixture-read-only', runtimeDirectory: '' },
    created_at: new Date(fixture.createdAt), updated_at: new Date(fixture.createdAt) }
  const root = await mkdtemp(join(tmpdir(), 'agent-chat-f3-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const native = new NativeFixture()
  const owners = new Map<string, NativeFixture>()
  let allocations = 0, sourceReads = 0
  const factory: AgentChatManagerFactory = Object.assign((id: string) => { allocations++; owners.set(id, native); return native },
    { release: (id: string) => { owners.delete(id) } })
  const source: HarnessExecution[] = origin.kind === 'run_execution' ? [{
    id: origin.executionId, runId: origin.runId, workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: configuration.id, attempt: fixture.identities[0]!.attempt,
    state: 'completed', result: { outcome: 'succeeded' }, nativeSessionId: origin.sourceNativeSessionId,
    workingDirectory: '/fixture-read-only', createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
    input: { executionSemanticsVersion: 3, occurrence: { identity: { scope: fixture.scope,
      blockId: 'repair', occurrenceId: 'occ-1', occurrenceIndex: 1 } } },
  }] : []
  const runs = { getForWorkspace: async () => ({ ...fixture.run, executionState: 'completed' as const, outcome: 'succeeded' as const }),
    getExecution: async (id: string) => source.find(item => item.id === id),
    async *executionPages() { sourceReads++; for (const execution of source) yield [execution] } }
  const workflows = { getSavedVersion: async () => fixture.version, getCurrentSavedVersion: async () => fixture.version,
    getAgentConfiguration: async () => configuration }
  const versionRow = immutableVersionRow(fixture.version)
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] }
    if (isCurrentVersionRead(sql)) return { rows: values[0] === versionRow.workspace_id && values[1] === versionRow.workflow_id ? [versionRow] : [] }
    if (isSavedVersionRead(sql)) return { rows: values[0] === versionRow.id ? [versionRow] : [] }
    if (isRunVersionRead(sql)) return { rows: values[0] === fixture.run.id ? [{ workflow_version_id: fixture.run.workflowVersionId }] : [] }
    if (sql.startsWith('select record from conversation_session_controls where conversation_id=$1')) return { rows: [] }
    if (sql.startsWith('select current_configuration_version_id from agents')) return { rows:
      values[0] === configuration.workspaceId && values[1] === configuration.agentId
        ? [{ current_configuration_version_id: configuration.id }] : [] }
    if (sql.includes('from management_principals')) return { rows: values[0] === principal.id
      ? [{ id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
        expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }
    if (sql.startsWith("select * from operator_conversations where kind='agent'")) {
      const row = repository.row
      return { rows: row && JSON.stringify(values) === JSON.stringify([row.workspace_id, row.workflow_id,
        row.origin_run_id, row.workflow_node_id, row.agent_id, row.origin_execution_id]) ? [row] : [] }
    }
    if (sql.startsWith('select s.reference from execution_native_sessions')) {
      const origin = repository.row?.record.origin
      return { rows: origin?.kind === 'run_execution' && values[0] === origin.executionId && values[1] === origin.runId
        ? [{ reference: { harness: native.harness, providerVersion: (await native.capabilities()).providerVersion,
          nativeSessionId: origin.sourceNativeSessionId } }] : [] }
    }
    if (sql.includes('from harness_native_events')) {
      const execution = source.find(item => item.id === values[0] && item.runId === values[1]
        && item.workflowNodeId === values[2] && item.agentId === values[3])
      return { rows: execution ? [{ item_key: 'source-reply', role: 'assistant',
        content: `Transcript for ${execution.id}`, original_bytes: 0, complete: true,
        sequence: '1', revision: '1' }] : [] }
    }
    throw new Error(`Unscripted F3 SQL: ${sql}`)
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  function service() {
    const value = new AgentChatService(pool, repository as unknown as PostgresAgentChatRepository,
      {} as PostgresOperatorConversationRepository, workflows, runs as unknown as ConstructorParameters<typeof AgentChatService>[4], factory, root)
    ;(value as unknown as { commands: { execute: (...args: unknown[]) => Promise<unknown>; drain: () => Promise<void> } }).commands = {
      execute: async (...args: unknown[]) => (args[5] as () => Promise<unknown>)(), drain: async () => undefined,
    }
    cleanups.push(() => value.shutdown()); return value
  }
  const chat = service()
  return { fixture, configuration, context, repository, native, owners, source, chat, restart: service,
    allocations: () => allocations, sourceReads: () => sourceReads }
}

function execution(f: Awaited<ReturnType<typeof setup>>, occurrenceIndex: number, attempt: number, id: string): HarnessExecution {
  return { id, runId: f.fixture.run.id, workflowNodeId: f.context.workflowNodeId, agentId: f.context.agentId,
    agentConfigurationVersionId: f.configuration.id, attempt, state: 'completed', result: { outcome: 'succeeded', output: { text: `codeword-${id}` } },
    nativeSessionId: `source-${id}`, workingDirectory: '/fixture-read-only', input: { executionSemanticsVersion: 3,
      occurrence: { identity: { scope: f.fixture.scope, blockId: 'repair', occurrenceId: `occ-${occurrenceIndex}`, occurrenceIndex } } },
    createdAt: f.fixture.createdAt, finishedAt: f.fixture.createdAt }
}

const origin: AgentChatOrigin = { kind: 'run_execution', runId: 'run-f3', executionId: 'origin-execution', sourceNativeSessionId: 'origin-native' }

describe('F3 native availability and ownership', () => {
  it('does not advertise completed-turn retirement when the admitted driver lacks that capability', async () => {
    const f = makeCurrentWorkflowFixture('retirement-capability', 'single')
    const native = new NativeFixture()
    const { manager } = createAdmittedNativeManager('codex', async () => ({ manager: native }))
    try {
      await manager.createSession({ kind: 'agent-chat', configuration: f.configurations[0]!,
        conversationId: 'retirement-chat', workflowId: f.scope.workflowId,
        workflowNodeId: f.version.definition.nodes[0]!.id, workingDirectory: '/fixture-read-only',
        correlationId: 'first' })
      assert.equal(manager.retireTurn, undefined)
      assert.equal(native.calls.length, 1)
    } finally { await manager.dispose!() }
  })

  for (const mode of ['create', 'attach', 'fork'] as const) {
    it(`A-R01: ${mode} refuses scoped App MCP before prompt delivery and keeps read-only configuration`, async () => {
      const f = await setup({ stored: mode === 'attach', ...(mode === 'fork' ? { origin } : {}) })
      const before = structuredClone(f.configuration)
      const rejection = new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'App MCP is enabled')
      f.native.failure = mode === 'attach' ? rejection : new NativeDeliveryError('session_creation', 'not_sent', rejection)
      const turn = f.repository.begin()
      await f.chat['runTurn'](f.repository.row!.id, turn)
      assert.equal(turn.delivery, 'failed'); assert.equal(f.repository.abandonments, 0)
      if (mode === 'attach') assert.equal(f.repository.unavailable[0]!.reason, 'harness_unavailable')
      else {
        assert.equal(f.repository.unavailable.length, 0)
        assert.equal(f.repository.row!.record.sessionCreation, undefined)
      }
      assert.deepEqual(f.native.calls.map((call) => call.kind), [mode]); assert.equal(f.native.prompts.length, 0)
      const input = f.native.calls[0]!.input
      assert.equal(input.environment, undefined); assert.equal(input.kind, 'agent-chat')
      if (input.kind === 'agent-chat') {
        assert.equal(input.conversationId, 'conversation-f3')
        assert.equal(input.workflowNodeId, f.context.workflowNodeId)
        assert.equal(input.workflowId, f.context.workflowId)
        assert.equal(input.configuration.harness.harness, 'codex')
        assert.deepEqual(input.configuration, before)
        assert.equal('request' in input, false)
      }
      assert.deepEqual(f.configuration, before)
      const state = await f.chat.readConversation(principal, f.context.workspaceId, f.repository.row!.id)
      if (mode === 'attach') {
        assert.equal(state.availability.canSend, false)
        assert.equal(state.availability.reason, 'harness_unavailable')
        assert.equal(state.capabilities.resume, false)
        await assert.rejects(f.chat.send(principal, f.context.workspaceId, { requestId: 'retry', context: {
          workflowId: f.context.workflowId, workflowNodeId: f.context.workflowNodeId, agentId: f.context.agentId,
        }, expectedConversationId: f.repository.row!.id, intent: 'next_turn', content: 'retry' }),
        { code: 'AGENT_CHAT_UNAVAILABLE' })
        assert.equal(f.native.calls.length, 1)
      } else {
        assert.equal(state.availability.canSend, true)
        f.native.failure = undefined
        const retry = f.repository.begin('retry')
        await f.chat['runTurn'](f.repository.row!.id, retry)
        assert.equal(retry.delivery, 'completed')
        assert.deepEqual(f.native.calls.map((call) => call.kind), [mode, mode])
        assert.equal(f.native.prompts.length, 1)
        assert.deepEqual(f.configuration, before)
        assert(f.native.calls.every((call) => call.input.environment === undefined))
      }
    })
  }

  it('A-R16: live ephemeral Codex continues twice; a cold owner exposes unavailable and never replaces it', async () => {
    const f = await setup({ ephemeral: true })
    assert.equal(f.chat['capabilities'](f.configuration, f.repository.row).resume, true)
    for (const requestId of ['first', 'second']) {
      const turn = f.repository.begin(requestId); await f.chat['runTurn'](f.repository.row!.id, turn)
      assert.equal(turn.delivery, 'completed')
      const state = await f.chat.readConversation(principal, f.context.workspaceId, f.repository.row!.id)
      assert.equal(state.capabilities.resume, true); assert.equal(state.availability.canSend, true)
    }
    assert.deepEqual(f.native.calls.map((call) => call.kind), ['create'])
    assert.deepEqual(f.native.prompts.map((call) => call.session), ['chat-native', 'chat-native'])
    await f.chat.shutdown()
    const cold = f.restart(), state = await cold.readConversation(principal, f.context.workspaceId, f.repository.row!.id)
    assert.equal(state.capabilities.resume, false); assert.equal(state.sessionState, 'unavailable')
    assert.equal(state.availability.reason, 'native_session_missing')
    await assert.rejects(cold['runtime'](f.repository.row!, f.configuration, 'cold', new AbortController().signal), { code: 'AGENT_CHAT_EPHEMERAL_SESSION_LOST' })
    assert.equal(f.allocations(), 1)
  })

  it('A-R18: failed disposal retains both owners, fences reuse, rejects shutdown and can be retried', async () => {
    const f = await setup()
    f.repository.begin('creation')
    await f.chat['runtime'](f.repository.row!, f.configuration, 'creation', new AbortController().signal)
    f.native.failDispose = true
    await assert.rejects(f.chat['release'](f.repository.row!.id), /fixture disposal not proven/)
    assert(f.owners.has(f.repository.row!.id)); assert(f.chat['runtimes'].has(f.repository.row!.id))
    await assert.rejects(f.chat['runtime'](f.repository.row!, f.configuration, 'replacement', new AbortController().signal), { code: 'AGENT_CHAT_UNAVAILABLE' })
    await assert.rejects(f.chat.shutdown(), (error: unknown) => error instanceof AggregateError && error.errors.length === 1)
    assert(f.owners.has(f.repository.row!.id)); assert.equal(f.allocations(), 1)
    f.native.failDispose = false; await f.chat.shutdown()
    assert.equal(f.owners.size, 0); assert.equal(f.chat['runtimes'].size, 0)
  })
  it('A-R18: shutdown waits for recovery SQL and does not attach after the barrier closes', async () => {
    const f = await setup({ stored: true }); f.repository.begin()
    const gate = deferred<AgentConversationRow[]>(), entered = deferred<void>()
    f.repository.openRead = () => { entered.resolve(); return gate.promise }
    const recovering = f.chat.recover(); await entered.promise
    assert.equal(f.chat.recover(), recovering)
    let closed = false
    const shutdown = f.chat.shutdown().then(() => { closed = true })
    await tick(); assert.equal(closed, false)
    gate.resolve([f.repository.row!]); await recovering; await shutdown
    assert.equal(f.allocations(), 0); assert.equal(f.repository.abandonments, 0)
  })
  it('A-R18: shutdown drains in-flight command persistence and prevents queued controls from dispatching', async () => {
    const f = await setup(), entered = deferred<void>(), gate = deferred<void>()
    f.repository.beforeCancel = () => { entered.resolve(); return gate.promise }
    const cancel = f.chat.cancelQueued(principal, f.context.workspaceId, f.repository.row!.id, 'queued', { requestId: 'f3-cancel' })
    await entered.promise
    const controlGate = deferred<void>(), controlEntered = deferred<void>()
    const active = f.chat['control'](f.repository.row!.id, () => { controlEntered.resolve(); return controlGate.promise })
    await controlEntered.promise
    let called = false
    const queued = f.chat['control'](f.repository.row!.id, async () => { called = true })
    const rejected = assert.rejects(queued, { code: 'AGENT_CHAT_CLOSING' })
    let closed = false
    const shutdown = f.chat.shutdown().then(() => { closed = true })
    await tick(); assert.equal(closed, false)
    gate.resolve(); await cancel; await tick(); assert.equal(closed, false)
    controlGate.resolve(); await active; await rejected; await shutdown
    assert.equal(called, false); assert.equal(f.repository.cancels, 1); assert.equal(f.allocations(), 0)
  })

  it('A-R19: latest business occurrence wins before technical attempt, independent of page/ID order', async () => {
    const f = await setup({ repeat: true })
    const originalRow = structuredClone(f.repository.row!)
    f.repository.row = undefined
    f.source.push(execution(f, 1, 9, 'z-older-nine'), execution(f, 2, 2, 'a-newer-two'), execution(f, 2, 1, 'm-newer-one'))
    const before = structuredClone(f.source), context = { ...f.context, runId: f.fixture.run.id }
    for (let pass = 0; pass < 2; pass++) {
      const state = await f.chat.read(principal, context.workspaceId, context)
      assert.equal(state.availability.canSend, true)
      assert.equal(state.conversation, null)
      assert.equal(state.sourceTranscript?.executionId, 'a-newer-two')
      assert.equal(state.sourceTranscript?.messages[0]?.content, 'Transcript for a-newer-two')
      f.source.reverse()
    }
    assert.deepEqual(f.source, before)
    const selected = { kind: 'run_execution' as const, runId: f.fixture.run.id,
      executionId: 'a-newer-two', sourceNativeSessionId: 'source-a-newer-two' }
    f.repository.row = { ...originalRow, agent_key: agentChatKey(context), origin_run_id: selected.runId,
      origin_execution_id: selected.executionId, record: { ...originalRow.record, origin: selected } }
    const captured = f.source.find((item) => item.id === selected.executionId && item.runId === selected.runId)
    assert(captured)
    f.repository.selection = { workflowVersionId: f.fixture.run.workflowVersionId, attemptKey: String(captured.attempt) }
    f.repository.begin('selected-fork')
    await f.chat['runtime'](f.repository.row, f.configuration, 'selected-fork', new AbortController().signal)
    assert.equal(f.native.calls[0]!.kind, 'fork'); assert.equal(f.native.calls[0]!.source, selected.sourceNativeSessionId)
    const state = await f.chat.readConversation(principal, context.workspaceId, f.repository.row.id)
    assert.deepEqual(state.conversation?.origin, selected)
    assert.deepEqual(f.source, before)
  })
  it('A-R19: a later attempt without a usable session blocks instead of falling back to old native history', async () => {
    const f = await setup({ repeat: true }); f.repository.row = undefined
    const latest = execution(f, 2, 1, 'latest'); delete latest.nativeSessionId
    f.source.push(execution(f, 1, 9, 'old'), latest)
    const resolution = await f.chat['resolve']({ ...f.context, runId: f.fixture.run.id })
    assert.equal(resolution.blocked?.reason, 'native_session_missing'); assert.equal(resolution.create, undefined)
  })
  it('A-R19: persisted conversation origin stays pinned and malformed occurrence scope is rejected', async () => {
    const f = await setup({ repeat: true, origin })
    const state = await f.chat.readConversation(principal, f.context.workspaceId, f.repository.row!.id)
    assert.deepEqual(state.conversation?.origin, origin)
    assert.equal(state.sourceTranscript?.executionId, origin.executionId)
    assert.equal(f.sourceReads(), 0)
    f.repository.row = undefined
    const bad = execution(f, 2, 1, 'wrong-scope')
    bad.input = { occurrence: { identity: { scope: { ...f.fixture.scope, runId: 'other-run' }, blockId: 'repair', occurrenceId: 'occ-2', occurrenceIndex: 2 } } }
    f.source.push(bad)
    const rejected = await f.chat.read(principal, f.context.workspaceId, { ...f.context, runId: f.fixture.run.id })
    assert.equal(rejected.availability.canSend, false)
    assert.equal(rejected.availability.reason, 'context_stale')
    assert.equal(rejected.sourceTranscript, undefined)
    assert.equal(f.allocations(), 0)
  })

  it('A-R01/A-R13: durable unavailability records the reason without altering the origin', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = []
    const repository = new PostgresAgentChatRepository({ query: async (sql: string, values: unknown[]) => {
      statements.push({ sql, values }); return { rows: [] }
    } } as unknown as pg.Pool)
    await repository.markSessionUnavailable('conversation', 'no App authority', 'harness_unavailable')
    await repository.markSessionUnavailable('conversation', 'missing native')
    assert.deepEqual(statements.map((entry) => entry.values), [
      ['conversation', 'no App authority', 'harness_unavailable'], ['conversation', 'missing native', 'native_session_missing'],
    ])
    for (const statement of statements) {
      assert.match(statement.sql, /record=record \|\| jsonb_build_object/)
      assert.match(statement.sql, /kind='agent'/); assert.doesNotMatch(statement.sql, /update\s+(workflow_runs|harness_executions)/i)
    }
  })
})
