import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type pg from 'pg'
import type { AgentConfigurationVersion, ExecutionResult, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import type { AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, PostgresAgentChatRepository, type AgentConversationRow } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import type { NativeNonSubmission } from '../src/modules/conversations/nativeNonSubmission.js'

const now = new Date('2026-09-27T00:00:00Z')
const session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'native-session' }
function conversation(): AgentConversationRow {
  return { id: 'conversation', agent_key: 'key', workspace_id: 'workspace', workflow_id: 'workflow', workflow_node_id: 'node', agent_id: 'agent',
    agent_configuration_version_id: 'configuration', origin_run_id: null, origin_execution_id: null, harness: 'codex', provider_version: 'fixture',
    native_session_id: session.nativeSessionId, active_request_id: 'first', active_native_turn_id: 'native-first', cancel_requested: false,
    turn_state: 'uncertain', last_error: null, revision: 1, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: tmpdir(), runtimeDirectory: '', startupDelivered: false }, created_at: now, updated_at: now }
}
function receipt(requestId: string, delivery: AgentChatTurn['delivery'] = 'unknown'): AgentChatTurn {
  return { requestId, sequence: requestId === 'first' ? '1' : '2', intent: 'next_turn', delivery, messageId: `message-${requestId}`,
    createdAt: now.toISOString(), updatedAt: now.toISOString() }
}
const unusedPool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool

