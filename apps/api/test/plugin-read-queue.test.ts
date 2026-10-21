import { expect, it } from 'vitest'
import { PluginReadQueue } from '../src/modules/harnesses/pluginReadQueue.js'

it('coalesces equivalent reads, bounds concurrency, and does not cache qualification', async () => {
  const queue = new PluginReadQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0; let maximum = 0; let calls = 0
  const work = async () => { calls++; active++; maximum = Math.max(maximum, active); await gate; active--; return calls }
  const signal = new AbortController().signal
  const one = queue.run('catalog', work, signal)
  const two = queue.run('catalog', work, signal)
  const three = queue.run(undefined, work, signal)
  release(); await Promise.all([one, two, three]); await queue.drain()
  expect(calls).toBe(2); expect(maximum).toBe(1)
  await queue.run('catalog', work, signal)
  expect(calls).toBe(3)
})
it('does not cancel a shared read until every caller has canceled', async () => {
  const queue = new PluginReadQueue()
  const first = new AbortController(); const second = new AbortController()
  let shared!: AbortSignal
  const work = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    shared = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const one = queue.run('catalog', work, first.signal); const two = queue.run('catalog', work, second.signal)
  const observed = Promise.allSettled([one, two])
  first.abort(); expect(shared.aborted).toBe(false)
  second.abort(); expect(shared.aborted).toBe(true)
  await observed; await queue.drain()
})
it('bounds admission and drains abandoned queued requests without launching them', async () => {
  const queue = new PluginReadQueue(2)
  const stop = new AbortController()
  let release!: () => void; let queued = 0
  const active = queue.run(undefined, () => new Promise<void>((resolve) => { release = resolve }), stop.signal)
  const waiting = queue.run(undefined, async () => { queued++ }, stop.signal)
  const observed = Promise.allSettled([active, waiting])
  await expect(queue.run(undefined, async () => {}, stop.signal)).rejects.toThrow('full')
  stop.abort(); release(); await observed; await queue.drain()
  expect(queued).toBe(0)
})
