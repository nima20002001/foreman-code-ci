import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'

const logging = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../diagnostics/logger.js', async importOriginal => ({
  ...await importOriginal<typeof import('../diagnostics/logger.js')>(),
  componentLogger: () => ({ info: logging.info, warn: logging.warn }),
}))
import { createWorkerRuntimeDrain } from './installedWorkerDomains.js'

afterEach(() => {
  vi.useRealTimers()
  logging.info.mockClear()
  logging.warn.mockClear()
})

it.each(['dispatches', 'jobs', 'qualifications', 'maintenance', 'quiescence'] as const)(
  'reports a waiting %s stage at warning level every thirty seconds and stops after completion', async stage => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const active: Promise<unknown>[] = []
    if (stage === 'dispatches') {
      active.push(pending.promise.then(() => { void active.splice(0) }))
    }
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
      active: () => [...active],
      drainJobs: async () => { if (stage === 'jobs') await pending.promise },
      drainQualifications: async () => { if (stage === 'qualifications') await pending.promise },
      drainMaintenance: async () => { if (stage === 'maintenance') await pending.promise },
      quiescent: async () => {
        if (stage === 'quiescence') await pending.promise
        return true
      },
    })
    const running = drain.run()
    try {
      await vi.advanceTimersByTimeAsync(29_999)
      expect(logging.warn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(logging.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage, elapsedMs: 30_000, waitingOn: [] }), expect.any(String))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logging.warn).toHaveBeenCalledTimes(2)
      pending.resolve()
      await running
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logging.warn).toHaveBeenCalledTimes(2)
      expect(logging.info).not.toHaveBeenCalled()
    } finally {
      pending.resolve()
      await running
    }
  })

it('stops drain diagnostics when a stage rejects', async () => {
  vi.useFakeTimers()
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
    drainJobs: async () => { throw new Error('Job drain failed') },
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
  })
  await expect(drain.run()).rejects.toThrow('Job drain failed')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(logging.warn).not.toHaveBeenCalled()
  expect(logging.info).not.toHaveBeenCalled()
})

it.each(['sources.reclaim-reservation', 'sources.reconcile-preparation', 'sources.release'])(
  'defers new %s retries during an update and resumes them afterwards', async operation => {
    const drain = createWorkerRuntimeDrain({
      signal: new AbortController().signal, active: () => [], drainJobs: async () => {},
      drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
    })
    await drain.run()
    expect(() => drain.assertAdmission('source-operations-v1', { operation }))
      .toThrow(expect.objectContaining({ code: 'WORKER_RUNTIME_DRAINING' }))
    drain.resume()
    expect(() => drain.assertAdmission('source-operations-v1', { operation })).not.toThrow()
  })

it('waits for a control operation admitted after the initial dispatch drain', async () => {
  vi.useFakeTimers()
  const pending = deferred<void>()
  const active: Promise<unknown>[] = []
  const drain = createWorkerRuntimeDrain({
    signal: new AbortController().signal, active: () => [...active], drainJobs: async () => {
      active.push(pending.promise)
      void pending.promise.then(() => active.splice(0))
    },
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => true,
  })
  let finished = false
  const running = drain.run().then(() => { finished = true })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(false)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(finished).toBe(true)
  } finally {
    pending.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await running
  }
})

it('keeps source cleanup available until native processes have closed', async () => {
  vi.useFakeTimers()
  let idle = false
  const checking = deferred<void>()
  const drain = createWorkerRuntimeDrain({
    signal: new AbortController().signal, active: () => [], drainJobs: async () => {},
    drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => {
      checking.resolve()
      return idle
    },
  })
  const running = drain.run()
  try {
    await checking.promise
    expect(() => drain.assertAdmission('source-operations-v1', { operation: 'sources.reconcile-preparation' }))
      .not.toThrow()
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(() => drain.assertAdmission('source-operations-v1', { operation: 'sources.reconcile-preparation' }))
      .toThrow(expect.objectContaining({ code: 'WORKER_RUNTIME_DRAINING' }))
  } finally {
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await running
  }
})

it('blocks new reviews and turns while preserving resident controls during an update drain', async () => {
  let finish!: () => void
  const closing = new Promise<void>(resolve => { finish = resolve })
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
    drainJobs: async () => { await closing }, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true })
  const updating = drain.run()
  try {
    expect(() => drain.assertAdmission('execution-v1', { method: 'prepare-review' })).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'start-turn', review: {} })).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'start-turn' })).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'prepare' })).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).toThrow()
    for (const method of ['renew-owner', 'status', 'physical-ack', 'control', 'conversation.compact-read']) {
      expect(() => drain.assertAdmission('execution-v1', { method })).not.toThrow()
    }
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.file-copy', copy: { phase: 'close' } }))
      .not.toThrow()
  } finally {
    finish()
    await updating
  }
})

it.each(['dispatches', 'jobs', 'qualifications', 'maintenance', 'quiescence'])(
  'abandons a stalled %s drain and prevents late continuation', async stage => {
    vi.useFakeTimers()
    const stalled = deferred()
    const active = stage === 'dispatches' ? [stalled.promise] : []
    void stalled.promise.then(() => { void active.splice(0) })
    const stages: string[] = []
    const step = async (name: string) => {
      stages.push(name)
      if (name === stage) await stalled.promise
    }
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
      active: () => [...active],
      drainJobs: () => step('jobs'), drainQualifications: () => step('qualifications'),
      drainMaintenance: () => step('maintenance'), quiescent: async () => { await step('quiescence'); return true } })
    let outcome: unknown
    const attempt = drain.run().then(() => { outcome = 'completed' }, error => { outcome = error })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    try {
      expect(outcome).toMatchObject({ code: 'WORKER_UPDATE_DRAIN_DEADLINE_EXCEEDED' })
      expect(drain.isDraining()).toBe(false)
      expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).not.toThrow()
      const visited = [...stages]
      stalled.resolve()
      await attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(stages).toEqual(visited)
      expect(active).toEqual([])
      expect(() => drain.assertAdmission('source-operations-v1', { operation: 'sources.release' })).not.toThrow()
    } finally {
      stalled.resolve()
      await attempt
    }
  },
)
