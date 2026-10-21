import { expect, it } from 'vitest'
import { publicationSignal } from './helpers/publicationSignal.js'

it('wakes waiting readers immediately without a polling interval', async () => {
  const signal = publicationSignal()
  const first = signal.next()
  const second = signal.next()
  signal.notify()
  await Promise.all([first, second])
  expect(signal.next()).not.toBe(first)
})

it('retains a notification that arrives while a consumer is reading committed state', async () => {
  const signal = publicationSignal()
  const next = signal.next()
  signal.notify()
  await Promise.resolve()
  await next
  const following = signal.next()
  signal.notify()
  await following
})
