import assert from 'node:assert/strict'

import {
  DEFAULT_HARNESS_DEFAULTS,
  type AgentConfigurationVersion,
  type DurableInteraction,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type NativeHarnessEvent,
  type NativeSessionReference,
} from '@foreman-code/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { it, vi } from 'vitest'
import type pg from 'pg'
import { nativeLanes } from './helpers/nativeLanes.js'

import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { DomainError } from '../src/modules/errors.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { rejectableDeferred } from './helpers/deferred.js'
import { idleWorkflowControls, idleWorkflowRepeat } from './helpers/idleWorkflowControls.js'

const now = '2026-09-16T00:00:00.000Z'
const never = () => new Promise<never>(() => undefined)
function configuration(id: string): AgentConfigurationVersion {
  return {
    id: `config-${id}`, workspaceId: 'workspace-1', contentHash: 'sha256:test', agentId: `agent-${id}`, version: 1, createdAt: now,
    harness: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [],
  } as AgentConfigurationVersion
}
function execution(id: string, state: HarnessExecution['state'] = 'waiting'): HarnessExecution {
  return {
    id, runId: 'run-1', workflowNodeId: `node-${id}`, agentId: `agent-${id}`,
    agentConfigurationVersionId: `config-${id}`, workingDirectory: '/project', runtimeDirectory: '/runtime',
    attempt: 1, input: {}, state, createdAt: now,
    ...(state === 'starting' ? {} : { nativeSessionId: `native-${id}` }),
    ...(state === 'completed' ? { result: { outcome: 'canceled' as const }, finishedAt: now } : {}),
  }
}
function interaction(item: HarnessExecution, status: DurableInteraction['status'] = 'pending'): DurableInteraction {
  const decided = status === 'pending' ? {} : {
    selectedOptionId: 'reject', selectedSemantic: 'reject' as const,
    nativeResponse: { decision: 'reject' }, decidedAt: now,
  }
  return {
    id: `interaction-${item.id}`, revision: 4, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: item.runId, executionId: item.id, requestingAgentId: item.agentId,
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: `native-${item.id}`,
    nativeRequestId: `request-${item.id}`, nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: item.runId, request: { command: 'test' }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'reject', semantic: 'reject', label: 'Reject', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    ...decided, status, deliveryState: status === 'delivery_failed' ? 'failed'
      : status === 'delivery_pending' ? 'pending' : 'not_started', createdAt: now, updatedAt: now,
  }
}

class Manager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  cancelImpl = async () => true
  closeImpl: (signal?: AbortSignal) => Promise<void> = async () => undefined
  capabilitiesImpl = async () => ({ provider: this.harness, providerVersion: '0.154.0', persistentSessions: true,
    reconnect: true, sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
    mcpDetection: true, supportedInteractionKinds: ['approval'] })
  createImpl = async (): Promise<NativeSessionReference> => ({ harness: this.harness, providerVersion: '0.154.0', nativeSessionId: `native-${this.id}` })
  attachImpl = async (session: NativeSessionReference) => session
  turnImpl: (signal?: AbortSignal) => AsyncIterable<NativeHarnessEvent> = async function* () { yield { sequence: 0, type: 'turn.completed', occurredAt: now, payload: {} } }
  pendingValue: ReturnType<typeof interaction> | undefined
  started = false
  constructor(readonly id: string, readonly calls: string[]) {}
  async capabilities() { this.calls.push(`capabilities:${this.id}`); return this.capabilitiesImpl() }
  async inspectMcp(): Promise<never> { throw new Error('not used') }
  async createSession() { this.calls.push(`create:${this.id}`); return this.createImpl() }
  async attachSession(session: NativeSessionReference) { this.calls.push(`attach:${this.id}`); return this.attachImpl(session) }
  startTurn(_session: NativeSessionReference, _input: unknown, signal?: AbortSignal) { this.started = true; return this.turnImpl(signal) }
  async pending() {
    const pending = this.pendingValue
    return pending ? { session: { harness: this.harness, providerVersion: pending.providerVersion, nativeSessionId: pending.nativeSessionId },
      turn: { nativeTurnId: 'turn-1', nativeRequestId: pending.nativeRequestId }, nativeRequestType: pending.nativeRequestType,
      request: pending.request, responseOptions: pending.responseOptions } : undefined
  }
  async respond() { throw new Error('Stop must never deliver a decision') }
  async cancel(session: NativeSessionReference, signal?: AbortSignal) {
    assert.equal(signal?.aborted, false, 'cleanup must have a fresh signal')
    assert.equal(session.nativeSessionId, `native-${this.id}`)
    assert.equal(session.providerVersion, '0.154.0')
    this.calls.push(`cancel:${this.id}`)
    return this.cancelImpl()
  }
  async close(session: NativeSessionReference, signal?: AbortSignal) {
    assert.equal(session.nativeSessionId, `native-${this.id}`)
    this.calls.push(`close:${this.id}`)
    return this.closeImpl(signal)
  }
  async history(): Promise<NativeHistory> {
    const pending = await this.pending()
    return pending ? { events: [], pendingInteractions: [pending] }
      : { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
  }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    if (!this.started) return { events: [], pendingInteractions: [] }
    const history = await this.history()
    return { ...history, correlationId, nativeTurnId: 'turn-1', ...(history.terminalResult ? { terminalTurn: { correlationId, providerId: 'turn-1', result: history.terminalResult } } : {}) }
  }
}

