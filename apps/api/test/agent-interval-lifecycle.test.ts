import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { IntervalCheckAcceptedInputSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { nextIntervalCheckAt } from '../src/modules/runs/intervalChecks.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import type { RepeatTickAdmission } from '../src/modules/runs/repeatPostgres.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'

it('continues checks past the former history limit', () => {
  const facts = { openId: null, openTick: null, graphOpen: false,
    lastFinished: '2026-01-01T00:00:00.000Z', lastTick: 1000,
    lastTickId: 'check-1000', runChecks: 1000 }
  expect(nextIntervalCheckAt(facts, 10)).toBe('2026-01-01T00:00:10.000Z')
  expect(IntervalCheckAcceptedInputSchema.parse({ executionSemanticsVersion: 3,
    runInput: {}, occurrence: null, entry: null, predecessors: [],
    tick: { index: 1001, everySeconds: 10 } }).tick.index).toBe(1001)
})

it('keeps checking a settled graph, recovers its idle checkpoint, and ends only on Stop', async () => {
  const f = a1Scenario('single', 'interval-idle')
  const configuration = f.configurations[0]!
  if (configuration.harness.harness !== 'codex') throw new Error('Expected Codex')
  configuration.harness.advanced = { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' }
  const node = f.version.definition.nodes[0]!
  node.interval = { everySeconds: 10 }
  const h = graphHarness(f)
  const checks: HarnessExecution[] = []
  let allocating = false
  const admitTick = async (_nodeId: string, candidate: () => HarnessExecution,
    settledId: string | null): Promise<RepeatTickAdmission> => {
    if (!h.outside.has(node.id)) return { kind: 'wait', dueAt: null }
    const latest = checks.at(-1)
    if (latest && latest.id !== settledId) return { kind: 'busy', execution: latest }
    allocating = true
    try {
      const execution = candidate()
      checks.push(execution)
      return { kind: 'admitted', execution }
    } finally { allocating = false }
  }
  const lifecycle: RepeatRuntimeLifecycle = {
    preflight: async () => undefined, markRunning: async () => undefined,
    currentState: async () => ({ executionState: 'running', stopRequested }),
    persistWait: async () => false, requestCleanup: vi.fn(async () => undefined),
    cancelNativeAndRequestCleanup: vi.fn(async () => true), settleRun: vi.fn(async () => undefined),
    finishNative: vi.fn(async () => undefined), finishCleanup: vi.fn(async () => undefined),
  }
  let stopRequested = false
  const execute = (signal: AbortSignal) => executeRepeatRuntime({ ...h.input, signal,
    store: { ...h.input.store, admitTick }, lifecycle, owner: { assertOwned() {} },
    driver: {
      candidate: (ref, attempt) => allocating ? HarnessExecutionSchema.parse({
        id: `check-${checks.length + 1}`, runId: f.run.id, workflowNodeId: node.id,
        agentId: node.agentId, agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input: { tick: { index: checks.length + 1, everySeconds: 10 } },
        state: 'queued', createdAt: f.createdAt,
      }) : h.input.driver.candidate(ref, attempt),
      observe: async (execution, observationSignal) => {
        if (!execution.id.startsWith('check-')) return h.input.driver.observe(execution, observationSignal)
        observationSignal.throwIfAborted()
      },
    },
  })
  const first = new AbortController()
  const firstRun = execute(first.signal)
  const firstResult = Promise.allSettled([firstRun])
  let restarted: AbortController | undefined
  let secondResult: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(checks.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
    expect(h.completeCalls).toBe(0)
    expect(lifecycle.requestCleanup).not.toHaveBeenCalled()
    const restartReason = new DomainError('ENGINE_RESTART', 'Restart requested.', 409)
    first.abort(restartReason)
    expect((await firstResult)[0]).toEqual({ status: 'rejected', reason: restartReason })
    const beforeRestart = checks.length
    restarted = new AbortController()
    const secondRun = execute(restarted.signal)
    secondResult = Promise.allSettled([secondRun])
    await vi.waitFor(() => expect(checks.length).toBeGreaterThan(beforeRestart), { timeout: 10_000 })
    expect(h.observations).toHaveLength(1)
    expect(h.completeCalls).toBe(0)
    stopRequested = true
    restarted.abort(new DomainError('RUN_STOPPED', 'Stop requested.', 409))
    expect(await secondResult).toMatchObject([{ status: 'rejected', reason: { code: 'RUN_STOPPED' } }])
    expect(lifecycle.settleRun).toHaveBeenCalledWith(true, false)
  } finally {
    first.abort(new DomainError('ENGINE_RESTART', 'Test cleanup.', 409))
    restarted?.abort(new DomainError('ENGINE_RESTART', 'Test cleanup.', 409))
    await firstResult
    await secondResult
  }
}, 25_000)
