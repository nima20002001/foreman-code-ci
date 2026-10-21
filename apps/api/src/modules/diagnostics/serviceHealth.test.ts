import { expect, it } from 'vitest'
import { ServiceHealthSchema } from '@foreman-code/contracts/computer-maintenance'
import { readServiceHealth, registerService, reportServiceFailure, trackService } from './serviceHealth.js'

const health = (name: string, now: number) => readServiceHealth(now).find(service => service.name === name)

it('reports a registered loop that never ran as stalled once it misses its cadence', () => {
  registerService('health-never-ran', { cadenceMs: 1000, deadlineMs: 5000 }, 0)
  expect(health('health-never-ran', 500)).toMatchObject({ status: 'ok', lastStartedAt: null, nextDueAt: new Date(1000).toISOString() })
  expect(health('health-never-ran', 62_000)).toMatchObject({ status: 'stalled', lastStartedAt: null })
})

it('keeps a stalled service with a long retained error valid for computer status readback', async () => {
  const schedule = { deadlineMs: 5000 }
  await expect(trackService('health-long-error', schedule, async () => {
    throw new Error('x'.repeat(500))
  }, () => 0)).rejects.toThrow()
  let finish!: () => void
  const pass = trackService('health-long-error', schedule,
    () => new Promise<void>(resolve => { finish = resolve }), () => 1000)
  try {
    const stalled = health('health-long-error', 7000)
    expect(stalled).toMatchObject({ status: 'stalled', lastError: expect.stringContaining('Last error:') })
    expect(ServiceHealthSchema.safeParse(stalled).success).toBe(true)
  } finally {
    finish()
    await pass
  }
})

it('reports a pass in flight past its deadline as stalled, then ok after it finishes', async () => {
  let now = 10_000
  let finish!: () => void
  const pass = trackService('health-overdue', { cadenceMs: 1000, deadlineMs: 5000 },
    () => new Promise<void>(resolve => { finish = resolve }), () => now)
  expect(health('health-overdue', 14_000)).toMatchObject({ status: 'ok', inFlightSince: new Date(10_000).toISOString() })
  expect(health('health-overdue', 16_000)).toMatchObject({ status: 'stalled',
    lastError: 'In flight for 6 s, over its 5 s deadline.' })
  now = 16_500
  finish()
  await pass
  expect(health('health-overdue', 17_000)).toMatchObject({ status: 'ok', inFlightSince: null,
    lastSuccessAt: new Date(16_500).toISOString(), nextDueAt: new Date(17_500).toISOString() })
})

it('reports failures until the next success and keeps event-driven work idle between passes', async () => {
  let now = 0
  const schedule = { deadlineMs: 5000 }
  await expect(trackService('health-events', schedule, async () => {
    throw Object.assign(new Error('Database unavailable'), { code: 'ECONNREFUSED' })
  }, () => now)).rejects.toThrow('Database unavailable')
  expect(health('health-events', 1)).toMatchObject({ status: 'failing', lastError: 'ECONNREFUSED: Database unavailable',
    nextDueAt: null })
  now = 10
  await trackService('health-events', schedule, async () => undefined, () => now)
  expect(health('health-events', 11)).toMatchObject({ status: 'idle', lastSuccessAt: new Date(10).toISOString() })
  reportServiceFailure('health-events', new Error('2 observations unavailable'), 12)
  expect(health('health-events', 13)).toMatchObject({ status: 'failing', lastError: '2 observations unavailable' })
})
