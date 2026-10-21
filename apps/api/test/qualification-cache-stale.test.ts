import { describe, expect, it } from 'vitest'
import { QualificationCache } from '../src/modules/harnesses/qualificationCache.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe('qualification cache stale-while-revalidate', () => {
  it('serves an expired success while one refresh runs, then the refreshed value', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    expect(await cache.get('codex', async () => 'first')).toBe('first')
    now = 2_000
    const refresh = rejectableDeferred<string>()
    let loads = 0
    const load = () => { loads += 1; return refresh.promise }
    expect(await cache.get('codex', load)).toBe('first')
    expect(await cache.get('codex', load)).toBe('first')
    expect(loads).toBe(1)
    refresh.resolve('second')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache.get('codex', load)).toBe('second')
  })

  it('keeps serving the last success after a failed refresh and retries it soon', async () => {
    let now = 0
    const cache = new QualificationCache<string>(300_000, 8, () => now, true)
    await cache.get('codex', async () => 'first')
    now = 400_000
    const refresh = rejectableDeferred<string>()
    expect(await cache.get('codex', () => refresh.promise)).toBe('first')
    refresh.reject(new Error('timed out'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache.get('codex', async () => 'unused')).toBe('first')
    expect(cache.observation('codex')).toMatchObject({ failureCount: 1, lastError: expect.any(String) })
    now += 16_000
    expect(await cache.get('codex', async () => 'second')).toBe('first')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache.get('codex', async () => 'unused')).toBe('second')
  })

  it('reports a failed forced refresh instead of the old success', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    await cache.get('codex', async () => 'first')
    now = 2_000
    await expect(cache.get('codex', async () => { throw new Error('signed out') }, { refresh: true })).rejects.toThrow('signed out')
  })

  it('never serves a stale value after invalidation or without the option', async () => {
    let now = 0
    const swr = new QualificationCache<string>(1_000, 8, () => now, true)
    await swr.get('codex', async () => 'first')
    now = 2_000
    swr.clear()
    expect(await swr.get('codex', async () => 'fresh')).toBe('fresh')
    const plain = new QualificationCache<string>(1_000, 8, () => now)
    await plain.get('codex', async () => 'first')
    now = 4_000
    expect(await plain.get('codex', async () => 'fresh')).toBe('fresh')
  })

  it('drops the stale value when invalidated during a refresh', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    await cache.get('codex', async () => 'first')
    now = 2_000
    const refresh = rejectableDeferred<string>()
    expect(await cache.get('codex', () => refresh.promise)).toBe('first')
    cache.clear()
    const waiting = cache.get('codex', async () => 'after-clear')
    refresh.resolve('second')
    expect(await waiting).toBe('after-clear')
  })
})
