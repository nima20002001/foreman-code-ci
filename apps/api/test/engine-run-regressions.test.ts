import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfigurationVersion, ExecutionResult, HarnessExecution, NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { MemorySaver } from '@langchain/langgraph'
import { describe, it, vi } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { nativeLanes } from './helpers/nativeLanes.js'

const secret = 'private-pr11-engine-secret'
const now = '2026-09-17T00:00:00.000Z'
type Fixture = Awaited<ReturnType<typeof createFixture>>
async function createFixture(placement?: AcceptedNodePlacement) {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-native-credential-'))
  const configuration: AgentConfigurationVersion = {
    id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: { system: 'Test' }, assignedSkills: [],
    // Explicit native handling: no inferred authority and no routed reviewer.
    harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
    contentHash: 'sha256:fixture', createdAt: now,
  }
  const run = {
    id: 'run-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
    agentConfigurationVersionIds: { 'agent-1': 'config-1' }, authorizationPrincipalId: 'operator-1',
    executionLocation: { runnerId: 'runner-local', rootPath: directory }, input: {},
    executionState: 'running', outcome: 'pending',
  }
  const candidate: HarnessExecution = { id: 'execution-pr11', runId: run.id, workflowNodeId: 'node-1', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'starting', createdAt: now,
    workingDirectory: directory, runtimeDirectory: join(directory, 'runtime') }
  const rows = new Map<string, HarnessExecution>([[candidate.id, candidate]])
  const accepted: HarnessExecution[] = [], events: unknown[] = [], activities: unknown[] = [], revoked: string[] = []
  let changedDirectory = false, revokedAuthority = false, cleanupFails = false, cleanupPending = false
  let prepared: () => Promise<void> = async () => undefined
  let published: (execution: HarnessExecution) => Promise<void> = async () => undefined
  let expiresIn = 60_000, creates = 0, starts = 0, cancels = 0, disposals = 0
  let native: (signal: AbortSignal) => Promise<ExecutionResult> = async () => ({ outcome: 'succeeded', output: { text: `done ${secret}` } })
  let terminal: ExecutionResult | undefined, correlation: string | undefined
  const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-exact' }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex',
    capabilities: async () => ({ provider: 'codex', providerVersion: '0.154.0', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: ['approval'] }),
    inspectMcp: async () => { throw new Error('Not part of this fixture') },
    createSession: async (input: NativeSessionStart) => {
      assert.equal(input.environment?.variables.GRAPHQL_MCP_TOKEN, secret)
      assert.equal(input.correlationId, `execution:${candidate.id}`)
      creates += 1
      return session
    },
    attachSession: async (reference: NativeSessionReference) => reference,
    async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
      void _session
      assert.ok(signal)
      starts += 1
      correlation = input.clientCorrelationId
      yield { sequence: 0, type: 'proof', occurredAt: now, payload: { unrelated: secret } }
      terminal = await native(signal)
      yield { sequence: 1, type: 'turn.completed', occurredAt: now, payload: {} }
    },
    pending: async () => undefined,
    respond: async () => { throw new Error('Non-routed native work cannot receive a Foreman Code decision') },
    cancel: async () => { cancels += 1; return true },
    history: async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], ...(terminal ? { terminalResult: terminal } : {}) }),
    reconcile: async (_session: NativeSessionReference, id: string): Promise<NativeHistory> => {
      void _session
      return { events: [], pendingInteractions: [], correlationId: id, nativeTurnId: 'turn-exact', ...(terminal && id === correlation
        ? { terminalResult: terminal, terminalTurn: { correlationId: id, providerId: 'turn-exact', result: terminal } } : {}) }
    },
    close: async () => undefined,
    dispose: async () => { disposals += 1 },
  }
  const negativeSettlements: string[] = [], failures = new Map<string, ExecutionResult>()
  const runs = {
    getRepeatSnapshot: async () => ({ run, stopRequested: false, cleanupPending }),
    requestCleanup: async () => { cleanupPending = true },
    async *executionPages() { yield [...rows.values()] },
    repeat: async () => ({ settleNegativeExecution: async (id: string) => { negativeSettlements.push(id) },
      readExecution: (id: string) => store.readExecution(id) }),
    recordExecutionFailure: async (_owner: unknown, id: string, failure: ExecutionResult) => { failures.set(id, failure) },
    get: async () => run, getExecution: async (id: string) => rows.get(id),
    ensureExecution: async (value: HarnessExecution) => {
      const previous = [...rows.values()].find((row) => row.workflowNodeId === value.workflowNodeId && row.attempt === value.attempt)
      if (!previous) rows.set(value.id, value)
      return { execution: previous ?? value, created: !previous }
    },
    updateExecution: async (value: HarnessExecution) => {
      if (value.state === 'running') await published(value)
      rows.set(value.id, value)
    },
    acceptExecutionResult: async (value: HarnessExecution) => { accepted.push(value) },
    appendNativeEvent: async (value: unknown) => { events.push(value) },
    appendNativeEvents: async (frames: { event: unknown }[]) => {
      events.push(...frames.map(({ event }) => event))
    },
    recordActivity: async (...args: unknown[]) => { activities.push(args) },
    listExecutions: async () => [...rows.values()],
    acquireOwnership: async () => undefined,
  }
  const credentials: ExecutionCredentialProvider = {
    prepare: async () => {
      await prepared()
      return { credential: { principalId: 'worker-1', environment: { agentId: 'agent-1', variables: { GRAPHQL_MCP_TOKEN: secret } },
        expiresAt: new Date(Date.now() + expiresIn).toISOString() }, detection: {} as never }
    },
    revoke: async () => { revoked.push(candidate.id); if (cleanupFails) throw new Error('database unavailable') },
    revokeForExecution: async (id) => { revoked.push(id); if (cleanupFails) throw new Error('database unavailable'); return 1 },
    revokeForRun: async (id) => { revoked.push(id); return 1 },
    reconcileTerminalCredentials: async () => undefined,
  }
  const locations = {
    revalidateRunAuthorization: async () => { if (revokedAuthority) throw new DomainError('AUTH_REVOKED', 'revoked', 401) },
    revalidateSnapshot: async () => { if (changedDirectory) throw new DomainError('WORKSPACE_LOCATION_CHANGED', 'changed', 409) },
  }
  const interactions = { coordination: nativeLanes(), assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'node-reviewer' }),
    getForExecution: async () => undefined, cancelPendingForExecution: async () => undefined,
    cancelPendingForRun: async () => undefined }
  const budgets = { ensure: async () => undefined, remaining: async () => 300_000, assertActive: async () => undefined,
    resume: async () => undefined, finish: async () => undefined, stop: async () => undefined }
  const captures = createWorkflowNativeCaptureChannel()
  let closed: Awaited<ReturnType<WorkflowClosureStore['read']>>
  const closures: WorkflowClosureStore = {
    async begin() { closed = undefined; return '1' },
    async record(execution, session, durableGeneration, check) { check(); closed = { execution, session, durableGeneration }; return closed },
    async read() { return closed }, async recordDetached(_execution, _session, _generation, check) { check() },
    async recordUnbound(execution, durableGeneration, check) { check(); return { execution: { ...execution,
      workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory! }, durableGeneration } },
    async readUnbound() { return undefined },
  }
  let launched = false
  const store: RepeatNativeObservationStore = {
    async readExecution(id) { const execution = rows.get(id)!; return { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null },
      slotId: 'pr11-slot', input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
      inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false } },
    async assertExecutionAdmission() {}, async assertNativeBoundary() {}, async exactSession() { return session },
    async authorizeNativeSubmission() {}, consumeLaunch() { if (launched) return false; launched = true; return true },
    async settleNativeExecution() { if (!closed || cleanupFails) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Native cleanup pending', 409) },
  }
  const coordinator = new ApprovalExecutionCoordinator(runs as never, interactions as never, budgets as never,
    new ExecutionScopedNativeSessionManagerResolver(() => manager), 300_000, credentials,
    async () => { await locations.revalidateRunAuthorization(); await locations.revalidateSnapshot() }, closures, undefined, captures.capture,
    undefined, undefined, undefined, async context => placement ? { ...context, acceptedPlacement: placement } : context)
  const owner = { runId: run.id, assertOwned: () => undefined, client: {} } as unknown as RunOwnership
  return {
    coordinator, credentials, rows, accepted, events, activities, revoked, negativeSettlements, failures,
    setDirectoryChanged: () => { changedDirectory = true }, setAuthorityRevoked: () => { revokedAuthority = true },
    failCleanup: () => { cleanupFails = true }, onPrepare: (callback: () => Promise<void>) => { prepared = callback },
    setNative: (callback: (signal: AbortSignal) => Promise<ExecutionResult>) => { native = callback },
    setExpiresIn: (ms: number) => { expiresIn = ms }, counters: () => ({ creates, starts, cancels, disposals }),
    onPublished: (callback: typeof published) => { published = callback },
    coordination: interactions.coordination,
    execute: () => coordinator.observeExact({ execution: candidate, store, owner, approval: { handler: 'user' },
      workflowId: run.workflowId, graphThreadId: run.id, signal: new AbortController().signal,
      request: { executionId: candidate.id, runId: run.id, workspaceId: run.workspaceId, workflowNodeId: candidate.workflowNodeId,
        workingDirectory: directory, runtimeDirectory: candidate.runtimeDirectory!, configuration, input: {} } }),
    async close() { cleanupFails = false; cleanupPending = true; await coordinator.cancelRun(run.id); await rm(directory, { recursive: true, force: true }) },
  }
}
async function withFixture(perform: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture()
  try { await perform(fixture) } finally { await fixture.close() }
}