async function fixture(items: HarnessExecution[], cold = false) {
  const calls: string[] = []
  const rows = new Map(items.map((item) => [item.id, item]))
  const managers = new Map(items.map((item) => [item.id, new Manager(item.id, calls)]))
  const pending = new Map<string, DurableInteraction>()
  let stopRequested = false
  const runs = {
    getRepeatSnapshot: async () => ({ run: { executionState: 'running' }, stopRequested, cleanupPending: stopRequested }),
    async *executionPages() { yield [...rows.values()] },
    get: async () => ({ id: 'run-1', workspaceId: 'workspace-1', executionState: 'running' }),
    getExecution: async (id: string) => rows.get(id),
    requestCleanup: async () => { stopRequested = true },
    ...idleWorkflowControls,
    repeat: async () => ({ ...idleWorkflowRepeat, settleNegativeExecution: async () => undefined }),
    listExecutions: async () => { calls.push('list'); return [...rows.values()] },
    getExecutionConfiguration: async (id: string) => configuration(id.slice('config-'.length)),
    ensureExecution: async (item: HarnessExecution) => ({ execution: rows.get(item.id) ?? item, created: !rows.get(item.id)?.nativeSessionId }),
    updateExecution: async (item: HarnessExecution) => {
      rows.set(item.id, item)
      const native = managers.get(item.id)?.pendingValue
      if (native && item.state === 'waiting') pending.set(item.id, native)
    },
    recordActivity: async () => undefined,
    appendNativeEvent: async () => undefined,
    appendNativeEvents: async () => undefined,
  }
  const coordination = nativeLanes()
  for (const item of items) {
    if (!item.nativeSessionId) continue
    await coordination.ensureLane({
      id: `lane-${item.id}`, harness: 'codex', nativeSessionId: item.nativeSessionId,
      ownerAgentId: item.agentId, observedStatus: 'busy', connectionGeneration: 0,
      correlationId: `execution:${item.id}`, currentTurnOrMessageId: 'turn-1',
      observedAt: item.createdAt, revision: 1,
    })
  }
  const interactions = {
    coordination,
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'node-reviewer' }),
    getForExecution: async (id: string) => pending.get(id),
    getNativeRequest: async (id: string) => pending.get(id),
    create: async (item: DurableInteraction) => { pending.set(item.executionId, item); return { interaction: item, created: true } },
    cancelPendingForExecution: async () => undefined,
    cancelPendingForRun: async () => { calls.push('interactions'); return 1 },
  }
  const budgets = { remaining: async () => 60_000, ensure: async () => undefined, assertActive: async () => undefined, beginWait: async () => undefined,
    finish: async () => undefined, resume: async () => undefined,
    stop: async (id: string) => { calls.push(`budget:${id}`) } }
  const credentials = {
    prepare: async () => ({ credential: { principalId: 'fixture-principal', expiresAt: new Date(Date.now() + 900_000).toISOString(), environment: { agentId: 'agent', variables: {} } } }),
    revokeForExecution: async (id: string) => { calls.push(`revoke:${id}`) },
  }
  const rawResolver = new ExecutionScopedNativeSessionManagerResolver((context) => managers.get(context.executionId)!)
  const contextFor = (item: HarnessExecution) => ({ executionId: item.id, runId: item.runId, attempt: item.attempt, agentId: item.agentId,
    harness: 'codex' as const, workingDirectory: '/project', configuration: configuration(item.id) })
  const resolver: NativeSessionManagerResolver = {
    resolve: (context) => rawResolver.resolve(context),
    release: (context, manager, state) => { calls.push(`release:${context.executionId}`); rawResolver.release(context, manager, state) },
  }
  const captures = createWorkflowNativeCaptureChannel()
  const closed = new Map<string, NonNullable<Awaited<ReturnType<WorkflowClosureStore['read']>>>>()
  const closures: WorkflowClosureStore = {
    async recoverDetached() { return undefined },
    async begin(execution) { closed.delete(execution.id); return '1' },
    async record(execution, session, durableGeneration, check) { check(); const proof = { execution, session, durableGeneration }; closed.set(execution.id, proof); return proof },
    async read(execution) { return closed.get(execution.id) },
    async recordDetached(_execution, _session, _generation, check) { check() },
    async recordUnbound(execution, durableGeneration, check) { check(); return { execution: { ...execution,
      workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory! }, durableGeneration } },
    async readUnbound() { return undefined },
  }
  const coordinator = new ApprovalExecutionCoordinator(
    runs as unknown as PostgresRunRepository, interactions as unknown as Wave25InteractionRepository,
    budgets as unknown as PostgresApprovalBudgetRepository, resolver as NativeSessionManagerResolver, 60_000,
    credentials as unknown as ExecutionCredentialProvider, undefined, closures, undefined, captures.capture,
  )
  const launched = new Set<string>()
  const store: RepeatNativeObservationStore = {
    async readExecution(id) { const execution = rows.get(id)!; return { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null },
      slotId: `slot-${id}`, input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
      inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false } },
    async assertExecutionAdmission() {}, async assertNativeBoundary() {},
    async exactSession(id) { return { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: `native-${id}` } },
    async authorizeNativeSubmission() {}, consumeLaunch(id) { if (launched.has(id)) return false; launched.add(id); return true },
    async settleNativeExecution(id) { if (!closed.has(id)) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Original close required', 409) },
  }
  const observe = (item: HarnessExecution, signal = new AbortController().signal) => coordinator.observeExact({
    execution: item, store, owner: { runId: item.runId, client: {}, assertOwned() {} } as RunOwnership, graphThreadId: item.runId,
    workflowId: 'workflow-1', approval: { handler: 'user' }, signal,
    request: { executionId: item.id, runId: item.runId, workspaceId: 'workspace-1', workflowNodeId: item.workflowNodeId,
      workingDirectory: item.workingDirectory!, runtimeDirectory: item.runtimeDirectory!, configuration: configuration(item.id), input: {} } as HarnessExecutionRequest,
  })
  if (!cold) for (const item of items) if (item.nativeSessionId) {
    // Durable records are JSON. Optional keys must be absent, not undefined;
    // the real capture intentionally rejects non-JSON values.
    const waiting: HarnessExecution = { ...item, state: 'waiting' }
    delete waiting.result
    delete waiting.finishedAt
    rows.set(item.id, waiting)
    // Capture the live requester through the real owner-scoped observer. A
    // durable session reference does not, by itself, authorize cold attachment.
    const manager = managers.get(item.id)!
    manager.pendingValue = interaction(item); manager.started = true
    const observed = await observe(rows.get(item.id)!)
    assert.equal(observed.state, 'waiting')
    assert.equal(rawResolver.resolve(contextFor(item)).processState, 'resident')
    manager.pendingValue = undefined; manager.started = false; pending.delete(item.id)
    rows.set(item.id, item)
  }
  calls.length = 0
  return { calls, rows, managers, pending, runs, interactions, budgets, credentials, resolver, coordinator, observe,
    stop: async (runId = 'run-1') => { stopRequested = true; return coordinator.cancelRun(runId) },
  }
}

