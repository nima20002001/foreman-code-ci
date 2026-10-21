import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import { native2Fixture } from '../../../test/eng04-native2-fixtures.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import { coordinateSessionManager } from './sessionWriter.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { idleWorkflowRepeat } from '../../../test/helpers/idleWorkflowControls.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'

vi.mock('../placement/persistence.js', async importOriginal => ({
  ...await importOriginal<typeof import('../placement/persistence.js')>(),
  readExecutionPlacement: async () => ({ hostRef: { kind: 'device' } }),
}))

const connections: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(connections.splice(0).map(connection => connection.close()))
})

function residentFixture(completed = true) {
  const f = native2Fixture(completed)
  connections.push(f.connection)
  f.resident.context.acceptedPlacement = { hostRef: { kind: 'device' } }
  Object.assign(f.owner, { retain: () => async () => {}, release: async () => {} })
  Object.assign(f.runs, { acquireOwnership: async () => f.owner })
  f.installResident()
  return f
}

it('finishes the captured remote lifetime after more than five seconds', async () => {
  const f = residentFixture()
  let cleanupSignal: AbortSignal | undefined
  const close = f.manager.close
  Object.assign(f.manager, { close: async (session: NativeSessionReference, signal?: AbortSignal) => {
    cleanupSignal = signal
    await new Promise<void>(resolve => { setTimeout(resolve, 6_000) })
    signal?.throwIfAborted()
    await close(session)
  } })
  vi.useFakeTimers()
  const result = f.observe().then(value => value, (error: unknown) => error)
  await vi.advanceTimersByTimeAsync(6_001)
  expect(await result).toMatchObject({ state: 'completed' })
  expect(cleanupSignal).toBeInstanceOf(AbortSignal)
  expect(cleanupSignal?.aborted).toBe(false)
  expect(f.getProof()?.session).toEqual(f.session)
  expect(f.coordinator.residentRunIds()).toEqual([])
})

it('aborts an expired remote close and lets the same captured lifetime retry', async () => {
  const f = residentFixture()
  const close = f.manager.close
  let cleanupSignal: AbortSignal | undefined
  Object.assign(f.manager, { close: async (_session: NativeSessionReference, signal?: AbortSignal) => {
    cleanupSignal = signal
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } })
  vi.useFakeTimers()
  const result = f.observe().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(120_001)
  expect(await result).toBeInstanceOf(AggregateError)
  expect(cleanupSignal?.aborted).toBe(true)
  expect(f.getProof()).toBeUndefined()
  Object.assign(f.manager, { close })
  await expect(f.observe()).resolves.toMatchObject({ state: 'completed' })
  expect(f.getProof()?.session).toEqual(f.session)
})

it('preserves the five-second deadline for a captured local lifetime', async () => {
  const f = native2Fixture()
  connections.push(f.connection)
  f.installResident()
  Object.assign(f.manager, { close: async (_session: NativeSessionReference, signal?: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } })
  vi.useFakeTimers()
  const result = f.observe().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(5_001)
  expect(await result).toBeInstanceOf(AggregateError)
  expect(f.getProof()).toBeUndefined()
})

it.each(['close', 'closeForRestart', 'dispose'] as const)(
  'passes the cleanup cancellation signal through the session writer during %s', async method => {
    const session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'session' }
    const coordination = nativeLanes()
    await coordination.ensureLane({ id: 'lane', ...session, ownerAgentId: 'agent', observedStatus: 'idle',
      connectionGeneration: 1, observedAt: new Date().toISOString(), revision: 1 })
    const controller = new AbortController()
    const close = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const raw = { harness: 'codex', close, closeForRestart: close, dispose } as unknown as NativeHarnessSessionManager
    const manager = coordinateSessionManager(raw, coordination, 'agent')
    if (method === 'dispose') {
      await manager.dispose(controller.signal)
      expect(dispose).toHaveBeenCalledWith(controller.signal)
    } else {
      await manager[method](session, controller.signal)
      expect(close).toHaveBeenCalledWith(session, controller.signal)
    }
  },
)

