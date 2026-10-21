import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { deferred } from './helpers/deferred.js'
import { isTransientRefreshFailure } from '../src/modules/leases/ownerLeases.js'

afterEach(() => vi.useRealTimers())

function fixture() {
  const epoch = deferred<string>()
  const entered = deferred()
  let ownerSignal: AbortSignal | undefined
  const owner = {
    active: true,
    readRuntimeEpoch: vi.fn((options?: { signal?: AbortSignal }) => {
      ownerSignal = options?.signal
      entered.resolve()
      return epoch.promise
    }),
  }
  const query = vi.fn(async () => ({ rows: [] }))
  const routes = new AppMcpRoutes({ query } as unknown as pg.Pool, 'http://127.0.0.1:3101/mcp',
    undefined, () => owner)
  return { routes, owner, epoch, entered, query, ownerSignal: () => ownerSignal }
}

it('coalesces eight concurrent refreshes behind one ownership read and credential snapshot', async () => {
  const f = fixture()
  const callers = Array.from({ length: 8 }, () => f.routes.refresh())
  try {
    await f.entered.promise
    f.epoch.resolve('123456')
    await Promise.all(callers)
    expect(f.owner.readRuntimeEpoch).toHaveBeenCalledOnce()
    expect(f.query).toHaveBeenCalledOnce()
  } finally {
    f.epoch.resolve('123456')
    await Promise.allSettled(callers)
    await f.routes.close()
  }
})

it.each(['ownership read', 'credential snapshot'] as const)(
  'settles all concurrent refresh callers within one deadline during a stalled %s', async stage => {
    vi.useFakeTimers()
    const f = fixture()
    const snapshot = deferred<{ rows: [] }>()
    const snapshotEntered = deferred()
    if (stage === 'credential snapshot') {
      f.query.mockImplementation(async () => {
        snapshotEntered.resolve()
        return snapshot.promise
      })
      f.epoch.resolve('123456')
    }
    const outcomes: unknown[] = []
    const callers = Array.from({ length: 8 }, () => f.routes.refresh().then(
      () => outcomes.push('success'), error => outcomes.push(error),
    ))
    try {
      await f.entered.promise
      if (stage === 'credential snapshot') await snapshotEntered.promise
      await vi.advanceTimersByTimeAsync(30_001)
      expect(outcomes).toHaveLength(8)
      for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(Error)
        expect(isTransientRefreshFailure(outcome)).toBe(true)
      }
      expect(f.ownerSignal()?.aborted).toBe(true)
    } finally {
      f.epoch.resolve('123456')
      snapshot.resolve({ rows: [] })
      await Promise.all(callers)
      await f.routes.close()
    }
  },
)

it('cancels a waiting caller while another caller can finish the shared refresh', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const controller = new AbortController()
  const reason = new Error('Caller canceled')
  let canceled: unknown
  const first = f.routes.refresh({ signal: controller.signal }).catch(error => { canceled = error })
  const second = f.routes.refresh()
  try {
    await f.entered.promise
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(canceled).toBe(reason)
    expect(f.ownerSignal()?.aborted).toBe(false)
    f.epoch.resolve('123456')
    await second
    expect(f.query).toHaveBeenCalledOnce()
  } finally {
    f.epoch.resolve('123456')
    await Promise.allSettled([first, second])
    await f.routes.close()
  }
})

it('propagates cancellation to the ownership read when the last waiting caller leaves', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const controller = new AbortController()
  const reason = new Error('Caller canceled')
  let canceled: unknown
  const reading = f.routes.refresh({ signal: controller.signal }).catch(error => { canceled = error })
  try {
    await f.entered.promise
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(canceled).toBe(reason)
    expect(f.ownerSignal()?.aborted).toBe(true)
    expect(f.query).not.toHaveBeenCalled()
  } finally {
    f.epoch.resolve('123456')
    await reading
    await f.routes.close()
  }
})