describe('native launch, outcome and credential lifecycle', () => {
  it('abandons and disposes an observed session whose database publication failed before starting its turn', async () => {
    const f = await createFixture()
    f.onPublished(async () => { throw new Error('session publication failed') })
    try {
      await assert.rejects(f.execute(), /session publication failed/)
      assert.equal(f.counters().creates, 1)
      assert.equal(f.counters().starts, 0)
      assert.equal(f.counters().disposals, 1)
      // The attempt is closed for its own retryable cause; its node starts a fresh attempt.
      // A failure before the native session is published is an interrupted start.
      assert.deepEqual(f.failures.get(f.rows.keys().next().value!), { outcome: 'failed', error: {
        code: 'EXECUTION_START_INTERRUPTED', message: 'session publication failed', retryable: true } })
      assert.deepEqual(f.negativeSettlements, [f.rows.keys().next().value])
    } finally {
      await f.close()
    }
    assert.equal(f.counters().disposals, 1)
    assert.equal(f.counters().cancels, 0)
  })
  it('binds the workflow correlation before publishing a placed native session', async () => {
    const f = await createFixture({ hostRef: { kind: 'main' } } as AcceptedNodePlacement)
    let observed = false
    f.onPublished(async execution => {
      const lane = await f.coordination.getLane('codex', execution.nativeSessionId!)
      assert.equal(lane?.correlationId, `execution:${execution.id}`)
      assert.ok(lane?.leaseToken)
      assert.equal(f.counters().starts, 0)
      observed = true
    })
    try {
      await f.execute()
      assert.ok(observed)
      assert.equal(f.counters().starts, 1)
    } finally {
      await f.close()
    }
  })
  it('rechecks directory identity after asynchronous credential preparation', async () => {
    await withFixture(async (f) => {
      f.onPrepare(async () => f.setDirectoryChanged())
      await assert.rejects(f.execute(), { code: 'WORKSPACE_LOCATION_CHANGED' })
      assert.equal(f.counters().creates, 0)
      assert.equal(f.revoked.length, 0)
    })
  })
  it('rechecks launch authority after asynchronous credential preparation', async () => {
    await withFixture(async (f) => {
      f.onPrepare(async () => f.setAuthorityRevoked())
      await assert.rejects(f.execute(), { code: 'AUTH_REVOKED' })
      assert.equal(f.counters().creates, 0)
      assert.equal(f.revoked.length, 0)
    })
  })
  it('retains the native result but refuses successful finalization until cleanup is confirmed', async () => {
    await withFixture(async (f) => {
      f.failCleanup()
      await assert.rejects(f.execute(), /cleanup/)
      assert.equal([...f.rows.values()][0]?.result?.outcome, 'succeeded')
      assert.equal(f.accepted.length, 0)
      assert.equal(f.coordinator.residentRunIds().length, 1)
      assert(!JSON.stringify([[...f.rows.values()], f.events, f.activities]).includes(secret))
    })
  })
  it('redacts native exceptions, output and events at the durable boundary', async () => {
    await withFixture(async (f) => {
      f.setNative(async () => { throw new Error(`provider failed with ${secret}`) })
      await assert.rejects(f.execute(), (error: unknown) => {
        assert(error instanceof Error)
        assert(!error.message.includes(secret))
        return true
      })
      assert(!JSON.stringify([[...f.rows.values()], f.events, f.activities]).includes(secret))
    })
  })
  it('stops before credential expiry without restarting native work', async () => {
    await withFixture(async (f) => {
      f.setExpiresIn(30_150)
      f.setNative(async (signal) => new Promise<ExecutionResult>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }))
      await assert.rejects(f.execute(), { code: 'WORKER_CREDENTIAL_EXPIRING' })
      assert.equal(f.counters().starts, 1)
      assert.deepEqual(f.negativeSettlements, ['execution-pr11'])
      assert.equal(f.revoked.length, 1)
    })
  })
  it('uses one native identity on re-entry, including without a routed approval handler', async () => {
    await withFixture(async (f) => {
      await f.execute(); await f.execute()
      assert.equal(f.counters().creates, 1)
      assert.equal(f.counters().starts, 1)
      assert.equal(f.rows.size, 1)
      assert(!JSON.stringify([f.accepted, f.events]).includes(secret))
    })
  })
  it('does not turn a preflight authority rejection into a successful or retryable terminal result', async () => {
    await withFixture(async (f) => {
      f.setAuthorityRevoked()
      await assert.rejects(f.execute(), { code: 'AUTH_REVOKED' })
      assert.equal(f.counters().creates, 0)
      assert.equal(f.counters().starts, 0)
      assert.equal([...f.rows.values()][0]?.result, undefined)
      assert.equal(f.negativeSettlements.length, 0)
    })
  })
})

it('sweeps terminal credentials before dispatching persisted current work through the same engine', async () => {
  const actions: string[] = []
  const engine = new LangGraphWorkflowEngine({ repeatRepositoryFactory: () => ({}),
    reconciliationCandidates: async () => [{ id: 'persisted-current-run', executionState: 'queued' }],
  } as never, {} as never, { reconcileReviews: async () => { actions.push('reviews') } } as never,
  new MemorySaver(), '/tmp/native-orphan', {} as never, {
    reconcileTerminalCredentials: async () => { actions.push('sweep') },
  } as never, {} as never)
  vi.spyOn(engine, 'start').mockImplementation(async (id) => { actions.push(`start:${id}`) })
  await engine.reconcile((error) => { throw error })
  assert.deepEqual(actions, ['sweep', 'reviews', 'start:persisted-current-run'])
})