/** Service tests substitute storage and provider I/O; SQL-boundary tests below use the real repository methods. */
class MemoryRepository extends PostgresAgentChatRepository {
  row = conversation()
  storedReceipts = [receipt('first'), receipt('queued', 'queued')]
  bindFailure = false
  constructor() { super(unusedPool) }
  override async get() { return structuredClone(this.row) }
  override async open() { return [await this.get()] }
  override async restoreUnsettled() { return this.get() }
  override async turn(_id: string, requestId: string) { return this.storedReceipts.find((turn) => turn.requestId === requestId) }
  override async turnContent(_id: string, requestId: string) { return `content-${requestId}` }
  override async nextQueued() { return this.storedReceipts.find((turn) => turn.delivery === 'queued') }
  override async claim(_id: string, requestId: string) {
    if (this.row.active_request_id || this.row.record.sessionUnavailable || this.storedReceipts.some((turn) => ['submitting', 'accepted', 'unknown'].includes(turn.delivery))) return false
    const turn = this.storedReceipts.find((entry) => entry.requestId === requestId && entry.delivery === 'queued')
    if (!turn) return false
    this.row.active_request_id = requestId; this.row.active_native_turn_id = null; turn.delivery = 'submitting'
    return true
  }
  override async beginSessionCreation(_id: string, requestId: string) {
    if (this.row.record.sessionCreation || this.row.native_session_id) return false
    this.row.record.sessionCreation = { requestId }; return true
  }
  override async bindSession(_id: string, providerVersion: string, nativeSessionId: string) {
    if (this.bindFailure) throw new Error('bind transaction failed')
    this.row.native_session_id = nativeSessionId; this.row.provider_version = providerVersion
  }
  override async recordNonSubmission(_id: string, requestId: string, operation: NativeNonSubmission['operation'],
    result: ExecutionResult) {
    if (this.row.active_request_id !== requestId || this.row.active_native_turn_id
      || operation === 'session_creation' && this.row.native_session_id) return false
    if (result.outcome === 'succeeded') throw new Error('Non-submission cannot have a successful native result.')
    this.row.record.nativeNonSubmission = { requestId, operation, result }
    return true
  }
  override async markStartupDelivered() { this.row.record.startupDelivered = true }
  override async markSessionUnavailable(_id: string, reason: string) { this.row.record.sessionUnavailable = reason }
  override async accepted(_id: string, requestId: string, nativeTurnId: string) {
    if (this.row.active_request_id !== requestId) return false
    assert.ok(!this.row.active_native_turn_id || this.row.active_native_turn_id === nativeTurnId)
    const turn = this.storedReceipts.find((entry) => entry.requestId === requestId)!
    turn.delivery = 'accepted'; turn.nativeTurnId = nativeTurnId
    this.row.active_native_turn_id = nativeTurnId
    this.row.record.startupDelivered = true
    this.row.record.startupReceipt ??= { requestId, nativeSessionId: this.row.native_session_id! }
    return true
  }
  override async unknown(_id: string, requestId: string) {
    const turn = this.storedReceipts.find((entry) => entry.requestId === requestId)!
    if (['submitting', 'accepted'].includes(turn.delivery)) turn.delivery = 'unknown'
    this.row.turn_state = 'uncertain'
  }
  override async abandon(id: string, requestId: string) { await this.unknown(id, requestId) }
  override async pending(_id: string, _requestId: string, pending: PendingNativeInteraction | undefined) { this.row.pending_interaction = pending ?? null }
  override async requestCancel() { this.row.cancel_requested = true; return true }
  override async finish(_id: string, requestId: string, result: ExecutionResult) {
    if (this.row.active_request_id !== requestId) return false
    this.storedReceipts.find((entry) => entry.requestId === requestId)!.delivery = result.outcome === 'succeeded' ? 'completed' : result.outcome
    this.row.active_request_id = null; this.row.active_native_turn_id = null; this.row.cancel_requested = false
    return true
  }
}
class NativeFixture implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  requiresSettledDisposal() { return true }
  histories = new Map<string, NativeHistory>()
  attached: NativeSessionStart[] = []
  prompts: NativeTurnInput[] = []
  created = 0; canceled = 0; reconciled = 0; disposed = 0
  loseCreation = false
  historyFailure = false
  loseTurnAcknowledgement = false
  holdStream = false
  releaseStream?: () => void
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture', persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession() {
    this.created++
    if (this.loseCreation) throw new Error('native create accepted; response lost')
    return { ...session, harness: this.harness }
  }
  async attachSession(reference: NativeSessionReference, input: NativeSessionStart) { this.attached.push(input); return reference }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.prompts.push(input)
    const nativeTurnId = `native-${input.clientCorrelationId.split(':').at(-1)}`
    this.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId, events: [], pendingInteractions: [],
      terminalResult: { outcome: 'succeeded', output: { text: 'answer' } }, nativeMessageId: `answer-${nativeTurnId}` })
    if (this.loseTurnAcknowledgement) throw new Error('native turn accepted; acknowledgement lost')
    await input.onSubmitted?.(nativeTurnId)
    if (this.holdStream && input.clientCorrelationId.endsWith(':first')) {
      delete this.histories.get(input.clientCorrelationId)!.terminalResult
      await new Promise<void>((resolve) => {
        this.releaseStream = resolve
        signal?.addEventListener('abort', resolve.bind(null, undefined), { once: true })
      })
    }
    // No streamed event: only the exact terminal history is authoritative in this fixture.
    yield* []
  }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    this.reconciled++
    if (this.historyFailure) throw new Error('native history temporarily unavailable')
    const history = this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] }
    if (history.terminalResult) this.releaseStream?.() // The real Codex adapter wakes its stream on synchronized terminal history.
    return history
  }
  async history() { return { events: [], pendingInteractions: [] } }
  async pending() { return undefined }
  async respond() {}
  async cancel() { this.canceled++; return true }
  async close() {}
  async dispose() { this.disposed++ }
}
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.useRealTimers()
  }
})
async function makeService(repository = new MemoryRepository(), native = new NativeFixture()) {
  const root = await mkdtemp(join(tmpdir(), 'agent-chat-f2-'))
  const configuration = { id: 'configuration', harness: { harness: native.harness }, prompt: { system: 'SYSTEM' }, assignedSkills: [], resolvedSkills: [] } as unknown as AgentConfigurationVersion
  const workflows = { getAgentConfiguration: async () => configuration } as unknown as ConstructorParameters<typeof AgentChatService>[3]
  const service = new AgentChatService(unusedPool, repository, {} as PostgresOperatorConversationRepository,
    workflows, {} as ConstructorParameters<typeof AgentChatService>[4], () => native, root)
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { service, repository, native }
}
type Internals = {
  runTurn(id: string, turn: AgentChatTurn): Promise<void>
  interruptActive(id: string, explicit: boolean, target: { requestId: string; nativeTurnId: string | null }): Promise<void>
}
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'reconciliation did not make progress')
    await vi.advanceTimersByTimeAsync(1_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
function terminal(nativeTurnId = 'native-first'): NativeHistory {
  return { correlationId: agentChatCorrelation('conversation', 'first'), nativeTurnId, events: [], pendingInteractions: [],
    terminalResult: { outcome: 'succeeded', output: { text: 'exact recovered answer' } }, nativeMessageId: 'answer-first' }
}

describe('F2 Agent chat native recovery', () => {
  it('A-R07 repairs a lost acknowledgement after history recovers, without restart or resend', async () => {
    const f = await makeService()
    f.repository.row.active_native_turn_id = null
    f.repository.storedReceipts[0]!.delivery = 'submitting'
    f.native.loseTurnAcknowledgement = true
    f.native.historyFailure = true
    await (f.service as unknown as Internals).runTurn('conversation', f.repository.storedReceipts[0]!)
    await f.service.recover()
    assert.equal(f.repository.row.active_request_id, 'first')
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'queued')
    assert.equal(f.native.disposed, 0, 'the manager owning the late acknowledgement must remain alive')
    f.native.historyFailure = false; f.native.loseTurnAcknowledgement = false
    await eventually(() => f.repository.storedReceipts.every((turn) => turn.delivery === 'completed'))
    assert.deepEqual(f.native.prompts.map((input) => input.clientCorrelationId),
      [agentChatCorrelation('conversation', 'first'), agentChatCorrelation('conversation', 'queued')])
    assert.equal(f.native.created, 0)
  })

  it('A-R07 settles a silent interrupt from history before queued work proceeds', async () => {
    const f = await makeService()
    f.repository.row.active_request_id = null; f.repository.row.active_native_turn_id = null
    f.repository.storedReceipts[0]!.delivery = 'queued'; f.native.holdStream = true
    await f.service.recover()
    await eventually(() => Boolean(f.native.releaseStream))
    f.repository.row.cancel_requested = true
    await (f.service as unknown as Internals).interruptActive('conversation', false,
      { requestId: 'first', nativeTurnId: f.repository.row.active_native_turn_id })
    assert.equal(f.native.canceled, 1)
    assert.equal(f.repository.row.active_request_id, 'first')
    assert.equal(f.repository.row.cancel_requested, true)
    assert.deepEqual(f.native.prompts.map((input) => input.prompt), ['content-first'])
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), { ...terminal(), terminalResult: { outcome: 'canceled' } })
    await eventually(() => f.repository.storedReceipts[1]!.delivery === 'completed')
    assert.equal(f.repository.storedReceipts[0]!.delivery, 'canceled')
    assert.deepEqual(f.native.prompts.map((input) => input.prompt), ['content-first', 'content-queued'])
  })

  for (const fault of ['creation-response-lost', 'bind-transaction-failed'] as const) {
    it(`A-R08 fences ${fault} durably and never creates a replacement`, async () => {
      const repository = new MemoryRepository()
      repository.row.native_session_id = null; repository.row.provider_version = null; repository.row.active_native_turn_id = null
      repository.storedReceipts[0]!.delivery = 'submitting'
      const native = new NativeFixture(); native.loseCreation = fault === 'creation-response-lost'
      repository.bindFailure = fault === 'bind-transaction-failed'
      const f = await makeService(repository, native)
      await (f.service as unknown as Internals).runTurn('conversation', repository.storedReceipts[0]!)
      assert.equal(native.created, 1)
      assert.deepEqual(repository.row.record.sessionCreation, { requestId: 'first' })
      assert.equal(repository.row.record.sessionUnavailable, undefined)
      assert.equal(repository.storedReceipts[0]!.delivery, 'unknown')
      assert.equal(repository.row.active_request_id, 'first')
      if (fault === 'bind-transaction-failed') {
        await assert.rejects(f.service.shutdown(), /cleanup was incomplete/)
        assert.equal(native.disposed, 0, 'unconfirmed creation still owns its native manager')
      } else await f.service.shutdown()
      const restarted = await makeService(repository, new NativeFixture())
      await restarted.service.recover()
      assert.match(repository.row.record.sessionUnavailable!, /read-only/)
      assert.equal(restarted.native.created, 0)
      assert.equal(restarted.native.prompts.length, 0)
      assert.equal(repository.storedReceipts[1]!.delivery, 'queued')
      repository.storedReceipts.push(receipt('later', 'queued'))
      await restarted.service.recover()
      assert.equal(restarted.native.created, 0)
      if (fault === 'bind-transaction-failed') {
        repository.bindFailure = false
        await repository.bindSession('conversation', session.providerVersion, session.nativeSessionId)
        native.histories.set(agentChatCorrelation('conversation', 'first'), {
          events: [], pendingInteractions: [], nonSubmission: { nativeSessionId: session.nativeSessionId,
            clientCorrelationId: agentChatCorrelation('conversation', 'first'), result: { outcome: 'failed' } },
        })
        await f.service.shutdown()
        assert.equal(native.disposed, 1)
        assert.equal(native.created, 1)
        assert.equal(native.prompts.length, 0)
        assert.equal(repository.storedReceipts[0]!.delivery, 'failed')
        assert.equal(repository.storedReceipts[1]!.delivery, 'queued')
      }
    })
  }

  it('A-R08 blocks a pre-existing creation intent even when no unavailable flag was committed', async () => {
    const f = await makeService()
    f.repository.row.native_session_id = null; f.repository.row.provider_version = null
    f.repository.row.record.sessionCreation = { requestId: 'first' }
    await f.service.recover()
    assert.equal(f.native.created, 0)
    assert.match(f.repository.row.record.sessionUnavailable!, /read-only/)
  })

  for (const delivery of ['submitting', 'accepted'] as const) {
    it(`A-R10 repairs startup delivery after the ${delivery} acknowledgement boundary`, async () => {
      const repository = new MemoryRepository()
      repository.storedReceipts[0]!.delivery = delivery
      const f = await makeService(repository, new NativeFixture())
      f.native.histories.set(agentChatCorrelation('conversation', 'first'), terminal())
      await f.service.recover()
      await eventually(() => repository.storedReceipts[1]!.delivery === 'completed')
      assert.equal(repository.row.record.startupDelivered, true)
      assert.deepEqual(repository.row.record.startupReceipt, { requestId: 'first', nativeSessionId: session.nativeSessionId })
      assert.deepEqual(f.native.prompts.map((input) => input.prompt), ['content-queued'])
      assert.equal(f.native.attached[0]?.kind, 'agent-chat')
      const attached = f.native.attached[0]!
      assert.equal('instructionsDelivered' in attached && attached.instructionsDelivered, true)
    })
  }

  it('A-R20 attaches with the stored native turn even when correlation items are absent', async () => {
    const f = await makeService(); f.repository.storedReceipts.splice(1)
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), terminal())
    await f.service.recover()
    assert.equal(f.native.attached[0]?.nativeTurnId, 'native-first')
    assert.equal(f.repository.storedReceipts[0]!.delivery, 'completed')
    assert.equal(f.native.prompts.length, 0)
  })

  for (const mismatch of ['native-turn', 'terminal-turn', 'correlation'] as const) {
    it(`A-R20 rejects mismatched ${mismatch} evidence without losing its original fence`, async () => {
      const f = await makeService()
      const history = terminal(mismatch === 'native-turn' ? 'other-turn' : 'native-first')
      if (mismatch === 'correlation') history.correlationId = 'other-correlation'
      if (mismatch === 'terminal-turn') history.terminalTurn = { correlationId: history.correlationId!, providerId: 'other-turn', result: { outcome: 'succeeded' } }
      f.native.histories.set(agentChatCorrelation('conversation', 'first'), history)
      await f.service.recover()
      assert.equal(f.repository.row.active_native_turn_id, 'native-first')
      assert.equal(f.repository.row.active_request_id, 'first')
      assert.equal(f.repository.storedReceipts[0]!.delivery, 'unknown')
      assert.equal(f.repository.storedReceipts[1]!.delivery, 'queued')
      assert.equal(f.native.prompts.length, 0)
      assert.equal(f.repository.row.record.startupDelivered, false)
      await assert.rejects(f.service.shutdown(), /cleanup was incomplete/)
      assert.equal(f.native.disposed, 0)
      f.native.histories.set(agentChatCorrelation('conversation', 'first'), terminal())
      await f.service.shutdown()
      assert.equal(f.repository.storedReceipts[0]!.delivery, 'completed')
      assert.equal(f.repository.storedReceipts[1]!.delivery, 'queued')
      assert.equal(f.native.prompts.length, 0)
      assert.equal(f.native.disposed, 1)
    })
  }
})