it('cancels completed database executions that still have resident native sessions (#13)', async () => {
  const f = await fixture([execution('one', 'completed')])
  await f.stop('run-1')
  assert.ok(f.calls.includes('cancel:one'))
  assert.ok(f.calls.includes('budget:one'))
  assert.ok(f.calls.indexOf('close:one') < f.calls.indexOf('release:one'))
  assert.ok(!f.calls.some((call) => call.startsWith('create:') || call.startsWith('attach:')))
})

it('cleans every sibling despite cancellation, close, budget, and credential failures (#23)', async () => {
  const f = await fixture([execution('one'), execution('two'), execution('three')])
  f.managers.get('one')!.cancelImpl = async () => { throw new Error('cancel failed') }
  f.managers.get('one')!.closeImpl = async () => { throw new Error('close failed') }
  f.budgets.stop = async (id) => { f.calls.push(`budget:${id}`); if (id === 'one') throw new Error('budget failed') }
  f.credentials.revokeForExecution = async (id) => { f.calls.push(`revoke:${id}`); if (id === 'one') throw new Error('revoke failed') }
  const error = await f.stop('run-1').catch((value: unknown) => value)
  assert.ok(error instanceof AggregateError)
  assert.ok(error.errors.length >= 4)
  for (const id of ['one', 'two', 'three']) {
    for (const operation of ['cancel', 'close', 'budget', 'revoke']) assert.ok(f.calls.includes(`${operation}:${id}`))
  }
  assert.ok(f.calls.includes('interactions'))
  assert.ok(!f.calls.includes('release:one'), 'unconfirmed native closure must remain supervised')
  assert.deepEqual(f.coordinator.residentRunIds(), ['run-1'])
})

