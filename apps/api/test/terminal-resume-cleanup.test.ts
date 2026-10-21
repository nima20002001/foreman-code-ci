import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'
import { deferred } from './helpers/deferred.js'

const runtime = vi.hoisted(() => ({ work: vi.fn<(context: RepeatEngineStartContext) => Promise<void>>() }))
vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({
  executeRepeatEngineStart: (context: RepeatEngineStartContext) => runtime.work(context),
}))

function fixture() {
  const source = currentUnitSnapshot('terminal-resume')
  const run = structuredClone(source.run)
  const cleanup = { pending: false }
  const owner = { runId: run.id, assertOwned() {}, release: vi.fn(async () => undefined) }
  const runs = {
    repeatRepositoryFactory: () => ({}),
    acquireOwnership: vi.fn(async () => owner),
    getRepeatSnapshot: async () => ({
      run: structuredClone(run), version: source.version, configurations: source.configurations,
      stopRequested: false, cleanupPending: cleanup.pending,
    }),
    requestCleanup: vi.fn(async () => { cleanup.pending = true }),
    finishCleanup: vi.fn(async () => { cleanup.pending = false }),
  }
  const native = {
    shareRunOwner: () => () => {},
    adoptRunOwner: vi.fn(),
    requestColdRunCleanup: async () => false,
    finishRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(),
    executionCapacity: () => undefined, reconcileWorkflowControls: async () => undefined,
  }
  const onTerminal = vi.fn(async () => undefined)
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new LangGraphWorkflowEngine(
    runs as unknown as Args[0], {} as Args[1], native as unknown as Args[2],
    new MemorySaver(), '/workspace/project', {} as Args[5], {} as Args[6], {} as Args[7], onTerminal,
  )
  function complete() {
    run.executionState = 'completed'
    run.outcome = 'succeeded'
  }
  return { run, runs, native, owner, cleanup, engine, onTerminal, complete }
}

describe('terminal resume cleanup', () => {
  beforeEach(() => {
    runtime.work.mockReset()
  })

  it.each([1, 3])('does not reopen cleanup when %i queued resumes follow successful cleanup', async (resumeCount) => {
    const f = fixture()
    const entered = deferred()
    const finish = deferred()
    runtime.work.mockImplementation(async (context) => {
      entered.resolve()
      await finish.promise
      f.complete()
      await context.lifecycle.requestCleanup()
      await context.lifecycle.finishNative()
      await context.lifecycle.finishCleanup()
    })
    const active = f.engine.start(f.run.id)
    await entered.promise
    const queued = Array.from({ length: resumeCount }, () => f.engine.resume(f.run.id))
    finish.resolve()
    await active
    expect(f.cleanup.pending).toBe(false)
    expect(f.runs.requestCleanup).toHaveBeenCalledTimes(1)
    await Promise.all(queued)
    expect(f.runs.requestCleanup).toHaveBeenCalledTimes(1)
    expect(f.cleanup.pending).toBe(false)
    expect(runtime.work).toHaveBeenCalledTimes(1)
    expect(f.owner.release).toHaveBeenCalledTimes(resumeCount + 1)
    expect(f.onTerminal).toHaveBeenCalledTimes(resumeCount + 1)
    expect(f.native.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps a settled terminal run unchanged when resuming it again', async () => {
    const f = fixture()
    f.complete()
    await f.engine.resume(f.run.id)
    expect(f.runs.requestCleanup).not.toHaveBeenCalled()
    expect(f.cleanup.pending).toBe(false)
    expect(f.onTerminal).toHaveBeenCalledWith(f.run.id, 'The Run stopped or completed.')
    expect(f.native.finishRun).toHaveBeenCalled()
  })

  it.each(['failed', 'canceled'] as const)(
    'keeps a settled %s Run closed across repeated resumes', async (outcome) => {
      const f = fixture()
      f.complete()
      f.run.outcome = outcome
      f.run.result = outcome === 'failed' ? {
        outcome,
        error: {
          code: 'ROOT_OWNER_PREPARATION_CONFLICT',
          message: 'Root owner preparation failed with status 409.',
          retryable: false,
        },
      } : { outcome }
      f.run.finishedAt = '2026-10-01T00:00:00.000Z'
      const settled = await f.runs.getRepeatSnapshot()
      const readSettledRun = async () => {
        expect(await f.runs.getRepeatSnapshot()).toEqual(settled)
        return undefined
      }
      f.native.cancelRun.mockImplementation(readSettledRun)
      f.native.finishRun.mockImplementation(readSettledRun)
      f.onTerminal.mockImplementation(readSettledRun)

      for (let resume = 0; resume < 3; resume++) {
        await f.engine.resume(f.run.id)
        expect(await f.runs.getRepeatSnapshot()).toEqual(settled)
      }
    },
  )

  it('still finishes pending cleanup on a terminal run', async () => {
    const f = fixture()
    f.complete()
    f.cleanup.pending = true
    await f.engine.resume(f.run.id)
    expect(f.runs.requestCleanup).toHaveBeenCalledOnce()
    expect(f.runs.finishCleanup).toHaveBeenCalledOnce()
    expect(f.cleanup.pending).toBe(false)
    expect(f.native.cancelRun).not.toHaveBeenCalled()
  })
})
