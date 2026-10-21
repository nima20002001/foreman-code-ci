import { afterEach, expect, it, vi } from 'vitest'
import { setupMaterializationReservationCleanup } from './helpers/materializationReservationCleanup.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'

let fixture: Awaited<ReturnType<typeof setupMaterializationReservationCleanup>> | undefined
afterEach(async () => {
  vi.useRealTimers()
  await fixture?.close()
  fixture = undefined
})

it('persists failed reclamation backoff across recovery instances and retries after its deadline', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  await f.orphan('owned')
  f.offline()
  vi.useFakeTimers({ toFake: ['Date'] })
  const now = Date.now()
  vi.setSystemTime(now)
  const report = vi.fn()
  expect(await f.cleanup.reconcile(report)).toBe(0)
  const recovered = new MaterializationReservationCleanup(f.pool, f.reclaim)
  expect(await recovered.reconcile(report)).toBe(0)
  expect(f.reclaim).toHaveBeenCalledTimes(1)
  f.onlineWorker()
  vi.setSystemTime(now + 30_000)
  expect(await recovered.reconcile(report)).toBe(1)
  expect(f.reclaim).toHaveBeenCalledTimes(2)
}, 60_000)

it('runs one bounded reclamation batch without blocking the recovery caller', async () => {
  fixture = await setupMaterializationReservationCleanup({ cpuCount: 8, availableMemoryBytes: 32 * 2 ** 30 })
  const f = fixture
  for (let index = 0; index < 12; index++) await f.orphan('owned')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const reclaim = vi.fn(async () => { started(); await gate; throw new Error('Worker offline') })
  const cleanup = new MaterializationReservationCleanup(f.pool, reclaim)
  const report = vi.fn()
  try {
    expect(cleanup.startReconciliation(report)).toBeUndefined()
    await entered
    cleanup.startReconciliation(report)
    expect(reclaim).toHaveBeenCalledTimes(1)
  } finally {
    release()
    if ('drain' in cleanup) await cleanup.drain()
  }
  expect(reclaim).toHaveBeenCalledTimes(10)
  expect(report).toHaveBeenCalledTimes(10)
}, 60_000)
