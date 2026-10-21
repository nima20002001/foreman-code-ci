import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'

afterEach(() => vi.restoreAllMocks())

it.each(['put', 'putWrites'] as const)(
  'reports a background %s failure to its owning Run without an unhandled rejection', async operation => {
    const h = graphHarness(a1Scenario('parallel', `checkpoint-failure-${operation}`), {
      beforeObserve: async () => { await delay(50) },
    })
    const failure = Object.assign(new Error('Database operation retry deadline exceeded.', {
      cause: new Error('Query read timeout'),
    }), { code: 'DATABASE_RETRY_DEADLINE_EXCEEDED' })
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: async () => {}, markRunning: async () => {},
      currentState: async () => ({ executionState: 'running', stopRequested: false }),
      persistWait: async () => false,
      requestCleanup: vi.fn(async () => {}), cancelNativeAndRequestCleanup: vi.fn(async () => true),
      settleRun: vi.fn(async () => {}), finishNative: vi.fn(async () => {}), finishCleanup: vi.fn(async () => {}),
    }
    const unhandled: unknown[] = []
    const onRejection = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      const obstruction = vi.spyOn(h.input.checkpointer, operation).mockRejectedValueOnce(failure)
      const execute = () => executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })
      await expect(execute()).rejects.toBe(failure)
      await delay(0)
      expect(unhandled).toEqual([])
      expect(h.completeCalls).toBe(0)
      expect(lifecycle.finishNative).not.toHaveBeenCalled()
      expect(lifecycle.finishCleanup).not.toHaveBeenCalled()
      obstruction.mockRestore()
      const candidates = [...h.candidateIds]
      await execute()
      expect(h.completeCalls).toBe(1)
      expect(h.candidateIds).toEqual(candidates)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  },
)
