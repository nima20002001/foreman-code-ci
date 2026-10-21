import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { executeRepeatEngineStart, type RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import { workHandoffSiblings } from './helpers/workHandoffSiblings.js'

const ports = vi.hoisted(() => ({ read: vi.fn(), runtime: vi.fn() }))
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: ports.read }))
vi.mock('../src/modules/runs/repeatRuntime.js', () => ({
  executeRepeatRuntime: ports.runtime,
  repeatNativeObserver: () => async () => undefined,
  repeatExecutionDriver: () => ({}),
}))

describe('handoff launch failure composition', () => {
  it('persists the execution cause through the engine lifecycle writer', async () => {
    const fixture = workHandoffSiblings()
    ports.read.mockResolvedValue({ run: fixture.run, version: fixture.version,
      configurations: fixture.configurations, stopRequested: false, cleanupPending: false })
    const failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'APP_MCP_PREFLIGHT_FAILED', message: 'The selected MCP configuration is not ready.', retryable: false,
    } }
    const saved: Array<{ executionId: string; failure: ExecutionResult }> = []
    const lifecycle = {
      preflight: async () => undefined,
      markRunning: async () => undefined,
      currentState: async () => ({ executionState: 'running', stopRequested: false }),
      persistWait: async () => false,
      persistDirectionWait: async () => undefined,
      cancelNativeAndRequestCleanup: async () => true,
      settleRun: async () => undefined,
      requestCleanup: async () => undefined,
      finishNative: async () => undefined,
      finishCleanup: async () => undefined,
      async recordExecutionFailure(executionId: string, result: ExecutionResult) {
        expect(this).toBe(lifecycle)
        saved.push({ executionId, failure: result })
      },
    }
    ports.runtime.mockImplementation(async (input: { lifecycle: typeof lifecycle }) => {
      await input.lifecycle.recordExecutionFailure('execution-launch-failed', failure)
    })
    const context = {
      owner: { runId: fixture.run.id, assertOwned() {},
        oneShotConnection: () => ({ transaction: async (work: (sql: object) => Promise<unknown>) => work({}) }) },
      signal: new AbortController().signal, checkpointer: {}, admission: {}, configuredParallelism: 3,
      runtimeRoot: '/synthetic/runtime', factory: { forOwner: () => ({}) },
      native: {}, workflows: {}, locations: {}, nativeBoundaryEvidence: async () => undefined, lifecycle,
    } as unknown as RepeatEngineStartContext

    await executeRepeatEngineStart(context)
    expect(saved).toEqual([{ executionId: 'execution-launch-failed', failure }])
  })
})
