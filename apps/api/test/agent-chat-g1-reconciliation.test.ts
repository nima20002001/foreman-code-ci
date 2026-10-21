import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, vi } from 'vitest'
import type pg from 'pg'
import type { AgentConfigurationVersion, ExecutionResult, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import type { AgentChatContext, AgentChatTurn, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository, type AgentConversationRow } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeSteerInput, NativeSteerReceipt, NativeTurnInput } from '../src/modules/harnesses/port.js'

const now = new Date('2026-09-27T00:00:00Z')
const context: AgentChatContext = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'native-session' }
const principal: ManagementPrincipal = { id: 'g1-reader', name: 'G1 reader', audience: 'operator', revokedAt: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [context.workspaceId], workflowIds: [context.workflowId] } }] }
const sender: ManagementPrincipal = { ...principal, id: 'chat-sender', name: 'Chat sender',
  grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: principal.grants[0]!.scope }] }
const pool = { query: async (sql: string, values: unknown[] = []) => {
  const authority = [principal, sender].find(candidate => candidate.id === values[0])
  return { rows: sql.includes('from management_principals') && authority
    ? [{ id: authority.id, name: authority.name, audience: authority.audience, grants: authority.grants,
      expires_at: new Date(authority.expiresAt), revoked_at: null, delegated_from: null }] : [], rowCount: 0 }
} } as unknown as pg.Pool
const terminalDeliveries = new Set(['completed', 'failed', 'canceled'])
function receipt(requestId: string, delivery: AgentChatTurn['delivery'] = 'unknown', sequence = '1'): AgentChatTurn {
  return { requestId, sequence, intent: 'next_turn', delivery, messageId: `message-${requestId}`, createdAt: now.toISOString(), updatedAt: now.toISOString() }
}
function row(): AgentConversationRow {
  return { id: 'conversation', agent_key: agentChatKey(context), workspace_id: context.workspaceId, workflow_id: context.workflowId,
    workflow_node_id: context.workflowNodeId, agent_id: context.agentId, agent_configuration_version_id: 'configuration',
    origin_run_id: null, origin_execution_id: null, harness: 'codex', provider_version: session.providerVersion,
    native_session_id: session.nativeSessionId, active_request_id: 'first', active_native_turn_id: null, cancel_requested: false,
    turn_state: 'uncertain', last_error: null, revision: 1, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: tmpdir(), runtimeDirectory: '' }, created_at: now, updated_at: now }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function eventually(check: () => boolean) {
  await vi.waitFor(() => assert.ok(check(), 'recovery did not make progress'), { interval: 1, timeout: 3_500 })
}

