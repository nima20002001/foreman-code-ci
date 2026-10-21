import { sleep as delay } from './sleep.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduleQueue } from './dense-scheduler.mjs'

const idle = { cpuUtilization: 0.1, cpuPressure: 0, memoryUtilization: 0.1,
  memoryPressure: 0, totalMemoryBytes: 1000, cpuCount: 2 }
const defaults = { maxConcurrency: 2, samplePressure: () => idle, pollIntervalMs: 2, stallTimeoutMs: 40 }

test('starts longest profiles first and respects the concurrency limit', async () => {
  const started = []
  let active = 0
  let peak = 0
  const outcome = await scheduleQueue([{ id: 'short' }, { id: 'long' }, { id: 'medium' }], {
    ...defaults,
    profiles: { short: { durationMs: 1 }, long: { durationMs: 30 }, medium: { durationMs: 15 } },
    execute: async (item, context) => {
      started.push([item.id, context.workerIndex])
      peak = Math.max(peak, ++active)
      await delay(12)
      active--
      return { code: 0, metrics: { durationMs: 12, peakRssBytes: 20, cpuSeconds: 0.001 } }
    },
  })
  assert.deepEqual(started.map(([id]) => id), ['long', 'medium', 'short'])
  assert.equal(peak, 2)
  assert.ok(started.every(([, index]) => index >= 1 && index <= 2))
  assert.deepEqual(outcome.results.map(result => result.status), ['PASSED', 'PASSED', 'PASSED'])
  assert.equal(outcome.profiles.long.peakRssBytes, 20)
})

test('samples feedback between starts and defers admission under CPU or memory pressure', async () => {
  const events = []
  let sampleCount = 0
  const outcome = await scheduleQueue([{ id: 'one' }, { id: 'two' }], {
    ...defaults,
    samplePressure: () => {
      events.push('sample')
      sampleCount++
      if (sampleCount === 1) return { ...idle, cpuUtilization: 0.95 }
      if (sampleCount === 2) return { ...idle, memoryUtilization: 0.85 }
      return idle
    },
    execute: async item => {
      events.push(item.id)
      await delay(10)
      return { code: 0 }
    },
  })
  assert.equal(events.indexOf('one'), 3)
  assert.ok(events.slice(events.indexOf('one') + 1, events.indexOf('two')).includes('sample'))
  assert.ok(outcome.results.every(result => result.status === 'PASSED'))
})

test('profiled CPU seconds and RSS defer a job that exceeds projected pressure', async () => {
  for (const metrics of [{ cpuSeconds: 1.4, peakRssBytes: 0 }, { cpuSeconds: 0, peakRssBytes: 600 }]) {
    let samples = 0
    let samplesAtStart
    await scheduleQueue([{ id: 'heavy' }], {
      ...defaults,
      profiles: { heavy: { durationMs: 1000, ...metrics } },
      samplePressure: () => ++samples < 3
        ? { ...idle, cpuUtilization: 0.3, memoryUtilization: 0.3 }
        : idle,
      execute: async () => {
        samplesAtStart = samples
        return { code: 0 }
      },
    })
    assert.ok(samplesAtStart >= 3)
  }
})

test('exclusive jobs run alone, one at a time, after every ordinary job has filled the slots', async () => {
  const order = []
  const active = new Set()
  let ordinaryPeak = 0
  const outcome = await scheduleQueue([
    { id: 'first' }, { id: 'second' }, { id: 'last' },
    { id: 'exclusive-one', exclusive: true }, { id: 'exclusive-two', exclusive: true },
  ], {
    ...defaults,
    execute: async item => {
      if (item.exclusive) assert.equal(active.size, 0)
      else assert.ok([...active].every(id => !id.startsWith('exclusive')))
      active.add(item.id)
      if (!item.exclusive) ordinaryPeak = Math.max(ordinaryPeak, active.size)
      order.push(item.id)
      await delay(12)
      active.delete(item.id)
      return { code: 0 }
    },
  })
  assert.deepEqual(order, ['first', 'second', 'last', 'exclusive-one', 'exclusive-two'])
  assert.equal(ordinaryPeak, 2)
  assert.equal(outcome.unexecuted.length, 0)
  assert.ok(outcome.results.every(result => result.status === 'PASSED'))
})

