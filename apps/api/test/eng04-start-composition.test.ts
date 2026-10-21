import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import { repeatNativeStartStore, executeRepeatEngineStart, type RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import type { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import type { AcceptedRepeatRunSnapshot } from '../src/modules/runs/repeatStartRead.js'
import type { RepeatNativeBoundaryEvidence } from '../src/modules/runs/repeatNativeRepository.js'
import { startFixture } from './eng04-start-fixtures.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'

/** These tests exercise the NEW composition boundary. Reader, native proof,
 * repository and runtime are explicit doubles, not a real Stop/recovery/native
 * lifecycle pass. The actual N1 immutable directory function is retained. */
const calls = vi.hoisted(() => ({ read: vi.fn(), observer: vi.fn(), driver: vi.fn(), runtime: vi.fn() }))
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: calls.read }))
vi.mock('../src/modules/runs/repeatRuntime.js', () => ({ executeRepeatRuntime: calls.runtime,
  repeatNativeObserver: calls.observer, repeatExecutionDriver: calls.driver }))
beforeEach(() => { vi.resetAllMocks() })

type Store = ReturnType<RepeatRepositoryFactory['forOwner']>
function fixture() {
  const f = startFixture()
  const snapshot: AcceptedRepeatRunSnapshot = { run: f.run, version: f.version,
    configurations: f.f.configurations, stopRequested: false, cleanupPending: false }
  const controller = new AbortController()
  let owned = true
  let evidence: RepeatNativeBoundaryEvidence | undefined
  const prepared = { executionId: 'execution-start-first' }, entered = { executionId: 'execution-start-first' }
  const entry = agentWorkflowNode(f.version.definition.nodes[0])
  let execution = HarnessExecutionSchema.parse({ id: 'execution-start-first', runId: f.run.id,
    workflowNodeId: f.version.entryNodeId, agentId: entry.agentId,
    agentConfigurationVersionId: f.version.agentConfigurationVersionIds[entry.agentId],
    attempt: 1, input: {}, state: 'queued', createdAt: '2026-09-25T00:00:00.000Z' })
  const boundary = vi.fn(async () => undefined)
  const consume = vi.fn()
  const repository = { readExecution: vi.fn(async () => ({ execution: structuredClone(execution) })),
    claimLaunch: vi.fn(async () => structuredClone(execution)),
    beginNativeEntry: vi.fn(async () => prepared),
    authorizeNativeSubmission: vi.fn(async () => entered),
    assertExecutionAdmission: vi.fn(async () => undefined),
    consumeLaunchPermit: consume, recoverSession: vi.fn(async () => structuredClone(execution)),
    exactSession: vi.fn(async () => ({ harness: 'codex', providerVersion: 'synthetic-1', nativeSessionId: 'session-start-test' })),
    settleNativeExecution: vi.fn(async () => undefined), assertNativeBoundary: boundary } as unknown as Store
  const owner = { runId: f.run.id, assertOwned: () => {
    if (!owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'synthetic owner lost', 409)
  }, oneShotConnection: () => ({ transaction: async (work: (sql: object) => Promise<unknown>) => work({ transaction: true }) }) }
  const proof = vi.fn(async () => {
    if (!evidence) throw new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'No captured native evidence', 409)
    return evidence
  })
  const context = { owner, signal: controller.signal, checkpointer: {}, admission: {}, configuredParallelism: 4,
    runtimeRoot: '/synthetic/runtime', factory: { forOwner: vi.fn(() => repository) }, native: {}, workflows: {}, locations: {},
    nativeBoundaryEvidence: proof, lifecycle: { preflight: vi.fn(async () => undefined), markRunning: vi.fn(async () => undefined),
      currentState: vi.fn(async () => ({ executionState: 'running', stopRequested: false })), persistWait: vi.fn(async () => false),
      cancelNativeAndRequestCleanup: vi.fn(async () => false), settleRun: vi.fn(async () => undefined), requestCleanup: vi.fn(async () => undefined),
      finishNative: vi.fn(async () => undefined), finishCleanup: vi.fn(async () => undefined) } } as unknown as RepeatEngineStartContext
  calls.read.mockResolvedValue(snapshot)
  const adapter = repeatNativeStartStore(context, snapshot, repository)
  return { ...f, context, snapshot, controller, adapter, repository, proof, boundary, consume, prepared, entered,
    execution: () => execution, changeExecution: (next: typeof execution) => { execution = next },
    loseOwner: () => { owned = false }, setProof: (next: RepeatNativeBoundaryEvidence) => { evidence = next } }
}

