import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { waitForRunStartLock } from '../src/modules/runs/startLocks.js'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'

describe('Start lock waiting', () => {
  it('retries contention until the transaction owns the lock', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
    await waitForRunStartLock({ query } as GraphSqlClient, 'admission:runner:test-runner')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('reports a retryable conflict when the shared lock deadline expires', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] })
    await expect(waitForRunStartLock({ query } as GraphSqlClient, 'admission:workspace:test-workspace',
      { deadline: performance.now() - 1 })).rejects.toMatchObject({ code: 'RUN_START_BUSY', status: 409 })
  })

  it('honors cancellation before probing for a scheduled Start', async () => {
    const controller = new AbortController()
    const reason = new Error('Schedule dispatch canceled')
    controller.abort(reason)
    const query = vi.fn()
    await expect(waitForRunStartLock({ query } as GraphSqlClient, 'admission:runner:test-runner',
      { deadline: performance.now() + 30_000, signal: controller.signal })).rejects.toBe(reason)
    expect(query).not.toHaveBeenCalled()
  })

  it('preserves the schedule cancellation reason while waiting for a held lock', async () => {
    const controller = new AbortController()
    const reason = new Error('Schedule dispatch canceled')
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] })
    const waiting = waitForRunStartLock({ query } as GraphSqlClient, 'admission:runner:test-runner',
      { deadline: performance.now() + 30_000, signal: controller.signal })
    const rejected = expect(waiting).rejects.toBe(reason)
    await Promise.resolve()
    controller.abort(reason)
    await rejected
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('preserves unexpected database errors', async () => {
    const error = new Error('Database connection lost')
    const query = vi.fn().mockRejectedValue(error)
    await expect(waitForRunStartLock({ query } as Pick<pg.PoolClient, 'query'>,
      'admission:runner:test-runner')).rejects.toBe(error)
  })
})
