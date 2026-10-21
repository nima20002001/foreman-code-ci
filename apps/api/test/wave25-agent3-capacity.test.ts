import { describe, expect, it, vi } from 'vitest'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { deferred } from './helpers/deferred.js'

const signal = () => new AbortController().signal

describe('Agent 3 bounded worker admission', () => {
  it('gives a later Run a turn before draining a wide earlier Run', async () => {
    const gate = new RunnerAdmission(1, 8, 2), held = deferred(), entered = deferred(), order: string[] = []
    const first = gate.run('wide', signal(), async () => { entered.resolve(); await held.promise })
    await entered.promise
    const pending = ['wide', 'wide', 'wide', 'later'].map((id) => gate.run(id, signal(), async () => { order.push(id) }))
    expect(gate.pending).toBe(4)
    held.resolve(); await Promise.all([first, ...pending])
    expect(order).toEqual(['wide', 'later', 'wide', 'wide'])
    expect(gate.inFlight).toBe(0); expect(gate.pending).toBe(0)
  })
  it('removes a stopped queued execution without invoking its launch callback', async () => {
    const gate = new RunnerAdmission(1), held = deferred(), entered = deferred(), stop = new AbortController()
    const first = gate.run('first', signal(), async () => { entered.resolve(); await held.promise })
    await entered.promise
    const launch = vi.fn(async () => undefined)
    const queued = gate.run('stopped', stop.signal, launch)
    stop.abort(new Error('queued Stop'))
    await expect(queued).rejects.toThrow('queued Stop')
    expect(launch).not.toHaveBeenCalled(); expect(gate.pending).toBe(0)
    held.resolve(); await first
    await gate.run('next', signal(), launch)
    expect(launch).toHaveBeenCalledTimes(1); expect(gate.inFlight).toBe(0)
  })
  it('bounds waiting callbacks and queued Run identities without borrowing review capacity', async () => {
    const gate = new RunnerAdmission(1, 2, 1), held = deferred(), entered = deferred()
    const first = gate.run('active', signal(), async () => { entered.resolve(); await held.promise })
    await entered.promise
    const one = gate.run('queued', signal(), async () => undefined)
    const launch = vi.fn(async () => undefined)
    await expect(gate.run('another', signal(), launch)).rejects.toMatchObject({ code: 'RUNNER_ADMISSION_FULL' })
    const two = gate.run('queued', signal(), async () => undefined)
    await expect(gate.run('queued', signal(), launch)).rejects.toMatchObject({ code: 'RUNNER_ADMISSION_FULL' })
    const review = vi.fn(async () => 'review finished')
    expect(await review()).toBe('review finished') // independent existing review lane never calls this gate
    expect(launch).not.toHaveBeenCalled()
    held.resolve(); await Promise.all([first, one, two])
  })
  it('releases slots after callback failure and abort immediately after wakeup', async () => {
    const gate = new RunnerAdmission(1), held = deferred(), stop = new AbortController(), entered = deferred()
    const first = gate.run('first', signal(), async () => { entered.resolve(); await held.promise; stop.abort() })
    await entered.promise
    const canceled = gate.run('canceled', stop.signal, async () => { throw new Error('must not start') })
    const canceledCheck = expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    const following = gate.run('following', signal(), async () => { throw new Error('synthetic task failure') })
    const followingCheck = expect(following).rejects.toThrow('synthetic task failure')
    held.resolve(); await Promise.all([first, canceledCheck, followingCheck])
    expect(await gate.run('last', signal(), async () => 7)).toBe(7)
    expect(gate.inFlight).toBe(0)
  })
  it('keeps the run-local limit and waiting bound independent of board size', async () => {
    const limiter = new ExecutionLimiter(1, 1), held = deferred(), entered = deferred()
    const first = limiter.run(signal(), async () => { entered.resolve(); await held.promise })
    await entered.promise
    const next = limiter.run(signal(), async () => 2)
    await expect(limiter.run(signal(), async () => 3)).rejects.toThrow('RUNNER_ADMISSION_FULL')
    held.resolve(); expect(await next).toBe(2); await first
  })
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid configured bounds %s', (maximum) => {
    expect(() => new RunnerAdmission(maximum)).toThrow()
    expect(() => new ExecutionLimiter(maximum)).toThrow()
  })
})