test('ordinary work never waits behind an exclusive job and never overlaps one', async () => {
  const active = new Set()
  const overlaps = []
  const timeline = []
  const outcome = await scheduleQueue([
    { id: 'wave-one' }, { id: 'wave-two' }, { id: 'trailing' }, { id: 'exclusive', exclusive: true },
  ], {
    ...defaults,
    onEvent: event => {
      if (event.type === 'start') {
        if (event.item.exclusive && active.size) overlaps.push([...active, event.item.id])
        if (!event.item.exclusive && active.has('exclusive')) overlaps.push([...active, event.item.id])
        active.add(event.item.id)
        timeline.push(`start:${event.item.id}`)
      }
      if (event.type === 'finish') {
        active.delete(event.item.id)
        timeline.push(`finish:${event.item.id}`)
      }
    },
    execute: async () => {
      await delay(12)
      return { code: 0 }
    },
  })
  assert.deepEqual(overlaps, [])
  assert.ok(timeline.indexOf('finish:trailing') < timeline.indexOf('start:exclusive'))
  assert.ok(outcome.results.every(result => result.status === 'PASSED'))
})

test('executes prerequisites before exclusive jobs and blocks dependents of failed work', async () => {
  const started = []
  const outcome = await scheduleQueue([
    { id: 'consumer', dependsOn: ['exclusive'] },
    { id: 'exclusive', exclusive: true, dependsOn: ['build'] },
    { id: 'build' }, { id: 'failure' }, { id: 'blocked', dependsOn: ['failure'] },
  ], {
    ...defaults,
    retest: false,
    execute: async item => {
      started.push(item.id)
      await delay(4)
      return { code: item.id === 'failure' ? 1 : 0 }
    },
  })
  assert.ok(started.indexOf('build') < started.indexOf('exclusive'))
  assert.ok(started.indexOf('exclusive') < started.indexOf('consumer'))
  assert.ok(!started.includes('blocked'))
  assert.match(outcome.results.find(result => result.id === 'blocked').reason, /failure/)
})

test('retests failures once in isolation and preserves flaky and incomplete outcomes', async () => {
  const events = []
  let active = 0
  const outcome = await scheduleQueue([{ id: 'flaky' }, { id: 'broken' }, { id: 'ok' }], {
    ...defaults,
    execute: async (item, context) => {
      if (context.isRetest) assert.equal(active, 0)
      active++
      events.push([item.id, context.attempt])
      await delay(8)
      active--
      if (item.id === 'broken') return { code: 0, complete: false, coverage: ['kept'] }
      return { code: item.id === 'flaky' && context.attempt === 1 ? 1 : 0 }
    },
  })
  assert.deepEqual(outcome.results.map(result => result.status), ['FLAKY', 'FAILED', 'PASSED'])
  assert.deepEqual(outcome.results.map(result => result.attempts.length), [2, 2, 1])
  assert.deepEqual(outcome.results[1].attempts[1].coverage, ['kept'])
  assert.deepEqual(events.slice(-2), [['flaky', 2], ['broken', 2]])
})

test('retests many failures at a quarter of the workers instead of one at a time', async () => {
  let active = 0
  let peak = 0
  const outcome = await scheduleQueue(Array.from({ length: 8 }, (_, index) => ({ id: `failing-${index}` })), {
    ...defaults,
    maxConcurrency: 8,
    execute: async (_item, context) => {
      if (context.isRetest) peak = Math.max(peak, ++active)
      await delay(8)
      if (context.isRetest) active--
      return { code: 1 }
    },
  })
  assert.equal(peak, 2)
  assert.ok(outcome.results.every(result => result.status === 'FAILED' && result.attempts.length === 2))
})