/** Scripted SQL boundary, not a PostgreSQL emulator or proof of live transaction semantics. */
function sqlFixture() {
  const row = conversation()
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const messages: Array<{ record: Record<string, unknown>; sequence: string }> = []
  let orphan = false
  let failurePattern: string | undefined
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values })
    if (failurePattern && sql.includes(failurePattern)) throw new Error('injected SQL failure')
    if (orphan && sql.startsWith('select request_id,turn_sequence')) return { rows: [{ request_id: 'first', native_turn_id: 'native-first' }], rowCount: 1 }
    if (sql.includes('set active_request_id=$2,active_native_turn_id=$3')) {
      row.active_request_id = String(values[1]); row.active_native_turn_id = String(values[2])
    }
    if (sql.includes('select * from operator_conversations')) return { rows: [structuredClone(row)], rowCount: 1 }
    if (sql.replace(/\s+/g, ' ').trim().startsWith('select (select started_at from operator_conversation_turns')) {
      assert.deepEqual(values, [row.id, row.active_request_id])
      return { rows: [{ started_at: null, latest_request_id: 'first' }], rowCount: 1 }
    }
    if (sql.startsWith('select 1 from operator_conversation_messages')) return { rows: [], rowCount: messages.length ? 1 : 0 }
    if (sql.startsWith('select coalesce(max(sequence)')) return { rows: [{ sequence: '0' }], rowCount: 1 }
    if (sql.startsWith('insert into operator_conversation_messages')) messages.push({ record: JSON.parse(String(values[4])), sequence: '1' })
    if (sql.includes('set active_request_id=null')) { row.active_request_id = null; row.active_native_turn_id = null }
    if (sql.startsWith('select record,sequence::text from operator_conversation_messages')) return { rows: messages, rowCount: messages.length }
    if (sql.startsWith('with candidates as (')) return { rows: [{ messages: messages.map((entry) => entry.record), has_earlier: false, next_cursor: null }], rowCount: 1 }
    if (sql.startsWith('select * from (')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 1 }
  }
  const client = { query, release() {} }
  const pool = { query, connect: async () => client } as unknown as pg.Pool
  return { repository: new PostgresAgentChatRepository(pool), row, queries, messages,
    orphan: () => { orphan = true }, fail: (pattern: string) => { failurePattern = pattern } }
}