/** Storage fixture for SERVICE control-flow tests; real repository SQL boundaries are tested separately. */
class MemoryRepository extends PostgresAgentChatRepository {
  row = row()
  storedReceipts = [receipt('first')]
  recovered = 0
  bound = 0
  bindGate?: ReturnType<typeof gate>
  bindFailure = false
  finishes: string[] = []
  acknowledgedSteers: string[] = []
  constructor() { super(pool) }
  override async get() { return structuredClone(this.row) }
  override async byKey() { return this.get() }
  override async open() { return [await this.get()] }
  override async state() { return { row: await this.get(), turns: structuredClone(this.storedReceipts), messages: [], hasEarlierMessages: false,
    activeStartedAt: null, latestRequestId: this.storedReceipts.at(-1)?.requestId ?? null, selection: null,
    unfinishedActivities: [], activityPage: { activities: [], nextCursor: null, itemRevisions: {} } } }
  override async restoreUnsettled() {
    this.recovered++
    if (!this.row.active_request_id) {
      const unresolved = this.storedReceipts.find((entry) => entry.intent !== 'steer' && ['submitting', 'accepted', 'unknown'].includes(entry.delivery))
      if (unresolved) { this.row.active_request_id = unresolved.requestId; this.row.active_native_turn_id = unresolved.nativeTurnId ?? null }
    }
    return this.get()
  }
  override async unconfirmedSteers() {
    return this.storedReceipts.filter((entry) => entry.intent === 'steer' && ['submitting', 'unknown'].includes(entry.delivery)).map((entry) => ({
      requestId: entry.requestId, targetNativeTurnId: entry.targetNativeTurnId ?? null,
      delivery: entry.delivery === 'submitting' ? 'submitting' as const : 'unknown' as const,
      targetRequestId: this.storedReceipts.find((target) => target.intent !== 'steer' && target.nativeTurnId === entry.targetNativeTurnId)?.requestId ?? null,
    }))
  }
  override async turn(_id: string, requestId: string) { return structuredClone(this.storedReceipts.find((entry) => entry.requestId === requestId)) }
  override async turnContent(_id: string, requestId: string) { return `content-${requestId}` }
  override async nextQueued() {
    return structuredClone(this.storedReceipts.filter((entry) => entry.delivery === 'queued')
      .sort((a, b) => Number(b.intent === 'interrupt_and_send') - Number(a.intent === 'interrupt_and_send') || Number(a.sequence) - Number(b.sequence))[0])
  }
  override async claim(_id: string, requestId: string) {
    if (this.row.active_request_id || this.row.record.sessionUnavailable || this.storedReceipts.some((entry) => entry.intent !== 'steer' && ['submitting', 'accepted', 'unknown'].includes(entry.delivery))) return false
    const entry = this.storedReceipts.find((item) => item.requestId === requestId && item.delivery === 'queued')
    if (!entry) return false
    entry.delivery = 'submitting'; this.row.active_request_id = requestId; this.row.active_native_turn_id = null
    this.row.cancel_requested = false; this.row.turn_state = 'starting'
    return true
  }
  override async admit(input: Parameters<PostgresAgentChatRepository['admit']>[0]) {
    assert.equal(input.request.intent, 'steer', 'this fixture admits only the steer under test')
    const prior = this.storedReceipts.find((entry) => entry.requestId === input.request.requestId)
    const entry = prior ?? { ...receipt(input.request.requestId, input.delivery, String(this.storedReceipts.length + 1)),
      intent: 'steer' as const, targetNativeTurnId: input.targetNativeTurnId! }
    if (!prior) this.storedReceipts.push(entry)
    return { conversationId: this.row.id, turn: structuredClone(entry), replayed: Boolean(prior), created: false }
  }
  override async beginSessionCreation(_id: string, requestId: string) {
    if (this.row.native_session_id || this.row.record.sessionCreation) return false
    this.row.record.sessionCreation = { requestId }; return true
  }
  override async bindSession(_id: string, providerVersion: string, nativeSessionId: string) {
    this.bound++
    await this.bindGate?.promise
    if (this.bindFailure) throw new Error('binding commit failed')
    this.row.provider_version = providerVersion; this.row.native_session_id = nativeSessionId
  }
  override async markStartupDelivered() { this.row.record.startupDelivered = true }
  override async markSessionUnavailable(_id: string, reason: string) { this.row.record.sessionUnavailable = reason }
  override async accepted(_id: string, requestId: string, nativeTurnId: string) {
    if (this.row.active_request_id !== requestId) return false
    assert.ok(!this.row.active_native_turn_id || this.row.active_native_turn_id === nativeTurnId)
    const entry = this.storedReceipts.find((item) => item.requestId === requestId)!
    entry.delivery = 'accepted'; entry.nativeTurnId = nativeTurnId
    this.row.active_native_turn_id = nativeTurnId; this.row.record.startupDelivered = true
    this.row.turn_state = this.row.cancel_requested ? 'canceling' : 'active'
    return true
  }
  override async steerAccepted(_id: string, requestId: string, nativeTurnId: string) {
    this.acknowledgedSteers.push(requestId)
    const entry = this.storedReceipts.find((item) => item.requestId === requestId)!
    assert.equal(entry.targetNativeTurnId, nativeTurnId)
    const target = this.storedReceipts.find((item) => item.intent !== 'steer' && item.nativeTurnId === nativeTurnId)
    entry.delivery = target && terminalDeliveries.has(target.delivery) ? target.delivery : 'accepted'
    entry.nativeTurnId = nativeTurnId
  }
  override async unknown(_id: string, requestId: string) {
    const entry = this.storedReceipts.find((item) => item.requestId === requestId)!
    if (['submitting', 'accepted'].includes(entry.delivery)) entry.delivery = 'unknown'
    if (this.row.active_request_id === requestId) this.row.turn_state = 'uncertain'
  }
  override async abandon(id: string, requestId: string) { await this.unknown(id, requestId) }
  override async requestCancel() { this.row.cancel_requested = true; this.row.turn_state = 'canceling'; return true }
  override async interrupt() {
    await this.cancelQueued()
    if (!this.row.active_request_id) return undefined
    await this.requestCancel()
    return { requestId: this.row.active_request_id, nativeTurnId: this.row.active_native_turn_id }
  }
  override async cancelQueued(_id?: string, requestId?: string) {
    const queued = this.storedReceipts.filter((entry) => entry.delivery === 'queued' && (!requestId || entry.requestId === requestId))
    for (const entry of queued) entry.delivery = 'canceled'
    return queued.length
  }
  override async pending(_id: string, requestId: string, pending: PendingNativeInteraction | undefined) {
    if (this.row.active_request_id === requestId) this.row.pending_interaction = pending ?? null
  }
  override async finish(_id: string, requestId: string, result: ExecutionResult) {
    if (this.row.active_request_id !== requestId) return false
    const delivery = result.outcome === 'succeeded' ? 'completed' : result.outcome
    this.storedReceipts.find((entry) => entry.requestId === requestId)!.delivery = delivery
    for (const steer of this.storedReceipts.filter((entry) => entry.intent === 'steer' && entry.delivery === 'accepted' && entry.nativeTurnId === this.row.active_native_turn_id)) steer.delivery = delivery
    this.finishes.push(requestId)
    this.row.active_request_id = null; this.row.active_native_turn_id = null; this.row.cancel_requested = false
    this.row.turn_state = 'idle'; this.row.last_result = result; this.row.pending_interaction = null
    return true
  }
}
class NativeFixture implements NativeHarnessSessionManager {
  readonly harness: 'codex'
  starts: NativeTurnInput[] = []
  attachments: NativeSessionStart[] = []
  cancellations: Array<{ session: string; turn: string | undefined }> = []
  histories = new Map<string, NativeHistory>()
  steerEvidence: NativeSteerReceipt[] = []
  steerReads: Array<readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[]> = []
  created = 0; forked = 0; steered = 0; disposed = 0
  createGate?: ReturnType<typeof gate>
  loseCreation = false
  loseStartAck = false
  hideHistory = false
  hideSteerEvidence = true
  steerReadFailure = false
  cancelFailures = 0
  complete = new Set<string>()
  constructor(harness: 'codex' = 'codex') { this.harness = harness }
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession() {
    this.created++; await this.createGate?.promise
    if (this.loseCreation) throw new Error('accepted creation; response lost')
    return { ...session, harness: this.harness }
  }
  async forkSession() { this.forked++; await this.createGate?.promise; return { ...session, harness: this.harness } }
  async attachSession(reference: NativeSessionReference, input: NativeSessionStart) { this.attachments.push(input); return reference }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.starts.push(input)
    const requestId = input.clientCorrelationId.split(':').at(-1)!
    this.histories.set(input.clientCorrelationId, proof(requestId, this.complete.has(requestId) ? { outcome: 'succeeded' } : undefined))
    if (this.loseStartAck) throw new Error('native start accepted; acknowledgement lost')
    await input.onSubmitted?.(`native-${requestId}`)
    yield* [] // The fixture has no stream; only independently supplied history settles it.
  }
  async steerTurn(_session: NativeSessionReference, input: NativeSteerInput): Promise<{ nativeTurnId: string }> {
    this.steered++
    this.steerEvidence.push({ nativeSessionId: session.nativeSessionId, nativeTurnId: input.expectedTurnId, correlationId: input.clientCorrelationId })
    throw new Error('native steer accepted; acknowledgement lost')
  }
  async reconcileSteers(_session: NativeSessionReference, inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[]) {
    this.steerReads.push(structuredClone(inputs))
    if (this.steerReadFailure) throw new Error('steer history read failed')
    return this.hideSteerEvidence ? [] : structuredClone(this.steerEvidence)
  }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    return this.hideHistory ? { events: [], pendingInteractions: [] } : structuredClone(this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] })
  }
  async history() { return { events: [], pendingInteractions: [] } }
  async pending() { return undefined }
  async respond() {}
  async cancel(reference: NativeSessionReference, _signal?: AbortSignal, nativeTurnId?: string) {
    this.cancellations.push({ session: reference.nativeSessionId, turn: nativeTurnId })
    if (this.cancelFailures-- > 0) throw new Error('cancel transport failed')
    return true // Never manufactures terminal proof from the cancellation ACK.
  }
  async close() {}
  async dispose() { this.disposed++ }
}
function proof(requestId = 'first', terminalResult?: ExecutionResult): NativeHistory {
  const correlationId = agentChatCorrelation('conversation', requestId)
  const nativeTurnId = `native-${requestId}`
  return { correlationId, nativeTurnId, events: [], pendingInteractions: [],
    ...(terminalResult ? { terminalResult, terminalTurn: { correlationId, providerId: nativeTurnId, result: terminalResult } } : {}) }
}
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(repository = new MemoryRepository(), native = new NativeFixture()) {
  repository.row.harness = native.harness
  const root = await mkdtemp(join(tmpdir(), 'agent-chat-g1-'))
  const configuration = { id: 'configuration', harness: { harness: native.harness }, prompt: { system: 'SYSTEM' }, assignedSkills: [], resolvedSkills: [] } as unknown as AgentConfigurationVersion
  const workflows = { getAgentConfiguration: async () => configuration,
    getSavedVersion: async () => ({ definition: { nodes: [{ id: 'node', agentId: 'agent' }] } }),
    getCurrentSavedVersion: async () => ({ definition: { nodes: [{ id: 'node', agentId: 'agent' }] } }) } as unknown as ConstructorParameters<typeof AgentChatService>[3]
  const runs = {
    getForWorkspace: async () => ({ workflowVersionId: 'source-version' }),
  } as unknown as ConstructorParameters<typeof AgentChatService>[4]
  const service = new AgentChatService(pool, repository, {} as PostgresOperatorConversationRepository,
    workflows, runs, () => native, root)
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { service, repository, native, configuration, internal: service as unknown as Internals }
}
interface Internals {
  reconciliationTimers: Map<string, ReturnType<typeof setTimeout>>
  runTurn(id: string, turn: AgentChatTurn): Promise<void>
  interruptActive(id: string, explicit: boolean, target: { requestId: string; nativeTurnId: string | null } | undefined): Promise<void>
  repair(id: string): Promise<void>
}