describe('ENG04 NATIVE-3 N1 to N2 exact observer bridge', () => {
  it('computes no directory before an exact read; same node in another occurrence/attempt has a distinct path', async () => {
    const f = fixture(), first = f.execution()
    expect(() => f.adapter.directory(first.id)).toThrow()
    await f.adapter.store.readExecution(first.id)
    const firstPath = f.adapter.directory(first.id)
    f.changeExecution({ ...first, id: 'execution-start-next', attempt: 1 })
    await f.adapter.store.readExecution('execution-start-next')
    expect(f.adapter.directory('execution-start-next')).not.toBe(firstPath)
    f.changeExecution({ ...first, id: 'execution-start-retry', attempt: 2 })
    await f.adapter.store.readExecution('execution-start-retry')
    expect(f.adapter.directory('execution-start-retry')).not.toBe(firstPath)
    expect(f.proof).not.toHaveBeenCalled()
  })
  it('never consumes a repository permit without this adapter observing the exact known-COMMIT claim', async () => {
    const f = fixture(), id = f.execution().id
    expect(f.adapter.store.consumeLaunch(id)).toBe(false)
    expect(f.consume).not.toHaveBeenCalled()
    await f.adapter.store.claimLaunch(id, { workingDirectory: f.location.rootPath, runtimeDirectory: '/synthetic/runtime' })
    expect(f.adapter.store.consumeLaunch(id)).toBe(false)
    expect(await f.adapter.store.beginNativeEntry(id)).toBe(f.prepared)
    expect(f.adapter.store.consumeLaunch(id)).toBe(false)
    await f.adapter.store.authorizeNativeSubmission(id)
    expect(f.repository.authorizeNativeSubmission).toHaveBeenCalledWith(id, f.prepared)
    expect(f.adapter.store.consumeLaunch(id)).toBe(true)
    expect(f.adapter.store.consumeLaunch(id)).toBe(false)
    await f.adapter.store.assertNativeBoundary(id)
    expect(f.boundary).toHaveBeenCalledWith(id, { kind: 'first_launch', permit: f.entered })
  })
  it('lost claim reply / recovered candidate cannot recreate the first-launch boundary', async () => {
    const f = fixture(), id = f.execution().id
    vi.mocked(f.repository.claimLaunch).mockRejectedValue(new Error('lost commit reply'))
    await expect(f.adapter.store.claimLaunch(id, { workingDirectory: f.location.rootPath, runtimeDirectory: '/synthetic/runtime' })).rejects.toThrow()
    await f.adapter.store.recoverSession(id)
    expect(f.adapter.store.consumeLaunch(id)).toBe(false)
    await expect(f.adapter.store.assertNativeBoundary(id)).rejects.toMatchObject({ code: 'NATIVE_SESSION_START_UNCERTAIN' })
    expect(f.boundary).not.toHaveBeenCalled()
  })
  it('rereads fresh exact physical evidence rather than caching a prior live generation', async () => {
    const f = fixture(), id = f.execution().id
    const session = { harness: 'codex' as const, providerVersion: 'synthetic-1', nativeSessionId: 'session-start-test' }
    f.setProof({ kind: 'recovery', session, evidence: { generation: '17' } })
    await f.adapter.store.assertNativeBoundary(id)
    f.setProof({ kind: 'live', session, evidence: { generation: '18' } })
    await f.adapter.store.assertNativeBoundary(id)
    expect(f.proof).toHaveBeenCalledTimes(2)
    expect(f.boundary.mock.calls[0]).toEqual([id, { kind: 'recovery', session, evidence: { generation: '17' } }])
    expect(f.boundary.mock.calls[1]).toEqual([id, { kind: 'live', session, evidence: { generation: '18' } }])
  })
  it('a changed execution or directory identity fails without granting launch permission', async () => {
    const f = fixture(), first = f.execution()
    await expect(f.adapter.store.readExecution('crossed-execution')).rejects.toMatchObject({ code: 'REPEAT_EXECUTION_INPUT_CONFLICT' })
    await f.adapter.store.readExecution(first.id)
    f.changeExecution({ ...first, attempt: 2 })
    await expect(f.adapter.store.readExecution(first.id)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
    expect(f.adapter.store.consumeLaunch(first.id)).toBe(false)
  })
  it('loss or cross-Run replacement of owner fences reads, paths, claims, settlement and permit consumption', async () => {
    const f = fixture(), id = f.execution().id
    await f.adapter.store.readExecution(id)
    f.loseOwner()
    await expect(f.adapter.store.readExecution(id)).rejects.toThrow()
    await expect(f.adapter.store.settleNativeExecution(id)).rejects.toThrow()
    expect(() => f.adapter.directory(id)).toThrow()
    expect(() => f.adapter.store.consumeLaunch(id)).toThrow()
    expect(f.repository.settleNativeExecution).not.toHaveBeenCalled()
    const other = fixture()
    const mutableOwner = other.context.owner as unknown as { runId: string }
    mutableOwner.runId = 'different-run'
    await expect(other.adapter.store.readExecution(other.execution().id)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
  })
})

describe('ENG04 NATIVE-3 existing-engine entry guards (not registered lifecycle)', () => {
  it.each(['queued', 'running', 'waiting'] as const)('forwards %s using the exact existing owner, worker gate and checkpoint identity', async (state) => {
    const f = fixture(); f.snapshot.run.executionState = state
    const observed = async () => undefined, driver = {}
    calls.observer.mockReturnValue(observed); calls.driver.mockReturnValue(driver)
    await executeRepeatEngineStart(f.context)
    expect(f.context.factory.forOwner).toHaveBeenCalledWith(f.context.owner, f.snapshot.version)
    expect(calls.observer).toHaveBeenCalledWith(expect.objectContaining({ owner: f.context.owner, admission: f.context.admission, native: f.context.native }))
    expect(calls.driver).toHaveBeenCalledWith(expect.objectContaining({ owner: f.context.owner, store: f.repository, observeExact: observed }))
    const forwarded = calls.runtime.mock.calls[0]![0]
    expect(forwarded.owner).toBe(f.context.owner)
    expect(forwarded.checkpointer).toBe(f.context.checkpointer)
    expect(forwarded.runId).toBe(f.run.id)
    expect(forwarded.configuredParallelism).toBe(4)
    expect(forwarded.resumeCommand).toBeUndefined()
    await forwarded.lifecycle.preflight()
    expect(calls.read).toHaveBeenCalledTimes(2)
    expect(f.context.lifecycle.preflight).toHaveBeenCalledTimes(1)
  })
  it('forwards the rework budget failure to cleanup before settlement', async () => {
    const f = fixture()
    const failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
      message: 'The Run reached its execution limit and cannot start more work.',
      retryable: false,
    } }
    calls.runtime.mockImplementation(async ({ lifecycle }: { lifecycle: RepeatEngineStartContext['lifecycle'] }) => {
      await lifecycle.requestCleanup(failure)
      await lifecycle.settleRun(false, false)
      await lifecycle.finishCleanup()
    })
    await executeRepeatEngineStart(f.context)
    expect(f.context.lifecycle.requestCleanup).toHaveBeenCalledWith(failure)
    expect(f.context.lifecycle.settleRun).toHaveBeenCalledWith(false, false)
    expect(f.context.lifecycle.finishCleanup).toHaveBeenCalledOnce()
  })
  it.each(['Stop', 'cleanup', 'terminal', 'interrupted', 'abort', 'owner'] as const)('%s blocks before observer/runtime/factory use', async (kind) => {
    const f = fixture()
    if (kind === 'Stop') f.snapshot.stopRequested = true
    if (kind === 'cleanup') f.snapshot.cleanupPending = true
    if (kind === 'terminal') f.snapshot.run.executionState = 'completed'
    if (kind === 'interrupted') f.snapshot.run.executionState = 'interrupted'
    if (kind === 'abort') f.controller.abort(new Error('stopped'))
    if (kind === 'owner') f.loseOwner()
    await expect(executeRepeatEngineStart(f.context)).rejects.toThrow()
    expect(calls.observer).not.toHaveBeenCalled()
    expect(calls.runtime).not.toHaveBeenCalled()
    expect(f.context.factory.forOwner).not.toHaveBeenCalled()
  })
  it('a Stop raced after the first accepted read blocks at runtime preflight', async () => {
    const f = fixture()
    await executeRepeatEngineStart(f.context)
    calls.read.mockResolvedValue({ ...f.snapshot, stopRequested: true })
    await expect(calls.runtime.mock.calls[0]![0].lifecycle.preflight()).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
    expect(f.context.lifecycle.preflight).not.toHaveBeenCalled()
  })
  it('requires every lifecycle writer rather than accepting a partial cleanup callback', async () => {
    const f = fixture()
    f.context.lifecycle.finishCleanup = undefined as unknown as typeof f.context.lifecycle.finishCleanup
    await expect(executeRepeatEngineStart(f.context)).rejects.toMatchObject({ code: 'REPEAT_NATIVE_HOST_REQUIRED' })
    expect(calls.runtime).not.toHaveBeenCalled()
  })
})
