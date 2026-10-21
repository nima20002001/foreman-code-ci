import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { holdCrashCut, observeCrashTask } from './helpers/eng06CrashCut.testSupport.js'

describe('ENG06 abrupt crash-cut barrier', () => {
  it('holds the original call until shutdown releases it and preserves the exact rejection', async () => {
    const interrupted = new Error('ENGINE_RESTART'), cut = holdCrashCut<{ id: string }>(interrupted)
    let ended = false
    const task = observeCrashTask(cut.hold({ id: 'original' })).then((outcome) => { ended = true; return outcome })
    assert.deepEqual(await cut.wait(task), { id: 'original' })
    await Promise.resolve()
    assert.equal(ended, false)
    assert.equal(cut.visits, 1)
    cut.release()
    const outcome = await task
    assert.equal(outcome.status, 'rejected')
    if (outcome.status === 'rejected') assert.equal(outcome.reason, interrupted)
  })

  it('captures the cut value without sharing the caller object', async () => {
    const cut = holdCrashCut<{ id: string }>(new Error('ENGINE_RESTART'))
    const input = { id: 'original' }, task = observeCrashTask(cut.hold(input))
    input.id = 'changed'
    assert.deepEqual(await cut.wait(task), { id: 'original' })
    cut.release(); await task
  })

  it('propagates the engine abort reason instead of a separate injected restart error', async () => {
    const injected = new Error('ENGINE_RESTART')
    const reason = new Error('ENGINE_RESTART')
    const controller = new AbortController()
    const cut = holdCrashCut<string>(injected)
    const task = observeCrashTask(cut.hold('original', controller.signal))
    await cut.wait(task)
    // Closure releases the cut synchronously before the engine aborts its drive.
    cut.release()
    controller.abort(reason)
    const outcome = await task
    assert.equal(outcome.status, 'rejected')
    if (outcome.status === 'rejected') assert.equal(outcome.reason, reason)
    assert.equal(cut.visits, 1)
  })

  it('reports an early product failure instead of timing out or replacing it with teardown', async () => {
    const cut = holdCrashCut<string>(new Error('ENGINE_RESTART')), failure = new Error('actual product failure')
    await assert.rejects(cut.wait(observeCrashTask(Promise.reject(failure))), (error) => error === failure)
    cut.release()
  })

  it('rejects a runtime that completes without reaching the cut', async () => {
    const cut = holdCrashCut<string>(new Error('ENGINE_RESTART'))
    await assert.rejects(cut.wait(observeCrashTask(Promise.resolve())), /finished before reaching/)
    cut.release()
  })

  it('bounds waiting for an unreachable cut', async () => {
    const cut = holdCrashCut<string>(new Error('ENGINE_RESTART'))
    await assert.rejects(cut.wait(new Promise(() => undefined), 5), /did not reach/)
    cut.release()
  })

  it('rejects a second old-runtime visit instead of turning the cut into a retry fixture', async () => {
    const cut = holdCrashCut<string>(new Error('ENGINE_RESTART'))
    const first = observeCrashTask(cut.hold('original'))
    await cut.wait(first)
    await assert.rejects(cut.hold('replayed'), /old runtime retried/)
    assert.equal(cut.visits, 2)
    cut.release(); await first
  })

  it('allows idempotent finally-block release without accepting the held operation', async () => {
    const cut = holdCrashCut<string>(new Error('ENGINE_RESTART')), task = observeCrashTask(cut.hold('original'))
    await cut.wait(task)
    cut.release(); cut.release()
    assert.equal((await task).status, 'rejected')
  })
})
