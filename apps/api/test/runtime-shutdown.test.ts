import { describe, expect, it, vi } from 'vitest'

import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'
import { deferred } from './helpers/deferred.js'

describe('runtime shutdown ownership barrier', () => {
  it('signals every runtime before waiting; drains producers, disposes, then releases', async () => {
    const stop = deferred(); const producer = deferred(); const disposal = deferred()
    const disposing = deferred(); const draining = deferred()
    const calls: string[] = []
    const releaseOwnership = vi.fn(async () => { calls.push('unlock') })
    const shutdown = new RuntimeShutdown({
      stop: [
        { name: 'chat', run: () => { calls.push('signal chat'); return stop.promise } },
        { name: 'reviews', run: () => { calls.push('signal reviews') } },
        { name: 'engine', run: () => { calls.push('signal engine') } },
      ],
      drain: [{ name: 'recovery', run: () => { calls.push('drain'); draining.resolve(); return producer.promise } }],
      dispose: [{ name: 'managers', run: () => { calls.push('dispose'); disposing.resolve(); return disposal.promise } }],
      releaseOwnership,
    })
    shutdown.begin()
    expect(calls).toEqual(['signal chat', 'signal reviews', 'signal engine'])
    const first = shutdown.finish()
    expect(shutdown.finish()).toBe(first)
    expect(releaseOwnership).not.toHaveBeenCalled()
    stop.resolve()
    await draining.promise
    expect(calls).not.toContain('dispose')
    producer.resolve()
    await disposing.promise
    expect(releaseOwnership).not.toHaveBeenCalled()
    disposal.resolve()
    await first
    expect(calls).toEqual(['signal chat', 'signal reviews', 'signal engine', 'drain', 'dispose', 'unlock'])
    await shutdown.finish()
    expect(releaseOwnership).toHaveBeenCalledTimes(1)
  })

  it('names the steps a stalled shutdown is still waiting for', async () => {
    const stop = deferred(); const producer = deferred()
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'chat', run: () => stop.promise }, { name: 'engine', run: () => {} }],
      drain: [{ name: 'recovery', run: () => producer.promise }],
      dispose: [],
      releaseOwnership: async () => {},
    })
    expect(shutdown.pending()).toEqual([])
    const finished = shutdown.finish()
    // A production stop sat at systemd's 60 s timeout with no record of what it waited for.
    await vi.waitFor(() => expect(shutdown.pending()).toEqual(['chat']))
    stop.resolve()
    await vi.waitFor(() => expect(shutdown.pending()).toEqual(['recovery']))
    producer.resolve()
    await finished
    expect(shutdown.pending()).toEqual([])
  })

  for (const failing of ['stop', 'drain', 'dispose'] as const) {
    it.each(['throw', 'reject'] as const)(`retains ownership and retries failed cleanup after a ${failing} %s`, async (mode) => {
      const failure = new Error('closure is uncertain')
      const sibling = vi.fn()
      const cleanup = vi.fn(async () => undefined)
      const releaseOwnership = vi.fn(async () => undefined)
      let fail = true
      const step = (stage: string) => ({ name: stage, run: () => {
        if (stage !== failing || !fail) return
        if (mode === 'throw') throw failure
        return Promise.reject(failure)
      } })
      const shutdown = new RuntimeShutdown({
        stop: [step('stop'), { name: 'other stop', run: sibling }], drain: [step('drain')],
        dispose: [step('dispose'), { name: 'other manager', run: cleanup }], releaseOwnership,
      })
      const result = shutdown.finish()
      await expect(result).rejects.toThrow('runtime ownership was not released')
      fail = false
      const retry = shutdown.finish()
      expect(retry).not.toBe(result)
      expect(shutdown.finish()).toBe(retry)
      await retry
      expect(sibling).toHaveBeenCalledTimes(1)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(releaseOwnership).toHaveBeenCalledTimes(1)
    })
  }

  it.each(['begin', 'finish'] as const)('shares one shutdown across synchronous re-entry from %s', async (entry) => {
    let reentered: Promise<void> | undefined
    const releaseOwnership = vi.fn(async () => undefined)
    const stop = vi.fn(() => {
      shutdown.begin()
      reentered = shutdown.finish()
    })
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'reenter', run: stop }],
      drain: [], dispose: [], releaseOwnership,
    })
    void shutdown[entry]()
    const result = shutdown.finish()
    expect(reentered).toBe(result)
    expect(stop).toHaveBeenCalledTimes(1)
    await result
    shutdown.begin()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(releaseOwnership).toHaveBeenCalledTimes(1)
  })

  it('propagates ownership-release failure instead of claiming shutdown succeeded', async () => {
    const failure = new Error('unlock failed')
    const releaseOwnership = vi.fn(async () => { throw failure })
    const shutdown = new RuntimeShutdown({ stop: [], drain: [], dispose: [], releaseOwnership })
    await expect(shutdown.finish()).rejects.toBe(failure)
    await expect(shutdown.finish()).rejects.toBe(failure)
    expect(releaseOwnership).toHaveBeenCalledTimes(2)
  })
})
