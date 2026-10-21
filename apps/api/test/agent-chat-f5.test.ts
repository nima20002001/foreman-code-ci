import { memorySessionControlPool } from './support/sessionControls.js'
import assert from 'node:assert/strict'
import type pg from 'pg'
import { describe, it } from 'vitest'
import { AgentConfigurationVersionSchema, type PendingNativeInteraction } from '@foreman-code/contracts'
import type { AgentChatTurn, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import {
  AGENT_CHAT_OPEN_TURN_LIMIT, agentChatInputHash, agentChatKey, PostgresAgentChatRepository, type AgentConversationRow,
} from '../src/modules/conversations/agentChatRepository.js'
import { AgentChatF5Native, approval, eventually } from './helpers/agentChatF5.js'
import { deferred } from './helpers/deferred.js'

const context = { workspaceId: 'ws-f5', workflowId: 'wf-f5', workflowNodeId: 'node-f5', agentId: 'agent-f5' }
const { workspaceId, ...query } = context
const now = new Date('2026-09-27T00:00:00.000Z')
const principal: ManagementPrincipal = { id: 'owner-f5', name: 'F5 fixture', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ scope: { workspaceIds: [workspaceId], workflowIds: [context.workflowId] },
    actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:respond', 'agent_chat:cancel'] }] }
const configuration = AgentConfigurationVersionSchema.parse({ id: 'cfg-f5', workspaceId, agentId: context.agentId, version: 1,
  productRole: 'coder', harness: { harness: 'codex', model: 'fixture-no-native', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
  prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt: now.toISOString() })
function row(): AgentConversationRow {
  return { id: 'chat-f5', agent_key: agentChatKey(context), workspace_id: workspaceId, workflow_id: context.workflowId,
    workflow_node_id: context.workflowNodeId, agent_id: context.agentId, agent_configuration_version_id: configuration.id,
    origin_run_id: null, origin_execution_id: null, harness: 'codex', provider_version: 'f5-fixture', native_session_id: 'native-f5',
    active_request_id: 'active-f5', active_native_turn_id: 'turn-f5', cancel_requested: false, turn_state: 'active', last_error: null,
    revision: 1, pending_interaction: null, last_result: null, created_at: now, updated_at: now,
    record: { origin: { kind: 'fresh' }, workingDirectory: process.cwd(), runtimeDirectory: '/unused-f5', startupDelivered: true } }
}
function request(requestId = 'new-f5', intent: SendAgentChatMessageRequest['intent'] = 'next_turn'): SendAgentChatMessageRequest {
  return { requestId, context: query, content: `Message ${requestId}`, intent, expectedConversationId: 'chat-f5' }
}
function receipt(input = request(), sequence = 1, delivery: AgentChatTurn['delivery'] = 'queued') {
  return { request_id: input.requestId, turn_sequence: String(sequence), intent: input.intent, delivery,
    message_id: `message-${input.requestId}`, native_turn_id: null, target_native_turn_id: null, delivery_error: null,
    input_hash: agentChatInputHash(input), payload: { content: input.content }, created_at: now, updated_at: now }
}

function approvalFixture() {
  const current = row()
  const native = new AgentChatF5Native()
  native.pendingRequests.push(approval(native.session, native.nativeTurnId, 'approval-a'), approval(native.session, native.nativeTurnId, 'approval-b'))
  current.pending_interaction = native.pendingRequests[0]!
  const writes: Array<string | undefined> = []
  const dispatchAttempts: string[] = []
  const repository = {
    get: async () => structuredClone(current), byKey: async () => structuredClone(current),
    state: async (): Promise<NonNullable<Awaited<ReturnType<PostgresAgentChatRepository['state']>>>> => ({
      row: structuredClone(current), turns: [], messages: [], hasEarlierMessages: false,
      selection: null, activeStartedAt: now, latestRequestId: 'active-f5', unfinishedActivities: [],
      activityPage: { activities: [], nextCursor: null, itemRevisions: {} } }),
    turnContent: async () => 'Fixture turn',
    turnSessionMode: async () => undefined,
    turnPrincipalId: async () => principal.id,
    abandon: async (_id: string, _requestId: string, message: string) => {
      if (current.active_request_id !== _requestId) return
      current.turn_state = 'uncertain'
      current.last_error = message
    },
    accepted: async (_id: string, _requestId: string, nativeTurnId: string) => { current.active_native_turn_id = nativeTurnId; return true },
    pending: async (_id: string, requestId: string, pending: PendingNativeInteraction | undefined) => {
      if (current.active_request_id !== requestId) return
      current.pending_interaction = pending ?? null
      writes.push(pending?.turn.nativeRequestId)
    },
    finish: async () => { current.active_request_id = null; current.pending_interaction = null; current.turn_state = 'idle'; return true },
  }
  const workflows = {
    getCurrentSavedVersion: async () => ({ definition: { nodes: [{ id: context.workflowNodeId, agentId: context.agentId }] } }),
    getAgentConfiguration: async () => configuration,
  }
  const controls = memorySessionControlPool()
  const pool = { query: async (text: string, values: unknown[]) => {
    if (text.includes('conversation_session_') || text.includes('as compaction')) {
      return controls.query(text, values)
    }
    if (text.includes('from agents')) return { rows:
      values[0] === workspaceId && values[1] === context.agentId
        ? [{ current_configuration_version_id: configuration.id }] : [] }
    if (text !== 'select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals where id=$1 for share') {
      throw new Error(`Unscripted approval fixture query: ${text}`)
    }
    const rows = values[0] === principal.id ? [{ id: principal.id, name: principal.name, audience: principal.audience,
      grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : []
    return { rows, rowCount: rows.length }
  } } as unknown as pg.Pool
  const service = new AgentChatService(pool,
    repository as unknown as PostgresAgentChatRepository, {} as ConstructorParameters<typeof AgentChatService>[2],
    workflows as unknown as ConstructorParameters<typeof AgentChatService>[3], {} as ConstructorParameters<typeof AgentChatService>[4],
    () => { throw new Error('No native creation is allowed in this unit fixture.') }, '/unused-f5')
  ;(service as unknown as { commands: { execute: (...args: unknown[]) => Promise<unknown>; drain: () => Promise<void> } }).commands = {
    execute: async (...args: unknown[]) => (args[5] as (markDispatchAttempt: () => void) => Promise<unknown>)(
      () => { dispatchAttempts.push(String(args[3])) }), drain: async () => undefined,
  }
  const internals = service as unknown as {
    runtimes: Map<string, { manager: AgentChatF5Native; session: AgentChatF5Native['session']; configuration: typeof configuration }>
    runTurn(id: string, turn: AgentChatTurn): Promise<void>
  }
  internals.runtimes.set(current.id, { manager: native, session: native.session, configuration })
  const respond = (id: string) => service.respond(principal, workspaceId, current.id,
    { requestId: `reply-${id}`, nativeRequestId: id, optionId: 'approve-once' })
  const read = () => service.readConversation(principal, workspaceId, current.id)
  const run = () => internals.runTurn(current.id, { requestId: 'active-f5', sequence: '1', intent: 'next_turn', delivery: 'accepted',
    messageId: 'message-active', createdAt: now.toISOString(), updatedAt: now.toISOString() })
  return { current, native, service, writes, dispatchAttempts, respond, read, run }
}

/** Scripted SQL boundary: verifies the real repository's decisions/query shape, not PostgreSQL execution. */
function sqlFixture(openCount: number, prior?: ReturnType<typeof receipt>, stateRows: Array<ReturnType<typeof receipt>> = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const querySql = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    calls.push({ sql, values })
    if (['begin', 'commit', 'rollback', 'begin isolation level repeatable read read only'].includes(sql)
      || sql.startsWith('select pg_advisory_xact_lock')) return { rows: [], rowCount: 0 }
    if (sql === 'select archived_at from workspaces where id = $1 for share') {
      const rows = values[0] === workspaceId ? [{ archived_at: null }] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith("select c.record->>'workingDirectory' as path,")) {
      const current = row()
      const rows = values[0] === current.id ? [{ path: current.record.workingDirectory, host_kind: 'main' }] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith('select record from conversation_session_controls')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('select * from operator_conversations')) return { rows: [row()], rowCount: 1 }
    if (sql.startsWith('select count(*)::text as count')) return { rows: [{ count: String(openCount) }], rowCount: 1 }
    if (sql.startsWith('select request_id,') && sql.includes('request_id=$2')) return { rows: prior ? [prior] : [], rowCount: prior ? 1 : 0 }
    if (sql.startsWith('insert into operator_conversation_messages')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('insert into operator_conversation_turns')) {
      return { rows: [receipt({ ...request(String(values[1]), values[4] as SendAgentChatMessageRequest['intent']),
        content: (JSON.parse(String(values[2])) as { content: string }).content }, openCount + 1, values[5] as AgentChatTurn['delivery'])], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversations set revision=')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('with candidates as materialized ( select r.principal_id,r.operation,r.command_id')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('with open as (')) return { rows: stateRows, rowCount: stateRows.length }
    if (sql.startsWith('with candidates as (')) return { rows: [{ messages: [], has_earlier: false }], rowCount: 1 }
    if (sql.startsWith('select record,sequence::text')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('select (select started_at from operator_conversation_turns')) return {
      rows: [{ started_at: null, latest_request_id: stateRows.at(-1)?.request_id ?? null }], rowCount: 1,
    }
    throw new Error(`Unexpected SQL in F5 fixture: ${sql}`)
  }
  const pool = { query: querySql, connect: async () => ({ query: querySql, release() {} }) } as unknown as pg.Pool
  const repository = new PostgresAgentChatRepository(pool)
  const admit = (input = request(), delivery: 'queued' | 'submitting' = 'queued') =>
    repository.admit({ key: agentChatKey(context), context, request: input, delivery })
  return { calls, repository, admit }
}

describe('F5 / A-R11 pending approval handoff', () => {
  it('exposes every already-pending approval and an approval arriving during a reply, without another event', async () => {
    const f = approvalFixture()
    const entered = deferred(), release = deferred()
    f.native.beforeResponse = async () => { entered.resolve(); await release.promise }
    const first = f.respond('approval-a')
    await entered.promise
    f.native.pendingRequests.push(approval(f.native.session, f.native.nativeTurnId, 'approval-c'))
    release.resolve()
    assert.equal((await first).pendingInteraction?.turn.nativeRequestId, 'approval-b')
    assert.equal((await f.read()).sessionState, 'waiting_approval')
    assert.equal((await f.respond('approval-b')).pendingInteraction?.turn.nativeRequestId, 'approval-c')
    assert.equal((await f.respond('approval-c')).pendingInteraction, undefined)
    assert.deepEqual(f.native.responses, ['approval-a', 'approval-b', 'approval-c'])
    assert.deepEqual(f.dispatchAttempts, ['reply-approval-a', 'reply-approval-b', 'reply-approval-c'])
    assert.deepEqual(f.writes, ['approval-b', 'approval-c', undefined])
    assert.equal(f.native.pendingCalls, 3)
    await f.service.shutdown()
  })

  it('re-reads the pending identity after a competing reply finishes under the control lock', async () => {
    const f = approvalFixture()
    const entered = deferred(), release = deferred()
    f.native.beforeResponse = async () => { entered.resolve(); await release.promise }
    const first = f.respond('approval-a')
    await entered.promise
    const duplicate = assert.rejects(f.respond('approval-a'), { code: 'AGENT_CHAT_INTERACTION_NOT_PENDING' })
    release.resolve()
    await Promise.all([first, duplicate])
    assert.deepEqual(f.native.responses, ['approval-a'])
    assert.equal((await f.read()).pendingInteraction?.turn.nativeRequestId, 'approval-b')
    await f.service.shutdown()
  })

  it('serializes a stale event observation with replies so it cannot overwrite the next pending request', async () => {
    const f = approvalFixture()
    const observed = deferred(), release = deferred()
    f.native.beforePendingReturn = async () => { observed.resolve(); await release.promise }
    const running = f.run()
    await f.native.started.promise
    f.native.offer('approval-c')
    await observed.promise // Event lookup has captured A but has not persisted it.
    const reply = f.respond('approval-a')
    try {
      await new Promise<void>((done) => setImmediate(done))
      assert.deepEqual(f.native.responses, [], 'The reply must wait for the earlier pending observation.')
      release.resolve()
      const state = await reply
      assert.equal(state.pendingInteraction?.turn.nativeRequestId, 'approval-b')
      assert.equal((await f.respond('approval-b')).pendingInteraction?.turn.nativeRequestId, 'approval-c')
      assert.equal((await f.respond('approval-c')).pendingInteraction, undefined)
    } finally {
      release.resolve()
      f.native.finish()
      await Promise.allSettled([reply, running])
      await f.service.shutdown()
    }
  })

  it('keeps an event arriving during native response delivery ordered after the handoff', async () => {
    const f = approvalFixture()
    const running = f.run()
    await f.native.started.promise
    const entered = deferred(), release = deferred()
    f.native.beforeResponse = async () => { entered.resolve(); await release.promise }
    const reply = f.respond('approval-a')
    await entered.promise
    f.native.offer('approval-c')
    try {
      await new Promise<void>((done) => setImmediate(done))
      assert.equal(f.native.pendingCalls, 0, 'The event observation must not race the in-flight response.')
      release.resolve()
      assert.equal((await reply).pendingInteraction?.turn.nativeRequestId, 'approval-b')
      await eventually(() => f.native.pendingCalls >= 2)
      assert.equal((await f.read()).pendingInteraction?.turn.nativeRequestId, 'approval-b')
      assert.equal((await f.respond('approval-b')).pendingInteraction?.turn.nativeRequestId, 'approval-c')
      await f.respond('approval-c')
      assert.deepEqual(f.native.responses, ['approval-a', 'approval-b', 'approval-c'])
    } finally {
      release.resolve()
      f.native.finish()
      await Promise.allSettled([reply, running])
      await f.service.shutdown()
    }
  })

  it('retains the active-request fence if the turn settles during response delivery', async () => {
    const f = approvalFixture()
    f.native.beforeResponse = async () => { f.current.active_request_id = null; f.current.pending_interaction = null; f.current.turn_state = 'idle' }
    const state = await f.respond('approval-a')
    assert.equal(state.pendingInteraction, undefined)
    assert.deepEqual(f.writes, [])
    await f.service.shutdown()
  })

  it('rejects denied responders and invalid options without native delivery or pending-state changes', async () => {
    const f = approvalFixture()
    const before = structuredClone(f.current)
    const denied: ManagementPrincipal = { ...principal, grants: [{ scope: {}, actions: ['agent_chat:read'] }] }
    await assert.rejects(f.service.respond(denied, workspaceId, f.current.id,
      { requestId: 'denied-reply', nativeRequestId: 'approval-a', optionId: 'approve-once' }), { code: 'ACCESS_DENIED' })
    await assert.rejects(f.service.respond(principal, workspaceId, f.current.id,
      { requestId: 'invalid-reply', nativeRequestId: 'approval-a', optionId: 'not-offered' }),
      { code: 'AGENT_CHAT_INTERACTION_OPTION_INVALID' })
    assert.deepEqual(f.current, before)
    assert.deepEqual(f.native.responses, [])
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.dispatchAttempts, [])
    await f.service.shutdown()
  })
})

describe('F5 / A-R15 bounded open receipts', () => {
  for (const intent of ['next_turn', 'steer', 'interrupt_and_send'] as const) {
    it(`rejects an excess ${intent} before inserting any message or receipt`, async () => {
      const f = sqlFixture(100)
      await assert.rejects(f.admit(request('overflow', intent), intent === 'steer' ? 'submitting' : 'queued'),
        { code: 'AGENT_CHAT_CAPACITY_EXCEEDED', status: 409 })
      assert.equal(f.calls.some((call) => call.sql.startsWith('insert ')), false)
      assert.equal(f.calls.at(-1)?.sql, 'rollback')
      const lock = f.calls.findIndex((call) => call.sql.startsWith('select pg_advisory_xact_lock'))
      const count = f.calls.findIndex((call) => call.sql.startsWith('select count(*)'))
      assert.ok(lock >= 0 && count > lock)
      assert.deepEqual(f.calls[count]!.values, ['chat-f5', ['queued', 'submitting', 'accepted', 'unknown']])
    })
  }

  it('admits the 100th open receipt after the locked count check', async () => {
    const f = sqlFixture(99)
    const result = await f.admit()
    assert.equal(result.replayed, false)
    assert.equal(result.turn.sequence, '100')
    assert.equal(f.calls.filter((call) => call.sql.startsWith('insert ')).length, 2)
    assert.ok(f.calls.findIndex((call) => call.sql.startsWith('select count(*)'))
      < f.calls.findIndex((call) => call.sql.startsWith('insert ')))
  })

  it('preserves exact replay and conflict behavior at capacity without another count or insert', async () => {
    const input = request('already-admitted')
    const f = sqlFixture(100, receipt(input))
    assert.equal((await f.admit(input)).replayed, true)
    await assert.rejects(f.admit({ ...input, content: 'changed' }), { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    assert.equal(f.calls.some((call) => call.sql.startsWith('insert ') || call.sql.startsWith('select count(*)')), false)
  })

  it('reserves state slots for all open deliveries before adding recent terminal receipts', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => receipt(request(`open-${index}`), index + 1,
      (['queued', 'submitting', 'accepted', 'unknown'] as const)[index % 4]!))
    const f = sqlFixture(100, undefined, rows)
    const state = await f.repository.state('chat-f5')
    assert.equal(f.calls[0]?.sql, 'begin isolation level repeatable read read only')
    assert.equal(f.calls.at(-1)?.sql, 'commit')
    assert.deepEqual(state?.turns.map((turn) => turn.requestId), rows.map((turn) => turn.request_id))
    const selection = f.calls.find((call) => call.sql.startsWith('with open as ('))!
    assert.deepEqual(selection.values, ['chat-f5', ['queued', 'submitting', 'accepted', 'unknown'], 100])
    assert.match(selection.sql, /limit \$3::int \+ 1/)
    assert.match(selection.sql, /least\(50, greatest\(0, \$3::int - \(select count\(\*\) from open\)\)\)/)
    assert.match(selection.sql, /select \* from open union all select \* from recent/)
    assert.match(selection.sql, /order by turn_sequence::bigint$/)
    assert.equal(AGENT_CHAT_OPEN_TURN_LIMIT, 100)
  })

  it('reports pre-existing overflow instead of silently dropping a 101st open receipt', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => receipt(request(`legacy-${index}`), index + 1))
    const f = sqlFixture(101, undefined, rows)
    await assert.rejects(f.repository.state('chat-f5'), { code: 'AGENT_CHAT_RECEIPT_OVERFLOW', status: 409 })
  })
})
