import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForChildReady } from './helpers/remoteReviewReadiness.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  let ready = false
  child.on('message', message => { ready = message === 'ready' })
  const wait = () => waitForChildReady(child as unknown as ChildProcess,
    () => ready, 'child readiness', () => 'Child exited before readiness')
  return { child, wait }
}

it('resolves on the readiness message without advancing time', async () => {
  const { child, wait } = fixture()
  const task = wait()
  child.emit('message', 'ready')
  await expect(task).resolves.toBeUndefined()
  expect(child.listenerCount('message')).toBe(1)
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('reads readiness that was reported before subscribing', async () => {
  const { child, wait } = fixture()
  child.emit('message', 'ready')
  await expect(wait()).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps waiting through an unrelated IPC message', async () => {
  const { child, wait } = fixture()
  const task = wait()
  let done = false
  void task.then(() => { done = true })
  child.emit('message', 'starting')
  await Promise.resolve()
  expect(done).toBe(false)
  child.emit('message', 'ready')
  await task
})

it('rejects immediately when the child exits', async () => {
  const { child, wait } = fixture()
  const task = wait()
  child.emit('exit', 1)
  await expect(task).rejects.toThrow('Child exited before readiness')
  expect(vi.getTimerCount()).toBe(0)
})

it('propagates a spawn error and removes its listeners', async () => {
  const { child, wait } = fixture()
  const task = wait()
  const error = new Error('Spawn failed')
  child.emit('error', error)
  await expect(task).rejects.toBe(error)
  expect(child.listenerCount('message')).toBe(1)
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains the readiness deadline and cleans up after expiry', async () => {
  const { child, wait } = fixture()
  const rejected = expect(wait()).rejects.toThrow('Timed out waiting for child readiness.')
  await vi.advanceTimersByTimeAsync(90_000)
  await rejected
  expect(child.listenerCount('message')).toBe(1)
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