describe('F2 durable SQL boundaries', () => {
  it('A-R07 unknown retains native ownership, cancellation and pending interaction', async () => {
    const f = sqlFixture(); f.row.cancel_requested = true
    f.row.pending_interaction = { turn: { nativeRequestId: 'approval' } } as PendingNativeInteraction
    await f.repository.abandon('conversation', 'first', 'history is temporarily missing')
    assert.equal(f.row.active_request_id, 'first')
    assert.equal(f.row.active_native_turn_id, 'native-first')
    assert.equal(f.row.cancel_requested, true)
    assert.equal(f.row.pending_interaction?.turn.nativeRequestId, 'approval')
    assert.ok(f.queries.some(({ sql }) => sql.includes("delivery='unknown'")))
    assert.ok(!f.queries.some(({ sql }) => /active_request_id=null|pending_interaction=null|cancel_requested=false/.test(sql)))
    await f.repository.open()
    assert.ok(f.queries.at(-1)!.sql.includes("('queued','submitting','accepted','unknown')"))
  })

  it('A-R07 restores an orphan receipt before claiming queued work and retains cancellation', async () => {
    const f = sqlFixture(); f.row.active_request_id = null; f.row.active_native_turn_id = null; f.row.cancel_requested = true; f.orphan()
    const restored = await f.repository.restoreUnsettled('conversation')
    assert.equal(restored?.active_request_id, 'first')
    assert.equal(restored?.active_native_turn_id, 'native-first')
    assert.equal(restored?.cancel_requested, true)
    assert.equal(await f.repository.claim('conversation', 'queued'), false)
    assert.ok(!f.queries.some(({ sql }) => sql.includes("set delivery='submitting'")))
  })

  it('A-R07 blocks a queue claim even before an orphan receipt is restored', async () => {
    const f = sqlFixture(); f.row.active_request_id = null; f.row.active_native_turn_id = null
    assert.equal(await f.repository.claim('conversation', 'queued'), false)
    assert.ok(f.queries.some(({ sql }) => sql.includes("intent <> 'steer' and delivery in ('submitting','accepted','unknown')")))
    assert.ok(!f.queries.some(({ sql }) => sql.includes("set delivery='submitting'")))
  })

  it('A-R08 writes creation intent before any native call with an atomic no-replacement guard', async () => {
    const f = sqlFixture()
    await f.repository.beginSessionCreation('conversation', 'first')
    assert.match(f.queries[0]!.sql, /active_request_id=\$2 and native_session_id is null/)
    assert.match(f.queries[0]!.sql, /not \(record \? 'sessionCreation'\)/)
    assert.deepEqual(f.queries[0]!.values, ['conversation', 'first'])
  })

  it('A-R09 commits a recovered answer once with terminal settlement and exposes it in state/history', async () => {
    const f = sqlFixture()
    const result: ExecutionResult = { outcome: 'succeeded', output: { text: 'exact\nrecovered answer' } }
    assert.equal(await f.repository.finish('conversation', 'first', result, 'native-answer'), true)
    assert.equal(await f.repository.finish('conversation', 'first', result, 'native-answer'), false)
    assert.equal(f.messages.length, 1)
    assert.equal(f.messages[0]!.record.nativeMessageId, 'native-answer')
    assert.equal(f.messages[0]!.record.content, 'exact\nrecovered answer')
    const insert = f.queries.findIndex(({ sql }) => sql.startsWith('insert into operator_conversation_messages'))
    const clear = f.queries.findIndex(({ sql }) => sql.includes('set active_request_id=null'))
    const commit = f.queries.findIndex(({ sql }) => sql === 'commit')
    assert.ok(insert > 0 && insert < clear && clear < commit)
    const state = (await f.repository.state('conversation'))!
    assert.equal(state.activeStartedAt, null); assert.equal(state.latestRequestId, 'first')
    assert.deepEqual(state.messages.map((message) => message.content), ['exact\nrecovered answer'])
    assert.deepEqual((await f.repository.history('conversation', undefined, 100)).messages.map((message) => message.content), ['exact\nrecovered answer'])
  })

  it('A-R10 commits startup receipt and turn acceptance in the same transaction', async () => {
    const f = sqlFixture()
    await f.repository.accepted('conversation', 'first', 'native-first')
    assert.equal(f.queries[0]!.sql, 'begin')
    const startup = f.queries.findIndex(({ sql }) => sql.includes("'startupDelivered',true"))
    const acceptance = f.queries.findIndex(({ sql }) => sql.includes("set delivery='accepted'"))
    assert.ok(acceptance > 0 && startup > acceptance)
    assert.match(f.queries[startup]!.sql, /'requestId',\$2::text,'nativeSessionId',native_session_id/)
    assert.equal(f.queries.at(-1)!.sql, 'commit')
  })

  it('A-R10 rolls back receipt acceptance when the startup acknowledgement write fails', async () => {
    const f = sqlFixture(); f.fail("'startupDelivered',true")
    await assert.rejects(() => f.repository.accepted('conversation', 'first', 'native-first'), /injected SQL failure/)
    assert.ok(f.queries.some(({ sql }) => sql.includes("set delivery='accepted'")))
    assert.ok(!f.queries.some(({ sql }) => sql === 'commit'))
    assert.equal(f.queries.at(-1)!.sql, 'rollback')
  })

  it('A-R20 rejects acknowledgement identity drift before either durable write', async () => {
    const f = sqlFixture()
    await assert.rejects(() => f.repository.accepted('conversation', 'first', 'other-turn'), /different turn/)
    assert.equal(f.queries.at(-1)!.sql, 'rollback')
    assert.ok(!f.queries.some(({ sql }) => sql.startsWith('update ')))
  })
})
