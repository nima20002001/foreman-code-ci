import { expect, it } from 'vitest'
import { ClaudeBoundedQueue } from './queue.js'

it('waits for capacity and preserves control and terminal event order', async () => {
  const queue = new ClaudeBoundedQueue<string>(1)
  await queue.offer('text')
  let accepted = false
  const permission = queue.offer('permission').then(() => { accepted = true })
  await Promise.resolve()
  expect(accepted).toBe(false)
  const iterator = queue[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toBe('text')
  await permission
  const terminal = queue.offer('terminal')
  expect((await iterator.next()).value).toBe('permission')
  await terminal
  queue.close()
  expect((await iterator.next()).value).toBe('terminal')
  expect((await iterator.next()).done).toBe(true)
})

it('releases waiting producers when an observer discards its queue', async () => {
  const queue = new ClaudeBoundedQueue<string>(1)
  await queue.offer('text')
  const pending = queue.offer('permission')
  queue.discard()
  await pending
  await queue.offer('terminal')
  expect((await queue[Symbol.asyncIterator]().next()).value).toBe('terminal')
})

it('rejects blocked producers on failure while retaining earlier events', async () => {
  const queue = new ClaudeBoundedQueue<string>(1)
  await queue.offer('text')
  const failure = new Error('native error')
  const pending = expect(queue.offer('permission')).rejects.toBe(failure)
  queue.close(failure)
  await pending
  const iterator = queue[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toBe('text')
  await expect(iterator.next()).rejects.toBe(failure)
})

it('withdraws blocked input when its admission signal is aborted', async () => {
  const queue = new ClaudeBoundedQueue<string>(1)
  await queue.offer('first')
  const admission = new AbortController()
  const reason = new Error('Admission canceled')
  const canceled = expect(queue.offer('canceled', admission.signal)).rejects.toBe(reason)
  admission.abort(reason)
  await canceled
  const iterator = queue[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toBe('first')
  await queue.offer('next')
  expect((await iterator.next()).value).toBe('next')
})