// These tests target the authorized service's lifecycle seam; HTTP/MCP authorization is not replaced or claimed here.
describe('G1 cancellation and reconciliation', () => {
  it('A2-PF-01 delivers Stop after lost start ACK and holds urgent/FIFO work until terminal proof', async () => {
    const f = await fixture()
    f.repository.storedReceipts[0]!.delivery = 'submitting'
    f.native.loseStartAck = true; f.native.hideHistory = true
    await f.internal.runTurn('conversation', f.repository.storedReceipts[0]!)
    assert.equal(f.repository.storedReceipts[0]!.delivery, 'unknown')
    await f.repository.requestCancel()
    f.repository.storedReceipts.push(receipt('ordinary', 'queued', '2'), { ...receipt('urgent', 'queued', '3'), intent: 'interrupt_and_send' })
    await f.internal.interruptActive('conversation', false, { requestId: 'first', nativeTurnId: null })
    assert.deepEqual(f.native.cancellations, [])
    f.native.hideHistory = false
    await f.service.recover()
    assert.deepEqual(f.native.cancellations, [{ session: session.nativeSessionId, turn: 'native-first' }])
    assert.equal(f.repository.row.cancel_requested, true)
    assert.equal(f.repository.row.active_request_id, 'first')
    assert.deepEqual(f.native.starts.map((entry) => entry.clientCorrelationId), [agentChatCorrelation('conversation', 'first')])
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'queued')
    assert.equal(f.repository.storedReceipts[2]!.delivery, 'queued')
    f.native.loseStartAck = false; f.native.complete.add('ordinary'); f.native.complete.add('urgent')
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), proof('first', { outcome: 'canceled' }))
    await f.service.recover()
    await eventually(() => f.repository.storedReceipts.every((entry) => terminalDeliveries.has(entry.delivery)))
    assert.deepEqual(f.native.starts.map((entry) => entry.clientCorrelationId.split(':').at(-1)), ['first', 'urgent', 'ordinary'])
    assert.deepEqual(f.repository.finishes, ['first', 'urgent', 'ordinary'])
    assert.equal(f.native.created, 0)
  })

  it('A2-PF-01 replays persisted cancellation after restart, not the control command or prompt', async () => {
    const f = await fixture()
    f.repository.row.active_native_turn_id = 'native-first'; f.repository.row.cancel_requested = true
    f.repository.storedReceipts.push(receipt('queued', 'queued', '2'))
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), proof())
    f.native.cancelFailures = 1
    await f.service.recover()
    assert.equal(f.repository.row.cancel_requested, true)
    assert.equal(f.repository.row.active_request_id, 'first')
    await f.service.recover()
    assert.deepEqual(f.native.cancellations.map((entry) => entry.turn), ['native-first', 'native-first'])
    assert.equal(f.native.attachments.length, 1)
    assert.equal(f.native.attachments[0]!.nativeTurnId, 'native-first')
    assert.deepEqual(f.native.starts, [])
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'queued')
  })

  it('A2-PF-01 never applies a captured old cancellation to a later owner', async () => {
    const f = await fixture()
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), proof())
    await f.service.recover()
    f.repository.row.active_request_id = 'later'; f.repository.row.active_native_turn_id = 'native-later'; f.repository.row.cancel_requested = true
    await f.internal.interruptActive('conversation', false, { requestId: 'first', nativeTurnId: 'native-first' })
    assert.deepEqual(f.native.cancellations, [])
    assert.equal(f.repository.row.active_request_id, 'later')
    assert.equal(f.repository.row.cancel_requested, true)
  })

  it('A2-PF-01 missing or mismatched evidence retains the fence without canceling an unproven turn', async () => {
    const f = await fixture()
    f.repository.row.active_native_turn_id = 'native-first'; f.repository.row.cancel_requested = true
    for (const history of [{ events: [], pendingInteractions: [] }, proof('other'), { ...proof(), nativeTurnId: 'native-other' },
      { ...proof(), terminalTurn: { correlationId: agentChatCorrelation('conversation', 'first'), providerId: 'native-other', result: { outcome: 'canceled' } as ExecutionResult } }]) {
      f.native.histories.set(agentChatCorrelation('conversation', 'first'), history)
      await f.service.recover()
      assert.equal(f.repository.row.active_request_id, 'first')
      assert.equal(f.repository.row.cancel_requested, true)
    }
    assert.deepEqual(f.native.cancellations, [])
    assert.deepEqual(f.native.starts, [])
  })

  for (const harness of ['codex'] as const) for (const held of ['create', 'bind'] as const) {
    it(`A2-PF-02 Stop during live ${harness} ${held} does not poison successful creation`, async () => {
      const f = await fixture(new MemoryRepository(), new NativeFixture(harness))
      f.repository.row.native_session_id = null; f.repository.row.provider_version = null
      f.repository.storedReceipts[0]!.delivery = 'submitting'
      const hold = gate(); cleanups.push(hold.release)
      if (held === 'create') f.native.createGate = hold
      else f.repository.bindGate = hold
      const running = f.internal.runTurn('conversation', f.repository.storedReceipts[0]!)
      await eventually(() => held === 'create' ? f.native.created === 1 : f.repository.bound === 1)
      await f.internal.interruptActive('conversation', true, await f.repository.interrupt())
      await eventually(() => f.repository.recovered > 0) // Exercise the actual one-second repair timer while held.
      assert.equal(f.repository.row.record.sessionUnavailable, undefined)
      assert.equal(f.repository.row.active_request_id, 'first')
      assert.equal(f.native.created, 1)
      assert.deepEqual(f.native.starts, [])
      hold.release(); await running
      assert.equal(f.repository.row.native_session_id, session.nativeSessionId)
      assert.equal(f.repository.row.record.sessionUnavailable, undefined)
      assert.equal(f.repository.storedReceipts[0]!.delivery, 'canceled')
      assert.deepEqual(f.native.starts, [], 'Stop before submission settles locally; do not send a prompt just to cancel it')
      f.repository.storedReceipts.push(receipt('next', 'queued', '2')); f.native.complete.add('next')
      await f.service.recover(); await eventually(() => f.repository.storedReceipts[1]!.delivery === 'completed')
      assert.equal(f.native.created, 1, 'continuation uses the successfully bound session')
      assert.equal(f.native.starts.length, 1)
    })
  }

  it('A2-PF-02 also defers recovery during a live Run-origin fork/bind without replacing the source', async () => {
    const f = await fixture()
    f.repository.row.native_session_id = null; f.repository.row.provider_version = null
    f.repository.row.record.origin = { kind: 'run_execution', runId: 'run', executionId: 'source-execution', sourceNativeSessionId: 'source-session' }
    const hold = gate(); f.repository.bindGate = hold; cleanups.push(hold.release)
    const running = f.internal.runTurn('conversation', f.repository.storedReceipts[0]!)
    await eventually(() => f.repository.bound === 1)
    await f.internal.interruptActive('conversation', true, await f.repository.interrupt())
    await f.internal.repair('conversation')
    assert.equal(f.repository.row.record.sessionUnavailable, undefined)
    hold.release(); await running
    assert.equal(f.native.forked, 1); assert.equal(f.native.created, 0)
    assert.equal(f.repository.row.native_session_id, session.nativeSessionId)
    assert.equal(f.repository.row.record.startupDelivered, true)
    assert.equal(f.repository.storedReceipts[0]!.delivery, 'canceled')
    assert.deepEqual(f.native.starts, [])
  })

  it('A2-PF-02 drains a live binding before disposing its native owner on shutdown', async () => {
    const f = await fixture()
    f.repository.row.native_session_id = null; f.repository.row.provider_version = null
    const hold = gate(); f.repository.bindGate = hold; cleanups.push(hold.release)
    const running = f.internal.runTurn('conversation', f.repository.storedReceipts[0]!)
    await eventually(() => f.repository.bound === 1)
    let stopped = false
    const shutdown = f.service.shutdown().then(() => { stopped = true })
    // Drain shutdown's immediate fixture work while binding remains held.
    await setImmediate()
    assert.equal(stopped, false); assert.equal(f.native.disposed, 0)
    hold.release(); await running; await shutdown
    assert.equal(f.native.disposed, 1)
    assert.deepEqual(f.native.starts, [])
  })

  for (const fault of ['lost-creation', 'failed-binding'] as const) {
    it(`A2-PF-02 still fences actual ${fault}, including a cold recovery`, async () => {
      const f = await fixture()
      f.repository.row.native_session_id = null; f.repository.row.provider_version = null
      f.native.loseCreation = fault === 'lost-creation'; f.repository.bindFailure = fault === 'failed-binding'
      await f.internal.runTurn('conversation', f.repository.storedReceipts[0]!)
      assert.equal(f.repository.row.record.sessionUnavailable, undefined)
      assert.equal(f.repository.storedReceipts[0]!.delivery, 'unknown')
      assert.equal(f.repository.row.active_request_id, 'first')
      await f.service.shutdown()
      const restarted = await fixture(f.repository)
      await restarted.service.recover()
      assert.match(f.repository.row.record.sessionUnavailable!, /read-only/)
      assert.equal(restarted.native.created, 0)
      assert.deepEqual(restarted.native.starts, [])
    })
  }

  it('polls a lost steer acknowledgement after its target completes through the public send service', async () => {
    const f = await fixture()
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), proof())
    await f.service.recover()
    // Isolate the send path from the bootstrap poll; no recovery is invoked after this setup.
    for (const timer of f.internal.reconciliationTimers.values()) clearTimeout(timer)
    f.internal.reconciliationTimers.clear()
    const input: SendAgentChatMessageRequest = { requestId: 'steer', intent: 'steer', content: 'clarify',
      context: { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }, expectedConversationId: 'conversation', expectedNativeTurnId: 'native-first' }
    await assert.rejects(f.service.send(principal, context.workspaceId, input), { code: 'ACCESS_DENIED' })
    assert.equal(f.native.steered, 0)
    const result = await f.service.send(sender, context.workspaceId, input)
    assert.equal(result.turn.delivery, 'unknown')
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'unknown')
    f.native.histories.set(agentChatCorrelation('conversation', 'first'), proof('first', { outcome: 'succeeded' }))
    const read = () => f.service.read(sender, context.workspaceId, input.context)
    await vi.waitFor(async () => {
      const state = await read()
      assert.equal(state.activeTurn, null)
      assert.equal(state.turns.find(turn => turn.requestId === 'first')?.delivery, 'completed')
      assert.equal(state.turns.find(turn => turn.requestId === 'steer')?.delivery, 'unknown',
        'target completion alone is not a steer receipt')
    }, { interval: 1, timeout: 3_500 })
    f.native.hideSteerEvidence = false
    await vi.waitFor(async () => {
      const state = await read()
      assert.equal(state.activeTurn, null)
      assert.equal(state.turns.find(turn => turn.requestId === 'steer')?.delivery, 'completed')
    }, { interval: 1, timeout: 3_500 })
    assert.deepEqual(f.repository.acknowledgedSteers, ['steer'])
    assert.equal(f.native.steered, 1)
    assert.deepEqual(f.native.starts, [])
  })

  for (const delivery of ['completed', 'failed', 'canceled'] as const) {
    it(`A2-PF-05 cold steer-only recovery uses the original ${delivery} target and never owns a turn`, async () => {
      const f = await fixture()
      f.repository.row.active_request_id = null
      f.repository.storedReceipts[0] = { ...receipt('first', delivery), nativeTurnId: 'native-first' }
      f.repository.storedReceipts.push({ ...receipt('steer', 'unknown', '2'), intent: 'steer', targetNativeTurnId: 'native-first' })
      f.native.hideSteerEvidence = false
      f.native.steerEvidence = [{ nativeSessionId: session.nativeSessionId, nativeTurnId: 'native-first', correlationId: agentChatCorrelation('conversation', 'steer') }]
      await f.service.recover()
      assert.equal(f.repository.storedReceipts[1]!.delivery, delivery)
      assert.equal(f.repository.row.active_request_id, null)
      assert.equal(f.native.attachments[0]!.correlationId, agentChatCorrelation('conversation', 'first'))
      assert.equal(f.native.attachments[0]!.nativeTurnId, 'native-first')
      assert.equal(f.native.created, 0); assert.equal(f.native.steered, 0)
      assert.deepEqual(f.native.starts, [])
    })
  }

  it('A2-PF-05 settles an old unknown steer without retargeting a later active request', async () => {
    const f = await fixture()
    f.repository.storedReceipts = [{ ...receipt('first', 'completed'), nativeTurnId: 'native-first' },
      { ...receipt('steer', 'unknown', '2'), intent: 'steer', targetNativeTurnId: 'native-first' },
      { ...receipt('later', 'accepted', '3'), nativeTurnId: 'native-later' }]
    f.repository.row.active_request_id = 'later'; f.repository.row.active_native_turn_id = 'native-later'
    f.native.histories.set(agentChatCorrelation('conversation', 'later'), proof('later'))
    f.native.hideSteerEvidence = false
    f.native.steerEvidence = [{ nativeSessionId: session.nativeSessionId, nativeTurnId: 'native-first', correlationId: agentChatCorrelation('conversation', 'steer') }]
    await f.service.recover()
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'completed')
    assert.equal(f.repository.row.active_request_id, 'later'); assert.equal(f.repository.row.active_native_turn_id, 'native-later')
    assert.equal(f.native.attachments[0]!.correlationId, agentChatCorrelation('conversation', 'later'))
    assert.deepEqual(f.native.steerReads, [[{ clientCorrelationId: agentChatCorrelation('conversation', 'steer'), expectedTurnId: 'native-first' }]])
    assert.deepEqual(f.native.cancellations, []); assert.deepEqual(f.native.starts, [])
  })

  it('A2-PF-05 a failed old-steer lookup does not downgrade independently proven active delivery', async () => {
    const f = await fixture()
    f.repository.storedReceipts = [{ ...receipt('first', 'completed'), nativeTurnId: 'native-first' },
      { ...receipt('steer', 'unknown', '2'), intent: 'steer', targetNativeTurnId: 'native-first' },
      { ...receipt('later', 'accepted', '3'), nativeTurnId: 'native-later' }]
    f.repository.row.active_request_id = 'later'; f.repository.row.active_native_turn_id = 'native-later'
    f.native.histories.set(agentChatCorrelation('conversation', 'later'), proof('later'))
    f.native.steerReadFailure = true
    await f.service.recover()
    assert.equal(f.native.steerReads.length, 1)
    assert.equal(f.repository.storedReceipts[1]!.delivery, 'unknown')
    assert.equal(f.repository.storedReceipts[2]!.delivery, 'accepted')
    assert.equal(f.repository.row.active_request_id, 'later'); assert.equal(f.repository.row.turn_state, 'active')
    assert.equal(f.repository.row.record.sessionUnavailable, undefined)
    assert.deepEqual(f.native.starts, [])
  })

  it('A2-PF-05 rejects wrong session, correlation and target, including a provisional crash-left steer', async () => {
    const f = await fixture()
    f.repository.row.active_request_id = null
    f.repository.storedReceipts[0] = { ...receipt('first', 'completed'), nativeTurnId: 'native-first' }
    f.repository.storedReceipts.push({ ...receipt('steer', 'submitting', '2'), intent: 'steer', targetNativeTurnId: 'native-first' })
    const exact = { nativeSessionId: session.nativeSessionId, nativeTurnId: 'native-first', correlationId: agentChatCorrelation('conversation', 'steer') }
    f.native.hideSteerEvidence = false
    for (const evidence of [[], [{ ...exact, nativeSessionId: 'other' }], [{ ...exact, correlationId: agentChatCorrelation('conversation', 'first') }], [{ ...exact, nativeTurnId: 'other' }]]) {
      f.native.steerEvidence = evidence; await f.service.recover()
      assert.equal(f.repository.storedReceipts[1]!.delivery, 'unknown')
      assert.equal(f.repository.row.active_request_id, null)
    }
    assert.deepEqual(f.repository.acknowledgedSteers, [])
    assert.equal(f.native.steered, 0)
    assert.deepEqual(f.native.starts, [])
  })
})
