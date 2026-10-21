import assert from 'node:assert/strict'
import { expect, it, vi } from 'vitest'
import { cleanupTimeoutMs } from '../src/modules/interactions/cleanup.js'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { WorkExecutionFailure } from '../src/modules/runs/workExecutionFailure.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'

// Real LangGraph/checkpointer; native and persistence are deterministic unit ports.
it('keeps a healthy sibling observing beyond the cleanup deadline during a pending native boundary', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = a1Scenario('parallel')
    let reached!: () => void, pending = true
    const siblingStarted = new Promise<void>((resolve) => { reached = resolve })
    const h = graphHarness(f, { beforeObserve: async (execution, _ref, signal) => {
      if (execution.workflowNodeId === f.version.definition.nodes[2]!.id) {
        reached()
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer)
            reject(signal.reason)
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', aborted)
            resolve()
          }, cleanupTimeoutMs + 1500)
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
      } else if (execution.workflowNodeId === f.version.definition.nodes[1]!.id && pending) {
        await siblingStarted
        pending = false
        throw new DomainError('REPEAT_BOUNDARY_PENDING', 'The original native boundary is still pending.', 409)
      }
    } })
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: async () => {}, markRunning: async () => {},
      currentState: async () => ({ executionState: 'running', stopRequested: false }),
      persistWait: async () => false,
      cancelNativeAndRequestCleanup: async () => { throw new Error('Healthy sibling was canceled.') },
      settleRun: async () => { throw new Error('Pending observation was negatively settled.') },
      requestCleanup: async () => {}, finishNative: async () => {}, finishCleanup: async () => {},
    }
    const running = executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })
    const settled = Promise.allSettled([running])
    await siblingStarted
    await vi.advanceTimersByTimeAsync(cleanupTimeoutMs + 1500)
    await settled
    await running
    assert.equal(h.completeCalls, 1)
    assert.equal(h.candidateIds.length, f.version.definition.nodes.length)
    const sibling = [...h.executions.values()].find((execution) => execution.workflowNodeId === f.version.definition.nodes[2]!.id)!
    assert.equal(h.observations.filter((id) => id === sibling.id).length, 1)
  } finally {
    vi.useRealTimers()
  }
}, 15_000)

it.each(['EXECUTION_START_INTERRUPTED', 'APP_MCP_PREFLIGHT_FAILED'])(
  'retains the Run and its sibling when a retryable %s escapes native cleanup', async code => {
    const f = a1Scenario('parallel')
    const failure = new DomainError(code, 'The native attempt needs another observation.', 503)
    let started!: () => void
    const siblingStarted = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let failed = false
    const h = graphHarness(f, { beforeObserve: async (execution, _ref, signal) => {
      if (execution.workflowNodeId === f.version.definition.nodes[2]!.id) {
        started()
        await held
        signal.throwIfAborted()
      } else if (execution.workflowNodeId === f.version.definition.nodes[1]!.id) {
        await siblingStarted
        failed = true
        throw failure
      }
    } })
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: async () => undefined,
      markRunning: async () => undefined,
      currentState: async () => ({ executionState: 'running', stopRequested: false, cleanupPending: false }),
      persistWait: async () => false,
      requestCleanup: vi.fn(async () => undefined),
      cancelNativeAndRequestCleanup: vi.fn(async () => { release(); return true }),
      settleRun: vi.fn(async () => undefined),
      finishNative: vi.fn(async () => undefined),
      finishCleanup: vi.fn(async () => undefined),
    }
    const running = executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })
    const settled = Promise.allSettled([running])
    try {
      await vi.waitFor(() => expect(failed).toBe(true))
      release()
      await settled
      await expect(running).rejects.toBe(failure)
      expect(lifecycle.requestCleanup).not.toHaveBeenCalled()
      expect(lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
      expect(lifecycle.settleRun).not.toHaveBeenCalled()
      const sibling = [...h.executions.values()].find(execution =>
        execution.workflowNodeId === f.version.definition.nodes[2]!.id)!
      expect(sibling).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    } finally {
      release()
      await settled
    }
  })

it('settles an exhausted work failure even when its original native cause was retryable', async () => {
  const f = a1Scenario('single')
  const result = { outcome: 'failed' as const, error: {
    code: 'NATIVE_EXECUTION_FAILED', message: 'The native retry budget was exhausted.', retryable: true,
  } }
  const failure = new WorkExecutionFailure(result)
  const h = graphHarness(f, { beforeObserve: async () => { throw failure } })
  const lifecycle: RepeatRuntimeLifecycle = {
    preflight: async () => undefined,
    markRunning: async () => undefined,
    currentState: async () => ({ executionState: 'running', stopRequested: false }),
    persistWait: async () => false,
    requestCleanup: vi.fn(async () => undefined),
    cancelNativeAndRequestCleanup: vi.fn(async () => true),
    settleRun: vi.fn(async () => undefined),
    finishNative: vi.fn(async () => undefined),
    finishCleanup: vi.fn(async () => undefined),
  }
  await expect(executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle }))
    .rejects.toBe(failure)
  expect(lifecycle.requestCleanup).toHaveBeenCalledWith(result)
  expect(lifecycle.cancelNativeAndRequestCleanup).toHaveBeenCalledOnce()
  expect(lifecycle.settleRun).toHaveBeenCalledWith(false, false)
})
