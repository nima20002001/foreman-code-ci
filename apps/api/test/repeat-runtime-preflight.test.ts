import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'

function fixture() {
  const graph = graphHarness(a1Scenario('single', 'preflight-recovery'))
  const lifecycle = {
    preflight: vi.fn(async () => {}),
    markRunning: vi.fn(async () => {}),
    currentState: vi.fn(async () => ({ executionState: 'running', stopRequested: false })),
    persistWait: vi.fn(async () => false),
    requestCleanup: vi.fn(async () => {}),
    cancelNativeAndRequestCleanup: vi.fn(async () => true),
    settleRun: vi.fn(async () => {}),
    finishNative: vi.fn(async () => {}),
    finishCleanup: vi.fn(async () => {}),
  } satisfies RepeatRuntimeLifecycle
  const execute = () => executeRepeatRuntime({ ...graph.input, owner: { assertOwned() {} }, lifecycle })
  return { graph, lifecycle, execute }
}

it('retains the saved checkpoint after preflight exhausts the database retry window', async () => {
  const h = fixture()
  await h.graph.run()
  const checkpoint = await h.graph.graph.getState(h.graph.config)
  const executions = [...h.graph.executions.values()]
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  h.lifecycle.preflight.mockImplementation(async () => {
    if (h.lifecycle.preflight.mock.calls.length > 1) now += 30_001
    throw timeout
  })
  try {
    await expect(h.execute()).rejects.toMatchObject({
      code: 'DATABASE_RETRY_DEADLINE_EXCEEDED', cause: timeout, attempts: 2,
    })
    expect(h.lifecycle.requestCleanup).not.toHaveBeenCalled()
    expect(h.lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
    expect(h.lifecycle.settleRun).not.toHaveBeenCalled()
    expect(await h.graph.graph.getState(h.graph.config)).toEqual(checkpoint)
    expect([...h.graph.executions.values()]).toEqual(executions)

    h.lifecycle.preflight.mockResolvedValue(undefined)
    await h.execute()
    expect(h.lifecycle.markRunning).toHaveBeenCalledTimes(1)
    expect(h.lifecycle.finishCleanup).toHaveBeenCalledTimes(1)
    expect([...h.graph.executions.values()]).toEqual(executions)
    expect(h.graph.observations).toHaveLength(1)
  } finally {
    clock.mockRestore()
  }
})

it('leaves transient preflight transport failures available for reconciliation', async () => {
  const h = fixture()
  const failure = new DomainError('DEVICE_CONNECTION_UNAVAILABLE', 'Connection unavailable.', 503)
  h.lifecycle.preflight.mockRejectedValue(failure)
  await expect(h.execute()).rejects.toBe(failure)
  expect(h.lifecycle.requestCleanup).not.toHaveBeenCalled()
  expect(h.lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
  expect(h.lifecycle.settleRun).not.toHaveBeenCalled()
  expect(h.graph.candidateIds).toEqual([])
})

it('still settles a concrete permanent preflight rejection', async () => {
  const h = fixture()
  const failure = new DomainError('ACCESS_DENIED', 'Run access was revoked.', 403)
  h.lifecycle.preflight.mockRejectedValue(failure)
  await expect(h.execute()).rejects.toBe(failure)
  expect(h.lifecycle.requestCleanup).toHaveBeenCalledTimes(1)
  expect(h.lifecycle.cancelNativeAndRequestCleanup).toHaveBeenCalledTimes(1)
  expect(h.lifecycle.settleRun).toHaveBeenCalledWith(false, false)
  expect(h.graph.candidateIds).toEqual([])
})