it('a capability failure does not skip sibling cleanup or execution credential revocation', async () => {
  const f = await fixture([execution('one'), execution('two')])
  f.managers.get('one')!.capabilitiesImpl = async () => { throw new Error('capabilities failed') }
  await f.stop('run-1')
  assert.ok(!f.calls.some((call) => call.startsWith('capabilities:')))
  assert.ok(f.calls.includes('close:two'))
  assert.ok(f.calls.includes('revoke:one'))
  assert.ok(f.calls.includes('budget:one'))
})

it('uses the persisted native identity instead of capabilities when canceling a waiting interaction', async () => {
  const item = execution('one')
  const f = await fixture([item])
  f.pending.set(item.id, interaction(item, 'delivery_failed'))
  f.managers.get(item.id)!.capabilitiesImpl = async () => { throw new Error('must not be called') }
  await f.stop(item.runId)
  assert.ok(!f.calls.includes('capabilities:one'))
  assert.ok(f.calls.includes('close:one'))
})

it('bounds a hung native cancel, still closes it, and cancels siblings (#20)', async () => {
  const f = await fixture([execution('one'), execution('two')])
  f.managers.get('one')!.cancelImpl = never
  await assert.rejects(f.stop('run-1'), AggregateError)
  assert.ok(f.calls.includes('close:one'))
  assert.ok(f.calls.indexOf('close:two') < f.calls.indexOf('close:one'))
  assert.ok(f.calls.includes('interactions'))
}, 20_000)

it('retains a timed-out native close for retry instead of evicting the manager', async () => {
  const f = await fixture([execution('one'), execution('two')])
  const closeFinished = rejectableDeferred()
  let closeSignal: AbortSignal | undefined
  f.managers.get('one')!.closeImpl = async signal => {
    assert.ok(signal)
    closeSignal = signal
    await closeFinished.promise
  }
  await assert.rejects(f.stop('run-1'), AggregateError)
  assert.equal(closeSignal?.aborted, true)
  assert.ok(!f.calls.includes('release:one'))
  assert.ok(f.calls.includes('release:two'))
  closeFinished.resolve()
  await f.stop('run-1')
  assert.ok(f.calls.includes('release:one'))
  assert.equal(f.calls.filter(call => call === 'close:one').length, 2)
}, 20_000)

it('passes an execution-owned abort signal to native iteration and cancels before database discovery', async () => {
  const item = execution('one', 'starting')
  const f = await fixture([item])
  const entered = rejectableDeferred<AbortSignal>()
  f.managers.get('one')!.turnImpl = async function* (signal) {
    assert.ok(signal)
    entered.resolve(signal)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted()
    yield { sequence: 0, type: 'unreachable', occurredAt: now, payload: {} }
  }
  const observed = f.observe(item).catch((error: unknown) => error)
  const signal = await entered.promise
  f.runs.executionPages = async function* () { assert.equal(signal.aborted, true); throw new Error('database unavailable'); yield [] }
  await assert.rejects(f.stop(item.runId), /database unavailable/)
  assert.equal(signal.aborted, true)
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.includes('cancel:one'))
  assert.ok(f.calls.includes('close:one'))
  assert.ok(!f.calls.includes('create:two'))
})

