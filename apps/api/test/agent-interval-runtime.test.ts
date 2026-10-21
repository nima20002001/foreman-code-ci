import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import type { RepeatExecutionDriver } from '../src/modules/runs/repeatNode.js'
import type { RepeatTickAdmission } from '../src/modules/runs/repeatPostgres.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'
import { deferred } from './helpers/deferred.js'

const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason)
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

/** Real graph runtime with deterministic ports: the entry Agent checks every 10 seconds while the
 * second node works until released. Checks are admitted once the second node has started. */
function intervalRun(options: { maxParallelism: number; observeCheck(check: HarnessExecution, signal: AbortSignal): Promise<void> }) {
  const f = a1Scenario('sequential', `interval-runtime-${options.maxParallelism}`)
  f.configurations = f.configurations.map((configuration) => ({ ...configuration, harness: { ...configuration.harness,
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' as const } } })) as typeof f.configurations
  const [watcher, worker] = f.version.definition.nodes
  if (!watcher || !worker) throw new Error('Expected two Agent nodes')
  watcher.interval = { everySeconds: 10 }
  f.version.definition.executionPolicy!.maxParallelism = options.maxParallelism
  const workerStarted = deferred(), workerRelease = deferred(), events: string[] = []
  const h = graphHarness(f, { beforeObserve: async (execution, _ref, signal) => {
    if (execution.workflowNodeId !== worker.id) return
    events.push('worker:start')
    workerStarted.resolve()
    await Promise.race([workerRelease.promise, untilAborted(signal)])
    events.push('worker:end')
  } })
  const checks: HarnessExecution[] = [], settledIds: Array<string | null> = []
  let allocating = false
  const admitTick = async (nodeId: string, candidate: () => HarnessExecution, settledId: string | null): Promise<RepeatTickAdmission> => {
    expect(nodeId).toBe(watcher.id)
    await workerStarted.promise
    settledIds.push(settledId)
    const latest = checks.at(-1)
    if (latest && latest.id !== settledId) return { kind: 'busy', execution: latest }
    if (latest) return { kind: 'wait', dueAt: null }
    allocating = true
    try { checks.push(candidate()) } finally { allocating = false }
    return { kind: 'admitted', execution: checks.at(-1)! }
  }
  const observed: string[] = []
  const driver: RepeatExecutionDriver = {
    candidate: (ref, attempt) => allocating ? HarnessExecutionSchema.parse({ id: `check-${checks.length + 1}`,
      runId: f.run.id, workflowNodeId: watcher.id, agentId: watcher.agentId,
      agentConfigurationVersionId: f.version.agentConfigurationVersionIds[watcher.agentId],
      attempt: 1, input: { tick: { index: checks.length + 1, everySeconds: 10 } }, state: 'queued', createdAt: f.createdAt })
      : h.input.driver.candidate(ref, attempt),
    observe: async (execution, signal) => {
      if (!execution.id.startsWith('check-')) return h.input.driver.observe(execution, signal)
      if (execution.state === 'completed') return
      observed.push(execution.id)
      await options.observeCheck(execution, signal)
      execution.state = 'completed'
    },
  }
  const lifecycle = {
    preflight: vi.fn(async () => {}), markRunning: vi.fn(async () => {}),
    currentState: vi.fn(async () => ({ executionState: 'running', stopRequested: h.controller.signal.aborted })),
    persistWait: vi.fn(async () => false), cancelNativeAndRequestCleanup: vi.fn(async () => true),
    settleRun: vi.fn(async () => {}), requestCleanup: vi.fn(async () => {}),
    finishNative: vi.fn(async () => {}), finishCleanup: vi.fn(async () => {}),
  } satisfies RepeatRuntimeLifecycle
  const run = () => executeRepeatRuntime({ ...h.input, store: { ...h.input.store, admitTick }, driver,
    owner: { assertOwned() {} }, lifecycle })
  return { h, run, lifecycle, checks, settledIds, observed, events, workerStarted, workerRelease }
}

it('keeps graph work running after a check startup failure and retries the same check through settlement', async () => {
  const failure = new DomainError('EXECUTION_START_INTERRUPTED', 'Execution startup failed.', 409)
  let attempts = 0
  const t = intervalRun({ maxParallelism: 2, observeCheck: async () => {
    if (++attempts === 1) throw failure
  } })
  const running = t.run()
  try {
    await vi.waitFor(() => expect(t.settledIds).toContain('check-1'), { timeout: 10_000, interval: 50 })
    expect(t.lifecycle.requestCleanup).not.toHaveBeenCalled()
    expect(t.lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
    expect(t.lifecycle.settleRun).not.toHaveBeenCalled()
  } finally {
    t.workerRelease.resolve()
    t.h.controller.abort(new DomainError('RUN_STOPPED', 'Stop requested.', 409))
    await expect(running).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  }
  expect(t.observed).toEqual(['check-1', 'check-1'])
  expect(t.h.completeCalls).toBe(0)
  expect(t.lifecycle.settleRun).toHaveBeenCalledWith(true, false)
}, 20_000)

it('settles a Stop through bounded cleanup while a running check ignores cancellation', async () => {
  const checkStarted = deferred()
  const t = intervalRun({ maxParallelism: 2, observeCheck: async () => {
    checkStarted.resolve()
    await new Promise(() => {})
  } })
  const running = t.run()
  await checkStarted.promise
  t.h.controller.abort(new DomainError('RUN_STOPPED', 'Stop requested.', 409))
  await expect(running).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  expect(t.lifecycle.cancelNativeAndRequestCleanup).toHaveBeenCalledTimes(1)
  expect(t.lifecycle.settleRun).toHaveBeenCalledWith(true, false)
  expect(t.checks).toHaveLength(1)
}, 15_000)

it('checks beside graph work with one parallelism slot and keeps the idle Run until Stop', async () => {
  const checkStarted = deferred()
  const checkRelease = deferred()
  const t = intervalRun({ maxParallelism: 1, observeCheck: async () => {
    t.events.push('check:start')
    checkStarted.resolve()
    await checkRelease.promise
    t.events.push('check:end')
  } })
  const running = t.run()
  await t.workerStarted.promise
  await checkStarted.promise
  expect(t.events).toEqual(['worker:start', 'check:start'])
  expect(t.observed).toEqual(['check-1'])
  t.workerRelease.resolve()
  await vi.waitFor(() => expect(t.events).toEqual(['worker:start', 'check:start', 'worker:end']))
  expect(t.h.completeCalls).toBe(0)
  expect(t.lifecycle.finishCleanup).not.toHaveBeenCalled()
  checkRelease.resolve()
  await vi.waitFor(() => expect(t.events).toContain('check:end'))
  t.h.controller.abort(new DomainError('RUN_STOPPED', 'Stop requested.', 409))
  await expect(running).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  expect(t.events).toEqual(['worker:start', 'check:start', 'worker:end', 'check:end'])
  expect(t.h.completeCalls).toBe(0)
  expect(t.checks).toHaveLength(1)
  expect(t.lifecycle.settleRun).toHaveBeenCalledWith(true, false)
}, 15_000)

it('re-observes a check whose cleanup failed before admitting another', async () => {
  let attempts = 0
  const t = intervalRun({ maxParallelism: 2, observeCheck: async () => {
    if (++attempts === 1) throw new Error('native close failed')
  } })
  const running = t.run()
  await vi.waitFor(() => expect(t.settledIds).toContain('check-1'), { timeout: 10_000, interval: 50 })
  t.workerRelease.resolve()
  await vi.waitFor(() => expect(t.events).toContain('worker:end'))
  t.h.controller.abort(new DomainError('RUN_STOPPED', 'Stop requested.', 409))
  await expect(running).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  expect(t.observed).toEqual(['check-1', 'check-1'])
  expect(t.checks).toHaveLength(1)
  expect(t.settledIds.slice(0, 3)).toEqual([null, null, 'check-1'])
}, 20_000)

it.each(['RUN_STOPPED', 'ENGINE_RESTART'])(
  'preserves the %s reason when cancellation interrupts an idle interval wait', async code => {
    const t = intervalRun({ maxParallelism: 1, observeCheck: async () => undefined })
    const running = t.run()
    const result = Promise.allSettled([running])
    try {
      t.workerRelease.resolve()
      await vi.waitFor(() => expect(t.lifecycle.currentState).toHaveBeenCalled(), { timeout: 10_000 })
      const reason = new DomainError(code, 'Interval wait canceled.', 409)
      t.h.controller.abort(reason)
      expect(await result).toEqual([{ status: 'rejected', reason }])
      expect(t.h.completeCalls).toBe(0)
      if (code === 'ENGINE_RESTART') {
        expect(t.lifecycle.requestCleanup).not.toHaveBeenCalled()
        expect(t.lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
        expect(t.lifecycle.settleRun).not.toHaveBeenCalled()
      } else {
        expect(t.lifecycle.cancelNativeAndRequestCleanup).toHaveBeenCalledTimes(1)
        expect(t.lifecycle.settleRun).toHaveBeenCalledWith(true, false)
      }
    } finally {
      t.h.controller.abort(new DomainError('ENGINE_RESTART', 'Test cleanup.', 409))
      await result
    }
  }, 15_000,
)