test('an executor exception is a failed attempt and can retire a worker', async () => {
  const outcome = await scheduleQueue([{ id: 'crash' }, { id: 'retire' }, { id: 'not-run' }], {
    ...defaults,
    maxConcurrency: 1,
    retest: false,
    execute: async item => {
      if (item.id === 'crash') throw new Error('runner died')
      return { code: 1, slotUnavailable: true }
    },
  })
  assert.match(outcome.results[0].attempts[0].reason, /runner died/)
  assert.equal(outcome.results[1].status, 'FAILED')
  assert.equal(outcome.results[2].status, 'NOT_RUN')
  assert.match(outcome.results[2].reason, /usable worker/)
  assert.deepEqual(outcome.unexecuted.map(item => item.id), ['not-run'])
})

test('bounds an idle pressure stall but does not time out pending work behind active jobs', async () => {
  const stalled = await scheduleQueue([{ id: 'blocked' }], {
    ...defaults,
    stallTimeoutMs: 12,
    samplePressure: () => ({ ...idle, cpuPressure: 0.95 }),
    execute: async () => assert.fail('pressure must block this item'),
  })
  assert.equal(stalled.results[0].status, 'NOT_RUN')
  assert.match(stalled.results[0].reason, /pressure/)
  let active = false
  const progressing = await scheduleQueue([{ id: 'slow' }, { id: 'next' }], {
    ...defaults,
    stallTimeoutMs: 8,
    samplePressure: () => ({ ...idle, cpuUtilization: active ? 0.95 : 0.1 }),
    execute: async () => {
      active = true
      await delay(30)
      active = false
      return { code: 0 }
    },
  })
  assert.ok(progressing.results.every(result => result.status === 'PASSED'))
})

test('item-specific worker availability permits other work and reports stopped queues', async () => {
  const outcome = await scheduleQueue([{ id: 'database' }, { id: 'unit' }], {
    ...defaults,
    canUseWorker: (_index, item) => item.id === 'unit',
    execute: async () => ({ code: 0 }),
  })
  assert.deepEqual(outcome.results.map(result => result.status), ['NOT_RUN', 'PASSED'])
  const stopped = await scheduleQueue([{ id: 'never' }], {
    ...defaults,
    shouldStop: () => true,
    execute: async () => assert.fail('stopped'),
  })
  assert.match(stopped.results[0].reason, /Stopped/)
})

test('a dedicated computer fills every slot while CPU is busy and still stops at the memory guard', async () => {
  let active = 0, peak = 0
  const busy = { ...idle, cpuUtilization: 0.99, cpuPressure: 0.95 }
  const run = sample => scheduleQueue(Array.from({ length: 6 }, (_, index) => ({ id: `file-${index}` })), {
    ...defaults, maxConcurrency: 4, dedicated: true, samplePressure: () => sample,
    execute: async () => { peak = Math.max(peak, ++active); await delay(10); active--; return { code: 0 } },
  })
  const outcome = await run(busy)
  assert.equal(peak, 4)
  assert.ok(outcome.results.every(result => result.status === 'PASSED'))
  peak = 0
  const full = await run({ ...busy, memoryUtilization: 0.95 })
  assert.ok(peak <= 1)
  assert.ok(full.results.some(result => result.status !== 'PASSED' || peak <= 1))
})

test('a dedicated computer starts free slots together while a shared host spaces its starts', async () => {
  const startTimes = async dedicated => {
    const started = []
    await scheduleQueue(Array.from({ length: 3 }, (_, index) => ({ id: `file-${index}` })), {
      ...defaults, maxConcurrency: 3, pollIntervalMs: 200, dedicated,
      execute: async () => { started.push(performance.now()); await delay(10); return { code: 0 } },
    })
    return started.at(-1) - started[0]
  }
  assert.ok(await startTimes(true) < 100)
  assert.ok(await startTimes(false) >= 2 * 200 - 20)
})
