import type pg from 'pg'
import type { AgentConfigurationVersion, ExecutionResult, HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import * as diagnostics from '../src/modules/diagnostics/logger.js'
import { DomainError } from '../src/modules/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { deferred } from './helpers/deferred.js'
import { idleWorkflowControls, idleWorkflowRepeat } from './helpers/idleWorkflowControls.js'

const connections: ExclusiveGraphConnection[] = []
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture() {
  const createdAt = new Date().toISOString()
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', workspaceId: 'workspace', agentId: 'agent', version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'sha256:fixture', createdAt,
    harness: { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
  }
  let execution: HarnessExecution = {
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'starting',
    workingDirectory: '/project', runtimeDirectory: '/runtime', createdAt, startedAt: createdAt,
  }
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'session' }
  const connection = new ExclusiveGraphConnection({ query: async () => {
    throw new Error('This unit fixture does not execute SQL')
  } } as unknown as pg.ClientBase, () => {})
  connections.push(connection)
  const owner = { runId: execution.runId, assertOwned() {}, oneShotConnection: () => connection } as unknown as RunOwnership
  const captures = createWorkflowNativeCaptureChannel()
  const store: RepeatNativeObservationStore = {
    async readExecution() {
      return { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null }, slotId: 'slot',
        input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
        inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false }
    },
    async assertExecutionAdmission() {}, async assertNativeBoundary() {}, async exactSession() { return session },
    async authorizeNativeSubmission() {}, consumeLaunch() { return true }, async settleNativeExecution() {},
  }
  type CoordinatorArguments = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const runs = {
    get: async () => ({ id: execution.runId, workspaceId: configuration.workspaceId }),
    updateExecution: async (next: HarnessExecution, _owner: RunOwnership, evidence: Parameters<typeof captures.verify.read>[0]) => {
      expect(captures.verify.read(evidence).execution.id).toBe(execution.id)
      execution = structuredClone(next)
    },
    recordActivity: async () => {}, appendNativeEvents: async () => {}, requestCleanup: async () => {},
    recordExecutionFailure: async () => {},
    ...idleWorkflowControls,
    repeat: async () => ({ ...idleWorkflowRepeat, readExecution: store.readExecution, settleNegativeExecution: async () => {} }),
    getRepeatSnapshot: async () => ({ stopRequested: false }),
  } as unknown as CoordinatorArguments[0]
  const interactions = { coordination: nativeLanes(), cancelPendingForRun: async () => 0 } as unknown as CoordinatorArguments[1]
  const budgets = {
    ensure: async () => {}, remaining: async () => 3_600_000, resume: async () => {}, assertActive: async () => {},
    finish: async () => {}, stop: async () => {},
  } as unknown as CoordinatorArguments[2]
  const prepare = vi.fn(async () => ({ credential: { principalId: 'principal',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    environment: { agentId: configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: 'test-scoped-token' } },
  } }))
  const renew = vi.fn(async () => new Date(Date.now() + 900_000).toISOString())
  const revokeForExecution = vi.fn(async () => {})
  const credentials = { prepare, renew, revokeForExecution } as unknown as ExecutionCredentialProvider
  let closure: Awaited<ReturnType<WorkflowClosureStore['read']>>
  const closures = {
    begin: async () => '1', record: async (original, reference, durableGeneration, check) => {
      check()
      closure = { execution: original, session: reference, durableGeneration }
      return closure
    }, read: async () => closure,
  } satisfies Pick<WorkflowClosureStore, 'begin' | 'record' | 'read'>
  let entered!: () => void
  let finish!: () => void
  let nativeSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const success: ExecutionResult = { outcome: 'succeeded', output: { done: true } }
  const createSession = vi.fn(async () => session)
  const cancel = vi.fn(async () => true)
  const close = vi.fn(async () => {})
  const manager = {
    harness: 'codex', createSession, cancel, close,
    startTurn: vi.fn(async function* (_session, _input, signal?: AbortSignal) {
      nativeSignal = signal
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason)
        finish = () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        signal?.addEventListener('abort', abort, { once: true })
        entered()
        if (signal?.aborted) abort()
      })
      yield { sequence: 0, type: 'turn.started', occurredAt: createdAt, payload: {} }
    } as NativeHarnessSessionManager['startTurn']),
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async (_session: NativeSessionReference, correlationId: string) => ({
      events: [], pendingInteractions: [], correlationId, nativeTurnId: 'turn',
      terminalTurn: { correlationId, providerId: 'turn', result: success },
    }),
  } as unknown as NativeHarnessSessionManager
  const validateContinuation = vi.fn(async () => {})
  const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets,
    new ExecutionScopedNativeSessionManagerResolver(() => manager), 3_600_000, credentials,
    validateContinuation, closures as unknown as WorkflowClosureStore, undefined, captures.capture)
  const controller = new AbortController()
  const pending = coordinator.observeExact({ execution, store, owner, signal: controller.signal,
    workflowId: 'workflow', graphThreadId: execution.runId,
    request: { executionId: execution.id, runId: execution.runId, workspaceId: configuration.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory!,
      runtimeDirectory: execution.runtimeDirectory!, configuration, input: execution.input },
  }).then(result => result, (error: unknown) => error)
  return { started, pending, controller, finish: () => finish(), signal: () => nativeSignal,
    validateContinuation, prepare, renew, revokeForExecution, createSession, cancel, close, manager }
}