it('keeps waiting sessions resident, preserves exact identities, and makes repeated Stop idempotent', async () => {
  const item = execution('one', 'starting')
  const f = await fixture([item])
  f.managers.get('one')!.pendingValue = interaction(item)
  const waiting = await f.observe(item)
  assert.equal(waiting.state, 'waiting')
  assert.deepEqual(f.coordinator.residentRunIds(), [item.runId])
  assert.ok(!f.calls.includes('close:one'))
  // Reproduce the database row becoming terminal before native cleanup.
  f.rows.set(item.id, { ...execution('one', 'completed') })
  await Promise.all([f.stop(item.runId), f.stop(item.runId)])
  await f.stop(item.runId)
  assert.equal(f.calls.filter((call) => call === 'create:one').length, 1)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 1)
  assert.equal(f.pending.get(item.id)?.nativeRequestId, 'request-one')
})

it('does not start replacement native work when Stop finds a nonresident session', async () => {
  const f = await fixture([execution('one')])
  const resolver: NativeSessionManagerResolver = { resolve: () => ({ manager: f.managers.get('one')!, processState: 'needs_start' }), release: () => undefined }
  const coordinator = new ApprovalExecutionCoordinator(f.runs as unknown as PostgresRunRepository,
    f.interactions as unknown as Wave25InteractionRepository, f.budgets as unknown as PostgresApprovalBudgetRepository, resolver, 60_000)
  await assert.rejects(coordinator.cancelRun('run-1'), { code: 'GRAPH_STOP_CONFLICT' })
  assert.ok(!f.calls.some((call) => call.startsWith('create:') || call.startsWith('attach:')))
})

it('closes a session created concurrently with Stop before any turn is started', async () => {
  const item = execution('one', 'starting')
  const f = await fixture([item])
  const creating = rejectableDeferred<void>()
  const opened = rejectableDeferred<NativeSessionReference>()
  const manager = f.managers.get('one')!
  Object.assign(manager, { dispose: async () => {
    f.calls.push('dispose:one')
    await manager.close(await opened.promise)
  } })
  f.managers.get('one')!.createImpl = async () => { creating.resolve(); return opened.promise }
  f.managers.get('one')!.turnImpl = () => { throw new Error('a stopped execution must not start a turn') }
  const observed = f.observe(item).catch((error: unknown) => error)
  await creating.promise
  const stopping = f.stop(item.runId)
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  await stopping
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.includes('dispose:one'))
  assert.ok(f.calls.includes('close:one'))
})

it('Stop cancels every unresolved SQL state including delivery_failed without changing native identity (#31)', async () => {
  const states = ['pending', 'decided', 'delivery_pending', 'delivery_failed'] as const
  const rows = states.map((status, index) => interaction(execution(String(index)), status))
  const updated: DurableInteraction[] = []
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('select id,record')) {
        for (const state of states) assert.ok(sql.includes(`'${state}'`))
        assert.ok(sql.includes('for update'))
        return { rows: rows.map((record) => ({ id: record.id, record })), rowCount: rows.length }
      }
      if (sql.startsWith('update durable_interactions')) updated.push(JSON.parse(values![3] as string) as DurableInteraction)
      return { rows: [], rowCount: 1 }
    }, release: () => undefined,
  }
  const repository = new PostgresInteractionRepository({ connect: async () => client } as unknown as pg.Pool)
  assert.equal(await repository.cancelPendingForRun('run-1'), 4)
  for (const [index, item] of updated.entries()) {
    assert.equal(item.status, 'canceled')
    assert.equal(item.revision, rows[index]!.revision + 1)
    assert.equal(item.nativeRequestId, rows[index]!.nativeRequestId)
    assert.equal(item.nativeSessionId, rows[index]!.nativeSessionId)
  }
})

const settlements = vi.hoisted(() => new Map<unknown, () => Promise<void>>())
vi.mock('../src/modules/runs/workflowLifecycle.js', () => ({
  settleWorkflowRun: async (owner: unknown) => { const settle = settlements.get(owner); assert.ok(settle); await settle() },
  persistWorkflowApprovalWait: async () => { throw new Error('Stop must not rewrite an approval checkpoint') },
}))

