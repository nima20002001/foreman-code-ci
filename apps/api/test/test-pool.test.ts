import { EventEmitter } from 'node:events'
import type { PoolConfig } from 'pg'
import { expect, it, vi } from 'vitest'
import { createTestPool } from './helpers/testPool.mjs'

class ClosingClient extends EventEmitter {
  closeCallback?: () => void

  connect(callback: (error: Error | null) => void) {
    callback(null)
  }

  end(callback: () => void) {
    this.closeCallback = callback
  }

  finishClose() {
    this.emit('end')
    this.closeCallback?.()
  }
}

it.each(['promise', 'callback'])('waits for every connection to close through the %s end API', async mode => {
  const pool = createTestPool({ max: 2, Client: ClosingClient } as unknown as PoolConfig)
  const first = await pool.connect()
  const second = await pool.connect()
  const firstClient = first as unknown as ClosingClient
  const secondClient = second as unknown as ClosingClient
  // A discarded client also remains open after it leaves the pool's client count.
  first.release(true)
  second.release()
  const finished = vi.fn()
  const closing = mode === 'promise'
    ? pool.end().then(finished)
    : new Promise<void>(resolve => pool.end(() => {
      finished()
      resolve()
    }))
  try {
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    secondClient.finishClose()
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    firstClient.finishClose()
    await closing
    expect(finished).toHaveBeenCalledOnce()
  } finally {
    firstClient.finishClose()
    secondClient.finishClose()
    await closing
  }
})

it('accepts an idle administrative termination arriving after pool teardown', async () => {
  const pool = createTestPool({ max: 1 })
  const closing = pool.end()
  const error = Object.assign(new Error('Administrative termination'), { code: '57P01' })
  expect(() => pool.emit('error', error)).not.toThrow()
  await closing
  expect(() => pool.emit('error', error)).not.toThrow()
})

it('reports administrative termination while the pool is still usable', async () => {
  const pool = createTestPool({ max: 1 })
  const error = Object.assign(new Error('Administrative termination'), { code: '57P01' })
  try {
    expect(() => pool.emit('error', error)).toThrow(error)
  } finally {
    await pool.end()
  }
})

it('reports other idle errors after pool teardown', async () => {
  const pool = createTestPool({ max: 1 })
  await pool.end()
  for (const code of ['08006', '57P02', undefined]) {
    const error = Object.assign(new Error('Unexpected connection failure'), { code })
    expect(() => pool.emit('error', error)).toThrow(error)
  }
})
