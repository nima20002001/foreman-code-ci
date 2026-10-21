import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'
import { deferred } from '../../../test/helpers/deferred.js'

it('retries dispatch within a few seconds while an earlier fleet read remains blocked', async () => {
  vi.useFakeTimers()
  const entered = deferred()
  const release = deferred()
  const computers = vi.fn<HostCiEndpoint['computers']>()
    .mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return []
    })
    .mockResolvedValue([])
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = { computers, request: vi.fn() }
  const ci = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits, endpoint)
  let finished = false
  const first = ci.dispatch().then(() => { finished = true })
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(3500)
    expect(finished).toBe(true)
    await ci.dispatch()
    expect(computers).toHaveBeenCalledTimes(2)
    const reads = vi.mocked(pool.query).mock.calls.length
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.query).toHaveBeenCalledTimes(reads)
    await first
  } finally {
    release.resolve()
    await first
    await ci.close()
    vi.useRealTimers()
  }
})

it('keeps retrying expired dispatch passes without accumulating an additional failure delay', async () => {
  vi.useFakeTimers()
  const release = deferred()
  const computers = vi.fn<HostCiEndpoint['computers']>(async () => {
    await release.promise
    return []
  })
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
  const ci = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority,
    {} as CiCommits, { computers, request: vi.fn() })
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pass = ci.dispatch()
      await vi.advanceTimersByTimeAsync(0)
      expect(computers).toHaveBeenCalledTimes(attempt)
      await vi.advanceTimersByTimeAsync(3500)
      await pass
    }
    const reads = vi.mocked(pool.query).mock.calls.length
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.query).toHaveBeenCalledTimes(reads)
  } finally {
    release.resolve()
    await ci.close()
    vi.useRealTimers()
  }
})
