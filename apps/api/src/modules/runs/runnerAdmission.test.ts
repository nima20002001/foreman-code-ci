import { describe, expect, it, vi } from 'vitest'
import { RunnerAdmission } from './runnerAdmission.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const signal = () => new AbortController().signal

describe('Agent startup capacity', () => {
  it('starts Agents on independent computers while another computer is full', async () => {
    const gate = new RunnerAdmission(1)
    const held = deferred()
    const started: string[] = []
    const first = gate.run('run-first', signal(), async () => {
      started.push('main')
      await held.promise
    }, { hostKey: 'main' })
    const laptop = gate.run('run-second', signal(), async () => {
      started.push('laptop')
    }, { hostKey: 'device:host-other' })
    try {
      await Promise.resolve()
      expect(started).toEqual(['main', 'laptop'])
    } finally {
      held.resolve()
      await Promise.all([first, laptop])
    }
  })

  it('releases startup capacity while the native Agent keeps working', async () => {
    const gate = new RunnerAdmission(1)
    const held = deferred()
    const started: string[] = []
    const first = gate.run('run-first', signal(), async release => {
      started.push('first')
      release?.()
      release?.()
      await held.promise
    })
    const second = gate.run('run-second', signal(), async () => { started.push('second') })
    try {
      await Promise.resolve()
      expect(started).toEqual(['first', 'second'])
      expect(gate.pending).toBe(0)
    } finally {
      held.resolve()
      await Promise.all([first, second])
    }
    expect(gate.inFlight).toBe(0)
  })

  it('keeps same-computer startup limits, Run fairness and cancellation', async () => {
    const gate = new RunnerAdmission(1)
    const held = deferred()
    const stop = new AbortController()
    const order: string[] = []
    const first = gate.run('wide', signal(), () => held.promise)
    const canceled = vi.fn(async () => undefined)
    const queued = gate.run('stopped', stop.signal, canceled)
    const tasks = ['wide', 'wide', 'later'].map(runId =>
      gate.run(runId, signal(), async () => { order.push(runId) }))
    stop.abort(new Error('Stopped before startup'))
    await expect(queued).rejects.toThrow('Stopped before startup')
    expect(canceled).not.toHaveBeenCalled()
    expect(order).toEqual([])
    held.resolve()
    await Promise.all([first, ...tasks])
    expect(order).toEqual(['wide', 'later', 'wide'])
    expect(gate.inFlight).toBe(0)
  })
})
