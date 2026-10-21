import { describe, expect, it, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import { REPEAT_NATIVE_PENDING_MESSAGE } from '../src/modules/interactions/repeatNativeEvidence.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { repeatNodeAction, repeatTerminalResolution, type RepeatAcceptance } from '../src/modules/runs/repeatNode.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import { nativeCompleted, nativeFixture, nativeStored } from './eng04-native-fixtures.js'

function setup(completed = true) {
  const f = nativeFixture()
  let execution = completed ? nativeCompleted(f.execution) : f.execution
  const owner = { assertOwned: vi.fn() }
  const store = {
    readExecution: vi.fn(async (id: string) => { void id; return nativeStored(execution, f) }),
    settleNativeExecution: vi.fn(async (id: string): Promise<void> => { void id }),
  }
  const observeExact = vi.fn(async (value: HarnessExecution, signal: AbortSignal): Promise<void> => { void value; void signal })
  const reconcileArtifacts = vi.fn<(execution: HarnessExecution, signal: AbortSignal) => Promise<void>>(async () => {})
  const abandonAttempt = vi.fn(async (id: string, failure: unknown): Promise<void> => { void id; void failure })
  const createDriver = () => repeatExecutionDriver({ scope: f.scope, version: f.version, owner, store,
    observeExact, reconcileArtifacts, abandonAttempt })
  const driver = createDriver()
  return { f, owner, store, observeExact, reconcileArtifacts, abandonAttempt, createDriver, driver,
    get: () => execution, set: (value: HarnessExecution) => { execution = value } }
}

describe('ENG04 exact native occurrence driver', () => {
  it.each(['queued', 'starting'] as const)('abandons a %s start failure for a fresh attempt through transient database errors', async (state) => {
    const f = setup(false)
    const execution = { ...f.get(), state }
    delete execution.nativeSessionId
    f.set(execution)
    const timeout = new Error('Query read timeout')
    f.observeExact.mockRejectedValueOnce(timeout)
    f.abandonAttempt.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout)
      .mockImplementationOnce(async () => { f.set(nativeCompleted(f.get())) })
    await f.driver.observe(f.get(), new AbortController().signal)
    expect(f.abandonAttempt).toHaveBeenCalledTimes(3)
    expect(f.abandonAttempt).toHaveBeenLastCalledWith(execution.id, { outcome: 'failed', error: {
      code: 'EXECUTION_START_INTERRUPTED', message: 'Query read timeout', retryable: true,
    } })
    expect(f.observeExact).toHaveBeenCalledOnce()
    expect(f.store.settleNativeExecution).toHaveBeenCalledExactlyOnceWith(execution.id)
  })

  it('does not abandon a start that failed for a real task reason', async () => {
    const f = setup(false)
    const execution = { ...f.get(), state: 'starting' as const }
    delete execution.nativeSessionId
    f.set(execution)
    const conflict = new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'conflict', 409)
    f.observeExact.mockRejectedValueOnce(conflict)
    await expect(f.driver.observe(f.get(), new AbortController().signal)).rejects.toBe(conflict)
    expect(f.abandonAttempt).not.toHaveBeenCalled()
  })

  it('repairs a completed close/commit gap with SQL receipts and no native call', async () => {
    const f = setup()
    await f.driver.observe(f.get(), new AbortController().signal)
    expect(f.store.settleNativeExecution).toHaveBeenCalledExactlyOnceWith(f.get().id)
    expect(f.observeExact).not.toHaveBeenCalled()
  })
  it('requests only same-execution cleanup after a pending closure receipt', async () => {
    const f = setup()
    f.store.settleNativeExecution.mockRejectedValueOnce(new DomainError('REPEAT_CLEANUP_PENDING', 'pending', 409))
    await f.driver.observe(f.get(), new AbortController().signal)
    expect(f.observeExact).toHaveBeenCalledOnce()
    expect(f.observeExact.mock.calls[0]![0]).toEqual(f.get())
    expect(f.observeExact.mock.calls[0]![0].state).toBe('completed')
    expect(f.store.settleNativeExecution).toHaveBeenCalledTimes(2)
  })
  it('adopts outputs only after the completed native execution settles', async () => {
    const f = setup(false)
    const order: string[] = []
    f.observeExact.mockImplementation(async () => { f.set(nativeCompleted(f.get())) })
    f.store.settleNativeExecution.mockImplementation(async () => { order.push('settle') })
    f.reconcileArtifacts.mockImplementation(async terminal => {
      expect(terminal).toEqual(f.get())
      expect(terminal.state).toBe('completed')
      order.push('adopt')
    })
    await f.driver.observe(f.get(), new AbortController().signal)
    expect(order).toEqual(['settle', 'adopt'])
  })
  it('retains an adoption failure and recovers the accepted terminal after reconstruction', async () => {
    const f = setup(false)
    const failedAdoption = new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_PENDING', 'pending', 409)
    f.observeExact.mockImplementation(async () => { f.set(nativeCompleted(f.get())) })
    f.reconcileArtifacts.mockRejectedValueOnce(failedAdoption)
    const signal = new AbortController().signal
    await expect(f.driver.observe(f.get(), signal)).rejects.toBe(failedAdoption)
    await f.createDriver().observe(f.get(), signal)
    expect(f.get().result?.outcome).toBe('succeeded')
    expect(f.observeExact).toHaveBeenCalledOnce()
    expect(f.store.settleNativeExecution).toHaveBeenCalledTimes(2)
    expect(f.reconcileArtifacts).toHaveBeenCalledTimes(2)
    expect(f.reconcileArtifacts).toHaveBeenLastCalledWith(f.get(), signal)
  })
  it('does not call native cleanup for a contradictory closure/session identity', async () => {
    const f = setup()
    f.store.settleNativeExecution.mockRejectedValueOnce(new DomainError('REPEAT_NATIVE_IDENTITY_CONFLICT', 'conflict', 409))
    await expect(f.driver.observe(f.get(), new AbortController().signal)).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(f.observeExact).not.toHaveBeenCalled()
  })
  it('cannot swallow cleanup uncertainty just because a terminal is durable', async () => {
    const f = setup(false)
    const pending = new DomainError('REPEAT_CLEANUP_PENDING', 'pending', 409)
    f.observeExact.mockImplementation(async () => { f.set(nativeCompleted(f.get())); throw new Error('native close rejected') })
    f.store.settleNativeExecution.mockRejectedValue(pending)
    const observation = f.driver.observe(f.get(), new AbortController().signal)
    await expect(observation).rejects.toMatchObject({
      code: 'REPEAT_CLEANUP_PENDING', message: REPEAT_NATIVE_PENDING_MESSAGE,
    })
    // The LangGraph-safe retry wrapper must retain the exact local diagnostic.
    const failure: unknown = await observation.catch((error: unknown) => error)
    if (!(failure instanceof DomainError)) throw new Error('Expected the current DomainError retry wrapper')
    expect(failure.cause).toBe(pending)
    expect(f.get().result?.outcome).toBe('succeeded')
    expect(f.observeExact).toHaveBeenCalledOnce()
  })
  it('recovers a lost reply only when terminal and cleanup both have durable proof', async () => {
    const f = setup(false)
    f.observeExact.mockImplementation(async () => { f.set(nativeCompleted(f.get())); throw new Error('reply lost after close') })
    await f.driver.observe(f.get(), new AbortController().signal)
    expect(f.store.settleNativeExecution).toHaveBeenCalledOnce()
    expect(f.get().result?.outcome).toBe('succeeded')
  })
  it('preserves a nonterminal approval interrupt instead of settling or relaunching', async () => {
    const f = setup(false), interrupt = new Error('exact approval interrupt')
    f.observeExact.mockRejectedValue(interrupt)
    await expect(f.driver.observe(f.get(), new AbortController().signal)).rejects.toBe(interrupt)
    expect(f.store.settleNativeExecution).not.toHaveBeenCalled()
    expect(f.observeExact).toHaveBeenCalledOnce()
  })
  it('does not promote an observer return to completion', async () => {
    const f = setup(false)
    await expect(f.driver.observe(f.get(), new AbortController().signal)).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
    expect(f.store.settleNativeExecution).not.toHaveBeenCalled()
  })
  it('deduplicates in-flight observation by exact execution ID and permits receipt-only replay', async () => {
    const f = setup(false)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    f.observeExact.mockImplementation(async () => { await held; f.set(nativeCompleted(f.get())) })
    const signal = new AbortController().signal
    const first = f.driver.observe(f.get(), signal), duplicate = f.driver.observe(f.get(), signal)
    expect(duplicate).toBe(first)
    release()
    await Promise.all([first, duplicate])
    await f.driver.observe(f.get(), signal)
    expect(f.observeExact).toHaveBeenCalledOnce()
    expect(f.store.settleNativeExecution).toHaveBeenCalledTimes(2)
  })
  it('checks owner loss before using a durable terminal to absorb native failure', async () => {
    const f = setup(false), lost = new DomainError('RUN_OWNERSHIP_LOST', 'lost', 409)
    f.observeExact.mockImplementation(async () => {
      f.set(nativeCompleted(f.get()))
      f.owner.assertOwned.mockImplementation(() => { throw lost })
      throw new Error('observer failed')
    })
    await expect(f.driver.observe(f.get(), new AbortController().signal)).rejects.toBe(lost)
    expect(f.store.settleNativeExecution).not.toHaveBeenCalled()
  })
  it('does not settle or recover native work after the owning signal is canceled', async () => {
    const f = setup(false), controller = new AbortController(), stop = new Error('Stop')
    f.observeExact.mockImplementation(async () => { f.set(nativeCompleted(f.get())); controller.abort(stop) })
    await expect(f.driver.observe(f.get(), controller.signal)).rejects.toBe(stop)
    expect(f.store.settleNativeExecution).not.toHaveBeenCalled()
  })
})

