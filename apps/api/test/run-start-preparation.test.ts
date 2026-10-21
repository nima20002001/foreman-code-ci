import { describe, expect, it, vi } from 'vitest'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { START_PREPARATION_TIMEOUT_MS } from '../src/modules/runs/startPreparation.js'
import { SOURCE_LIMITS } from '../src/modules/sources/manifest.js'
import { RUN_START_LOCK_WAIT_MS } from '../src/modules/runs/startLocks.js'
import { startSqlFixture } from './eng04-start-fixtures.js'

describe('Start preparation deadline', () => {
  it.each(['http', 'mcp'] as const)('%s admits a Run after source preparation exceeds the lock-wait budget', async source => {
    const f = startSqlFixture()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const result = await admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, {
        ...f.publication, placementAdmission: { prepare: async (_input, _principal, _signal, options) => {
          options!.sourcePreparationStarted!()
          now += RUN_START_LOCK_WAIT_MS + 1_000
          return undefined
        } },
      })
      expect(result.replayed).toBe(false)
      expect(f.database().run).toEqual(result.value)
      expect(f.state.publications).toBe(1)
    } finally { clock.mockRestore() }
  })

  it('retains lock time already spent before source preparation in the shared contention budget', async () => {
    const f = startSqlFixture()
    let now = 0
    let locks = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    f.state.rows = (sql, _values, rows) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        locks += 1
        // The initial and post-preparation command locks together exhaust the budget.
        now += RUN_START_LOCK_WAIT_MS / 2
      }
      return rows
    }
    try {
      await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, {
        ...f.publication, placementAdmission: { prepare: async (_input, _principal, _signal, options) => {
          options!.sourcePreparationStarted!()
          now += 60_000
          return undefined
        } },
      })).rejects.toMatchObject({ code: 'RUN_START_BUSY' })
      expect(locks).toBe(2)
      expect(f.database().run).toBeUndefined()
      expect(f.state.publications).toBe(0)
    } finally { clock.mockRestore() }
  })

  it.each(['http', 'mcp'] as const)('%s gives source approval its bounded budget and rejects late admission', async source => {
    vi.useFakeTimers()
    const f = startSqlFixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    let signal: AbortSignal | undefined
    const work = admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, {
      ...f.publication, placementAdmission: { prepare: async (_input, _principal, cancellation, options) => {
        signal = cancellation
        options!.sourcePreparationStarted!()
        entered()
        await held
        return undefined
      } },
    })
    const rejected = expect(work).rejects.toMatchObject({ code: 'RUN_START_PREPARATION_TIMEOUT' })
    try {
      await preparing
      await vi.advanceTimersByTimeAsync(START_PREPARATION_TIMEOUT_MS + 1)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.preparationMs - START_PREPARATION_TIMEOUT_MS - 1)
      await rejected
      expect(signal?.aborted).toBe(true)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
    } finally { release(); vi.useRealTimers() }
  })

  it.each(['http', 'mcp'] as const)('%s cannot resume admission after a timed-out preflight resolves', async (source) => {
    vi.useFakeTimers()
    const f = startSqlFixture()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => { entered = resolve })
    let signal: AbortSignal | undefined
    const work = admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, {
      ...f.publication,
      placementAdmission: { prepare: async (_input, _principal, cancellation) => {
        signal = cancellation
        entered()
        await held
        return undefined
      } },
    })
    const rejected = expect(work).rejects.toMatchObject({ code: 'RUN_START_PREPARATION_TIMEOUT' })
    try {
      await preparing
      await vi.advanceTimersByTimeAsync(START_PREPARATION_TIMEOUT_MS)
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
    } finally { release(); vi.useRealTimers() }
  })
})