/** Engine cancellation composition only. Native physical closure is exercised
 * by the coordinator fixtures above; the settlement repository is a port here. */
function engineFixture(approvals: ApprovalExecutionCoordinator) {
  Object.assign(approvals, { adoptRunOwner: () => undefined, finishRun: async () => undefined, reconcileReviews: async () => undefined, requestColdRunCleanup: async () => false,
    closeForRestart: async () => undefined })
  const f = makeCurrentWorkflowFixture('stop-fixture', 'single'), calls: string[] = []
  let owned = true, stopRequested = false, cleanupPending = false
  let run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, id: 'run-1', executionState: 'waiting',
    authorizationPrincipalId: 'stop-authority', executionLocation: { runnerId: 'runner', rootPath: '/project',
      locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } })
  const connection = new ExclusiveGraphConnection({ query: async (text: string, values: unknown[]) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    assert.match(sql, /^select exists\(/)
    assert.match(sql, /from execution_native_recoveries p join harness_executions e on e.id=p.execution_id/)
    assert.match(sql, /where e.run_id=\$1\) as recovered$/)
    assert.deepEqual(values, [run.id])
    return { rows: [{ recovered: false }], rowCount: 1 }
  } } as unknown as pg.ClientBase, () => { if (!owned) throw new Error('ownership lost') })
  const owner = { runId: run.id, client: {}, oneShotConnection: () => connection, assertOwned() { if (!owned) throw new Error('ownership lost') },
    release: async () => { calls.push('release-owner') } } as unknown as RunOwnership
  const runs = {
    repeatRepositoryFactory() { return {} }, acquireOwnership: async () => owner,
    getRepeatSnapshot: async () => ({ run, version: f.version, configurations: f.configurations, stopRequested, cleanupPending }),
    requestCleanup: async () => { owner.assertOwned(); cleanupPending = true; calls.push('request-cleanup') },
    finishCleanup: async (_id: string, pending: boolean) => { owner.assertOwned(); cleanupPending = pending; calls.push(`cleanup:${pending}`) },
  }
  settlements.set(owner, async () => {
    owner.assertOwned(); assert.ok(stopRequested); calls.push('settle')
    run = { ...run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: now }
  })
  const engine = new LangGraphWorkflowEngine(runs as unknown as PostgresRunRepository,
    {} as PostgresWorkflowRepository, approvals, new MemorySaver(), '/runtime', {} as WorkspaceLocationService,
    {} as ExecutionCredentialProvider, {} as PostgresInteractionRepository)
  const internals = engine as unknown as { activeRuns: Map<string, AbortController>; activeTasks: Map<string, Promise<void>> }
  return { engine, internals, runs, owner, calls, approvals, run: () => run,
    stopFence() { stopRequested = true }, loseOwnership() { owned = false }, cleanupPending: () => cleanupPending }
}