describe('ENG04 occurrence wrapper settlement ordering', () => {
  it.each(['accepted', 'resolved'] as const)(
    'settles outside launch capacity before returning a %s terminal resolution', async kind => {
      const f = nativeFixture()
      const execution = nativeCompleted(f.execution)
      const order: string[] = []
      const limiter = new ExecutionLimiter(1)
      const capacity = vi.spyOn(limiter, 'run')
      const store = {
        admit: vi.fn(async () => ({ kind: 'admitted' as const, execution, reused: true })),
        acceptTerminal: vi.fn(async (): Promise<RepeatAcceptance> => {
          order.push('accept')
          return { kind, resolution: repeatTerminalResolution(f.version, f.scope, f.ref, execution) }
        }),
      }
      const driver = { candidate: vi.fn(() => execution), observe: vi.fn(async () => { order.push('settle') }) }
      const action = repeatNodeAction({ runId: f.scope.runId, store, driver, limiter,
        signal: new AbortController().signal })
      const checkpoint = await action(f.ref,
        { runId: f.scope.runId, occurrences: {}, boundaries: {}, executionIds: {} })
      expect(checkpoint).toEqual({ executionIds: { [f.ref.nodeId]: {
        executionId: execution.id, occurrenceId: f.ref.occurrence?.occurrenceId ?? null,
      } } })
      expect(order).toEqual(['settle', 'accept'])
      expect(capacity).not.toHaveBeenCalled()
      expect(driver.candidate).not.toHaveBeenCalled()
    },
  )
  it('blocks a technical retry and successor acceptance while cleanup is pending', async () => {
    const f = nativeFixture(), execution = nativeCompleted(f.execution)
    const store = { admit: vi.fn(async () => ({ kind: 'admitted' as const, execution, reused: true })), acceptTerminal: vi.fn() }
    const driver = { candidate: vi.fn(() => execution), observe: vi.fn(async () => { throw new DomainError('REPEAT_CLEANUP_PENDING', 'pending', 409) }) }
    const action = repeatNodeAction({ runId: f.scope.runId, store, driver, limiter: new ExecutionLimiter(1), signal: new AbortController().signal })
    await expect(action(f.ref, { runId: f.scope.runId, occurrences: {}, boundaries: {}, executionIds: {} })).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(store.acceptTerminal).not.toHaveBeenCalled()
  })
  it('never observes an already-resolved occurrence-local wrapper', async () => {
    const f = nativeFixture(), execution = nativeCompleted(f.execution)
    const resolution = repeatTerminalResolution(f.version, f.scope, f.ref, execution)
    const store = { admit: vi.fn(async () => ({ kind: 'resolved' as const, resolution })), acceptTerminal: vi.fn() }
    const driver = { candidate: vi.fn(() => execution), observe: vi.fn() }
    const action = repeatNodeAction({ runId: f.scope.runId, store, driver, limiter: new ExecutionLimiter(1), signal: new AbortController().signal })
    await action(f.ref, { runId: f.scope.runId, occurrences: {}, boundaries: {}, executionIds: {} })
    expect(driver.observe).not.toHaveBeenCalled()
    expect(store.acceptTerminal).not.toHaveBeenCalled()
  })
})