it('keeps the original native turn alive through temporary execution connection loss', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    await f.started
    await vi.advanceTimersByTimeAsync(390_000)
    f.validateContinuation.mockRejectedValue(new DomainError(
      'REMOTE_DISPATCH_UNAVAILABLE', 'Execution connection unavailable', 503,
    ))
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.signal()?.aborted).toBe(false)
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.revokeForExecution).not.toHaveBeenCalled()
    expect(f.renew).not.toHaveBeenCalled()
    f.validateContinuation.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    f.finish()
    await expect(f.pending).resolves.toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    expect(f.createSession).toHaveBeenCalledTimes(1)
    expect(f.manager.startTurn).toHaveBeenCalledTimes(1)
    expect(f.prepare).toHaveBeenCalledTimes(1)
  } finally {
    f.controller.abort()
    await f.pending
  }
})

it.each(['check', 'refresh'] as const)('logs and preserves the original %s failure through native observation', async phase => {
  vi.useFakeTimers()
  const log = diagnostics.logger.child({ component: 'harness' })
  const warn = vi.spyOn(log, 'warn')
  vi.spyOn(diagnostics, 'componentLogger').mockReturnValue(log)
  const f = fixture()
  const original = new DomainError('AUTH_REVOKED', 'Access revoked for test-scoped-token', 403)
  try {
    await f.started
    if (phase === 'check') f.validateContinuation.mockRejectedValue(original)
    else f.renew.mockRejectedValue(original)
    await vi.advanceTimersByTimeAsync(phase === 'check' ? 20_000 : 14 * 60_000)
    const failure = await f.pending
    expect(f.signal()?.reason.cause).toBe(original)
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({ code: 'WORKER_CREDENTIAL_EXPIRING', cause: {
      code: 'AUTH_REVOKED', message: 'Access revoked for [REDACTED]',
    } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'maintain workflow credential', executionId: 'execution', phase,
      err: expect.objectContaining({ cause: expect.objectContaining({
        code: 'AUTH_REVOKED', message: 'Access revoked for [REDACTED]',
      }) }),
    }), expect.any(String))
    expect(JSON.stringify(diagnostics.serializeError(failure))).not.toContain('test-scoped-token')
  } finally {
    f.controller.abort()
    await f.pending
  }
})

it('keeps a native execution alive across MCP route refresh deadlines and retries credential maintenance', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const epoch = deferred<string>()
  const routes = new AppMcpRoutes({ query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    'http://127.0.0.1:3101/mcp', undefined, () => ({ active: true, readRuntimeEpoch: () => epoch.promise }))
  f.renew.mockImplementation(async () => {
    await routes.refresh()
    return new Date(Date.now() + 900_000).toISOString()
  })
  try {
    await f.started
    await vi.advanceTimersByTimeAsync(720_000)
    expect(f.signal()?.aborted).toBe(false)
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.revokeForExecution).not.toHaveBeenCalled()
    expect(f.renew.mock.calls.length).toBeGreaterThan(1)
    epoch.resolve('123456')
    await vi.advanceTimersByTimeAsync(5_000)
    f.finish()
    await expect(f.pending).resolves.toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.manager.startTurn).toHaveBeenCalledOnce()
    expect(f.prepare).toHaveBeenCalledOnce()
  } finally {
    epoch.resolve('123456')
    f.controller.abort()
    await f.pending
    await routes.close()
  }
})
