import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'
import { transientExecutionFailure } from '../src/modules/runs/executionRetryPolicy.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { repeatNodeAction, repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import { nativeCompleted, nativeFixture, nativeStored } from './eng04-native-fixtures.js'

afterEach(() => vi.unstubAllEnvs())

it.each([
  { code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', abandoned: false },
  { code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', abandoned: false },
  { code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', abandoned: true },
  { code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', abandoned: true },
])('starts a fresh attempt after $code (already abandoned: $abandoned)', async ({ code, abandoned }) => {
  vi.stubEnv('FOREMAN_EXECUTION_RETRY_BACKOFF_MS', '0')
  const f = nativeFixture()
  const first: HarnessExecution = { ...f.execution, state: abandoned ? 'running' : 'starting' }
  if (!abandoned) delete first.nativeSessionId
  const rows = new Map([[first.id, first]])
  const settled = new Set<string>()
  const observed: HarnessExecution[] = []
  const failure = nativePersistenceRedactor([]).error(new DeviceApplicationError(code))
  const store = {
    readExecution: async (id: string) => nativeStored(rows.get(id)!, f),
    settleNativeExecution: async (id: string) => { settled.add(id) },
  }
  const abandonAttempt = vi.fn(async (id: string, result: ExecutionResult) => {
    rows.set(id, { ...rows.get(id)!, state: 'completed', finishedAt: new Date().toISOString(), result })
  })
  const driver = repeatExecutionDriver({ scope: f.scope, version: f.version, store,
    owner: { assertOwned: () => {} }, abandonAttempt,
    observeExact: async execution => {
      observed.push(execution)
      if (execution.attempt === 1) {
        if (abandoned) await abandonAttempt(execution.id, transientExecutionFailure(failure))
        throw failure
      }
      rows.set(execution.id, nativeCompleted({ ...execution, nativeSessionId: 'fresh-native-session' }))
    },
  })
  const acceptTerminal = vi.fn(async (id: string, candidate: (attempt: number) => HarnessExecution) => {
    expect(settled.has(id)).toBe(true)
    const terminal = rows.get(id)!
    if (terminal.result?.outcome === 'failed') {
      expect(terminal.result.error).toMatchObject({ code, retryable: true })
      const next = { ...candidate(2), input: first.input }
      rows.set(next.id, next)
      return { kind: 'retry' as const, execution: next }
    }
    return { kind: 'accepted' as const, resolution: repeatTerminalResolution(f.version, f.scope, f.ref, terminal) }
  })
  const action = repeatNodeAction({ runId: f.scope.runId, driver, limiter: new ExecutionLimiter(1),
    signal: new AbortController().signal, store: {
      admit: async () => ({ kind: 'admitted', execution: first, reused: true }), acceptTerminal,
    } })
  const checkpoint = await action(f.ref,
    { runId: f.scope.runId, occurrences: {}, boundaries: {}, executionIds: {} })
  expect(observed.map(execution => execution.attempt)).toEqual([1, 2])
  expect(observed[1]!.id).not.toBe(first.id)
  expect(observed[1]!.input).toEqual(first.input)
  const fresh = rows.get(observed[1]!.id)!
  expect(fresh.nativeSessionId).toBe('fresh-native-session')
  expect(fresh.nativeSessionId).not.toBe(first.nativeSessionId)
  expect(checkpoint.executionIds?.[f.ref.nodeId]?.executionId).toBe(fresh.id)
  expect(acceptTerminal).toHaveBeenCalledTimes(2)
  expect(abandonAttempt).toHaveBeenCalledOnce()
})
