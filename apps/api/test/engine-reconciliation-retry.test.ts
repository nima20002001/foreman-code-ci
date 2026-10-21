import { MemorySaver } from '@langchain/langgraph'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { executeRepeatEngineStart } from '../src/modules/runs/repeatStartComposition.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({ executeRepeatEngineStart: vi.fn() }))

function fixture() {
  const f = makeCurrentWorkflowFixture('reconciliation-retry', 'single')
  const run = { ...f.run, executionState: 'running' as const }
  const owner = {
    runId: run.id, assertOwned() {}, release: vi.fn(async () => {}),
  } as unknown as RunOwnership
  const requestCleanup = vi.fn(async () => {})
  const runs = {
    repeatRepositoryFactory: () => ({}),
    acquireOwnership: vi.fn(async () => owner),
    getRepeatSnapshot: async () => ({ run, version: f.version, configurations: f.configurations,
      stopRequested: false, cleanupPending: false }),
    reconciliationCandidates: async () => [run],
    requestCleanup,
  }
  const native = {
    shareRunOwner: () => () => {},
    requestColdRunCleanup: vi.fn(async () => false),
    reconcileReviews: async () => {},
  }
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new LangGraphWorkflowEngine(runs as unknown as Args[0], {} as Args[1],
    native as unknown as Args[2], new MemorySaver(), '/workspace/runtime',
    {} as Args[5], {} as Args[6], {} as Args[7])
  const runtime = vi.mocked(executeRepeatEngineStart).mockReset()
  const errors: unknown[] = []
  const reconcile = async () => {
    await engine.reconcile(error => errors.push(error))
    await new Promise(resolve => setImmediate(resolve))
  }
  return { run, runs, native, engine, runtime, requestCleanup, errors, reconcile }
}

it.each(['start', 'resume'] as const)(
  'retains and increases pending settlement backoff after successful %s callbacks', async method => {
    const h = fixture()
    const pending = new DomainError('REPEAT_CLEANUP_PENDING', 'Native closure is not confirmed.', 409)
    h.runtime.mockRejectedValue(pending)
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await expect(h.engine[method](h.run.id)).resolves.toBeUndefined()
      let attempts = 1
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]) {
        await h.reconcile()
        expect(h.runtime).toHaveBeenCalledTimes(attempts)
        now += delay - 1
        await h.reconcile()
        expect(h.runtime).toHaveBeenCalledTimes(attempts)
        now++
        await h.reconcile()
        expect(h.runtime).toHaveBeenCalledTimes(++attempts)
      }
      expect(h.requestCleanup).not.toHaveBeenCalled()
      expect(h.errors).toEqual([])

      h.runtime.mockResolvedValue(undefined)
      now += 60_000
      await h.reconcile()
      expect(h.runtime).toHaveBeenCalledTimes(++attempts)
      await h.reconcile()
      expect(h.runtime).toHaveBeenCalledTimes(++attempts)
    } finally {
      clock.mockRestore()
    }
  },
)

it('keeps the settlement retry deadline when a resume also yields pending settlement', async () => {
  const h = fixture()
  h.runtime.mockRejectedValue(new DomainError('APPROVAL_SETTLEMENT_PENDING', 'Approval closure is pending.', 409))
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    await h.reconcile()
    expect(h.runtime).toHaveBeenCalledTimes(1)
    now = 500
    await expect(h.engine.resume(h.run.id)).resolves.toBeUndefined()
    expect(h.runtime).toHaveBeenCalledTimes(2)
    now = 2_499
    await h.reconcile()
    expect(h.runtime).toHaveBeenCalledTimes(2)
    now = 2_500
    await h.reconcile()
    expect(h.runtime).toHaveBeenCalledTimes(3)
    expect(h.requestCleanup).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
  }
})

it.each([
  { code: 'DEVICE_CONNECTION_UNAVAILABLE', permanent: false },
  { code: 'REPEAT_CLEANUP_PENDING', permanent: false },
  { code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT', permanent: true },
])('counts only concrete permanent cleanup failures toward Run failure: $code', async ({ code, permanent }) => {
  const h = fixture()
  const cause = new DomainError(code, 'Native closure unavailable.', 409)
  const failure = new AggregateError([new Error('Recover native lifetime', { cause })], 'Terminal closure unconfirmed.')
  h.native.requestColdRunCleanup.mockRejectedValue(failure)
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await h.reconcile()
      now += 60_000
    }
    expect(h.errors).toEqual(Array.from({ length: 10 }, () => failure))
    expect(h.requestCleanup).toHaveBeenCalledTimes(permanent ? 1 : 0)
    if (permanent) {
      expect(h.requestCleanup).toHaveBeenCalledWith(h.run.id, expect.anything(), {
        outcome: 'failed', error: { code: 'RUN_RECOVERY_FAILED', message: failure.message, retryable: false },
      })
    }
    expect(h.runtime).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
  }
})