it('requires a committed authorized Stop before canceling native work', async () => {
  const cancelRun = vi.fn(async () => undefined)
  const f = engineFixture({ cancelRun } as unknown as ApprovalExecutionCoordinator)
  await assert.rejects(f.engine.cancel('run-1'), { code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
  assert.equal(cancelRun.mock.calls.length, 0)
  assert.equal(f.run().executionState, 'waiting')
})

it('cancels native sessions before settling an inactive waiting Run (#13)', async () => {
  const events: string[] = []
  const f = engineFixture({ cancelRun: async () => { events.push('native') } } as unknown as ApprovalExecutionCoordinator)
  const settle = settlements.get(f.owner)!
  settlements.set(f.owner, async () => { assert.ok(events.length > 0); await settle() })
  f.stopFence()
  assert.equal(await f.engine.cancel('run-1'), true)
  assert.equal(f.run().outcome, 'canceled')
  assert.equal(f.cleanupPending(), false)
})

it('keeps cleanup pending when native close fails instead of inventing a terminal result (#23)', async () => {
  const f = engineFixture({ cancelRun: async () => { throw new Error('close failed') } } as unknown as ApprovalExecutionCoordinator)
  f.stopFence()
  await assert.rejects(f.engine.cancel('run-1'), /close failed/)
  assert.equal(f.run().executionState, 'waiting')
  assert.equal(f.run().result, undefined)
  assert.equal(f.cleanupPending(), true)
  assert.ok(f.calls.includes('release-owner'))
})

it('restart identifies owner-signal detachment without canceling or settling the execution', async () => {
  const item = execution('restart-signal')
  const f = await fixture([item])
  const attached = await f.coordinator.attachOwnedSession({ executionId: item.id, agentId: item.agentId,
    harness: 'codex', workingDirectory: '/project' }, { harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: `native-${item.id}` })
  const before = structuredClone(f.rows.get(item.id))
  await f.coordinator.closeForRestart()
  assert.equal(attached.signal?.aborted, true)
  assert.equal(attached.signal?.reason.code, 'ENGINE_RESTART')
  assert.deepEqual(f.rows.get(item.id), before)
  assert.ok(!f.calls.some((call) => call.startsWith('cancel:') || call.startsWith('budget:')))
})

it('shutdown preserves waiting Run facts while draining the captured restart boundary', async () => {
  const cancelRun = vi.fn(async () => undefined)
  const f = engineFixture({ cancelRun } as unknown as ApprovalExecutionCoordinator)
  const close = vi.fn(async () => undefined); f.approvals.closeForRestart = close
  await f.engine.shutdown()
  assert.equal(close.mock.calls.length, 1)
  assert.equal(cancelRun.mock.calls.length, 0)
  assert.equal(f.run().executionState, 'waiting')
})

it('shutdown captures original restart closure before abort and drains it before returning', async () => {
  const task = rejectableDeferred<void>(), closure = rejectableDeferred<void>(), aborted = rejectableDeferred<void>(), controller = new AbortController()
  const events: string[] = []
  const cancelRun = vi.fn(async () => undefined)
  const f = engineFixture({ cancelRun } as unknown as ApprovalExecutionCoordinator)
  f.approvals.closeForRestart = async () => {
    // Capture the original transport while it still belongs to the execution.
    // The engine aborts only after capture, not before calling this port.
    events.push('capture')
    assert.equal(controller.signal.aborted, false)
    await closure.promise
    events.push('closed')
    task.resolve()
  }
  controller.signal.addEventListener('abort', () => { events.push('abort'); aborted.resolve() }, { once: true })
  f.internals.activeRuns.set('run-1', controller); f.internals.activeTasks.set('run-1', task.promise)
  let settled = false
  const shutdown = f.engine.shutdown().finally(() => { settled = true })
  try {
    await aborted.promise
    assert.deepEqual(events, ['capture', 'abort'])
    assert.equal(controller.signal.reason.code, 'ENGINE_RESTART')
    await Promise.resolve()
    assert.equal(settled, false, 'abort alone is not a confirmed original transport close')
    closure.resolve()
    await shutdown
    assert.deepEqual(events, ['capture', 'abort', 'closed'])
    assert.equal(cancelRun.mock.calls.length, 0, 'restart must not synthesize Stop')
    assert.equal(f.run().executionState, 'waiting')
    assert.equal(f.run().result, undefined)
    assert.ok(!f.calls.includes('settle'))
  } finally {
    // A failed ordering assertion must not strand the engine drain until its
    // cleanup deadline and obscure the actual assertion with a test timeout.
    closure.resolve(); task.resolve()
    await shutdown.catch(() => { /* ignore: a failed assertion above is the real report; shutdown errors are cleanup noise */ })
  }
})

it('Stop still settles a Run when active work races the transition to waiting', async () => {
  const f = engineFixture({ cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  const controller = new AbortController()
  f.internals.activeRuns.set('run-1', controller); f.internals.activeTasks.set('run-1', Promise.resolve())
  f.stopFence(); await f.engine.cancel('run-1')
  assert.equal(controller.signal.aborted, true)
  assert.equal(f.run().outcome, 'canceled')
})

it('ownership loss cannot authorize a terminal settlement or hide cleanup failure', async () => {
  const f = engineFixture({ cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  f.stopFence(); f.loseOwnership()
  await assert.rejects(f.engine.cancel('run-1'), /ownership lost/)
  assert.equal(f.run().executionState, 'waiting')
  assert.ok(!f.calls.includes('settle'))
  assert.ok(f.calls.includes('release-owner'))
})

it('failed native restart closure keeps shutdown failed and preserves Run history', async () => {
  const f = engineFixture({ cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  f.approvals.closeForRestart = async () => { throw new Error('native close uncertain') }
  await assert.rejects(f.engine.shutdown(), AggregateError)
  assert.equal(f.run().executionState, 'waiting')
  assert.equal(f.run().result, undefined)
})

it('retrying credential cleanup does not cancel or close an already confirmed closed native session', async () => {
  const f = await fixture([execution('one')])
  f.credentials.revokeForExecution = async () => { throw new Error('credential store unavailable') }
  await assert.rejects(f.stop('run-1'), AggregateError)
  assert.ok(!f.calls.includes('release:one'))
  f.credentials.revokeForExecution = async () => undefined
  await f.stop('run-1')
  assert.equal(f.calls.filter((call) => call === 'cancel:one').length, 1)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 1)
  assert.ok(f.calls.includes('release:one'))
  assert.ok(f.calls.includes('release:one'))
})

it('rechecks durable native closure after a failed graph drain rather than trusting the task error', async () => {
  const task = rejectableDeferred<void>()
  const f = engineFixture({ cancelRun: async () => undefined } as unknown as ApprovalExecutionCoordinator)
  f.internals.activeTasks.set('run-1', task.promise)
  f.stopFence()
  const stopped = f.engine.cancel('run-1')
  task.reject(new Error('graph drain failed'))
  assert.equal(await stopped, true)
  assert.equal(f.run().outcome, 'canceled')
  assert.ok(f.calls.includes('release-owner'))
})

it('does not claim native closure when a failed create never returned a session identity', async () => {
  const item = execution('one', 'starting')
  const f = await fixture([item])
  // An uncoded runtime error is transient and abandons only the attempt; a rejected creation keeps the Run's closure pending.
  f.managers.get('one')!.createImpl = async () => {
    throw new DomainError('NATIVE_SESSION_CREATE_REJECTED', 'native creation failed after process start', 409)
  }
  await assert.rejects(f.observe(item), /native creation failed/)
  await assert.rejects(f.stop(item.runId), AggregateError)
  assert.ok(!f.calls.includes('release:one'))
  assert.deepEqual(f.coordinator.residentRunIds(), [item.runId])
})

it('closes an exact native attach that finishes after Stop times out, without starting another turn', async () => {
  const item = execution('one')
  const f = await fixture([item], true)
  const attaching = rejectableDeferred<void>()
  const opened = rejectableDeferred<NativeSessionReference>()
  f.managers.get('one')!.attachImpl = async () => { attaching.resolve(); return opened.promise }
  const observed = f.observe(item).catch((error: unknown) => error)
  await attaching.promise
  await assert.rejects(f.stop(item.runId), AggregateError)
  assert.ok(!f.calls.includes('release:one'), 'an in-flight attach cannot be forgotten')
  const closesBefore = f.calls.filter((call) => call === 'close:one').length
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  assert.ok(await observed instanceof Error)
  assert.ok(f.calls.filter((call) => call === 'close:one').length > closesBefore)
  await f.stop(item.runId)
  assert.equal(f.calls.filter((call) => call === 'attach:one').length, 1)
  assert.ok(!f.calls.includes('create:one'))
  assert.ok(f.calls.includes('release:one'))
}, 20_000)


it('does not accept an older close as evidence that a late native attach is closed', async () => {
  const item = execution('one')
  const f = await fixture([item], true)
  const attaching = rejectableDeferred<void>()
  const opened = rejectableDeferred<NativeSessionReference>()
  const closing = rejectableDeferred<void>()
  const closed = rejectableDeferred<undefined>()
  const manager = f.managers.get('one')!
  manager.attachImpl = async () => { attaching.resolve(); return opened.promise }
  manager.closeImpl = async () => { closing.resolve(); return closed.promise }
  const observed = f.observe(item).catch((error: unknown) => error)
  await attaching.promise
  const stopping = f.stop(item.runId).catch((error: unknown) => error)
  await closing.promise
  opened.resolve({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-one' })
  // Let the in-flight attach complete while the older close still awaits its acknowledgment.
  await new Promise<void>((resolve) => setImmediate(resolve))
  closed.resolve(undefined)
  assert.ok(await stopping instanceof AggregateError)
  assert.ok(await observed instanceof Error)
  assert.ok(!f.calls.includes('release:one'))
  manager.closeImpl = async () => undefined
  await f.stop(item.runId)
  assert.equal(f.calls.filter((call) => call === 'close:one').length, 2)
  assert.ok(f.calls.includes('release:one'))
}, 20_000)