function recoveryFixture(terminal: boolean, durationMs: number) {
  const f = native2Fixture(terminal)
  connections.push(f.connection)
  const failure = { outcome: 'failed' as const,
    error: { code: 'EXECUTION_INTERRUPTED', message: 'Native attempt interrupted', retryable: true } }
  const execution: HarnessExecution = terminal ? { ...f.get(), result: failure } : f.get()
  const { id, runId, workflowNodeId, agentId, agentConfigurationVersionId, attempt,
    workingDirectory, runtimeDirectory } = execution
  let failed = false
  const query = async (text: string) => {
    let rows: unknown[] = []
    if (text.includes("as semantics")) rows = [{ semantics: '3', fenced: false }]
    else if (text.startsWith('select record from harness_executions')) rows = [{ record: execution }]
    else if (text.startsWith('select 1 from harness_executions')) rows = failed ? [{}] : []
    else if (text.startsWith('select generation::text,execution_identity')) rows = [{
      generation: '1', execution_identity: { id, runId, workflowNodeId, agentId,
        agentConfigurationVersionId, attempt, workingDirectory, runtimeDirectory },
      expected_reference: f.session, closed: false, detached: false, prior_unclosed: false,
    }]
    else if (text.startsWith('select reference')) rows = [{ reference: f.session, finalized: false }]
    return { rows, rowCount: rows.length }
  }
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  connections.push(connection)
  const owner = { runId, assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) } as unknown as RunOwnership
  let cleanupSignal: AbortSignal | undefined
  const recover = vi.fn(async (_id: string, signal: AbortSignal) => {
    cleanupSignal = signal
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
    signal.throwIfAborted()
    return false
  })
  const store = { ...idleWorkflowRepeat, readExecution: async () => ({ execution }), settleNegativeExecution: vi.fn(async () => {}) }
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({
    ...f.runs, repeat: async () => store, recordExecutionFailure: async () => { failed = true },
    async *executionPages() { yield [execution] },
  } as unknown as Args[0], f.interactions as unknown as Args[1], f.budgets as unknown as Args[2],
  f.managers as unknown as Args[3], 60_000, undefined, undefined, f.closures,
  undefined, undefined, undefined, recover)
  return { coordinator, execution, owner, recover, store, signal: () => cleanupSignal }
}

it.each(['abandonment', 'terminal recovery'] as const)(
  'waits for delayed remote %s instead of the local five-second deadline', async path => {
    const f = recoveryFixture(path === 'terminal recovery', 6_000)
    vi.useFakeTimers()
    const operation = path === 'abandonment'
      ? f.coordinator.abandonAttempt(f.owner, f.execution, { outcome: 'failed' })
      : f.coordinator.requestColdRunCleanup(f.owner)
    const result = operation.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6_001)
    const error = await result
    const failure = error instanceof AggregateError ? error.errors[0]?.cause : error
    expect(failure).toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(f.recover).toHaveBeenCalledOnce()
    expect(f.signal()?.aborted).toBe(false)
    expect(f.store.settleNegativeExecution).not.toHaveBeenCalled()
  },
)

it('propagates the remote recovery deadline to its device operation', async () => {
  const f = recoveryFixture(false, 180_000)
  vi.useFakeTimers()
  const result = f.coordinator.abandonAttempt(f.owner, f.execution, { outcome: 'failed' })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(6_001)
  expect(f.signal()?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(114_000)
  expect(await result).toMatchObject({ message: 'Execution cleanup timed out.' })
  expect(f.signal()?.aborted).toBe(true)
  expect(f.store.settleNegativeExecution).not.toHaveBeenCalled()
})

it('allows a remote restart close to finish beyond five seconds', async () => {
  const f = residentFixture(false)
  const detached = vi.fn(async () => {})
  Object.assign(f.closures, { recordDetached: detached })
  let cleanupSignal: AbortSignal | undefined
  Object.assign(f.manager, { closeForRestart: async (_session: NativeSessionReference, signal?: AbortSignal) => {
    cleanupSignal = signal
    await new Promise<void>(resolve => { setTimeout(resolve, 6_000) })
    signal?.throwIfAborted()
  } })
  vi.useFakeTimers()
  const result = f.coordinator.closeForRestart().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(6_001)
  expect(await result).toBeUndefined()
  expect(cleanupSignal).toBeInstanceOf(AbortSignal)
  expect(cleanupSignal?.aborted).toBe(false)
  expect(detached).toHaveBeenCalledWith(f.get(), f.session, '41', expect.any(Function))
})
