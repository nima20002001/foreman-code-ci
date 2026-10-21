import { rejectableDeferred } from '../../../test/helpers/deferred.js'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { observationFixture } from './observationConcurrency.testSupport.js'

it('leaves half the shared pool available while a full fleet is being observed', async () => {
  const gate = rejectableDeferred<void>()
  const f = observationFixture({ cloud: 48, local: 8, poolSize: 8, beforeRead: () => gate.promise })
  try {
    await f.warm()
    await f.service.dispatch()
    await f.service.dispatch()
    expect(f.reads.length).toBeGreaterThan(0)
    expect(f.reads.length).toBeLessThanOrEqual(4)
    expect(new Set(f.reads).size).toBe(f.reads.length)
  } finally {
    gate.resolve()
    await f.service.close()
  }
})

it('observes every cloud and local ticket across bounded passes without starving later tickets', async () => {
  const f = observationFixture({ cloud: 6, local: 2, poolSize: 2 })
  try {
    await f.warm()
    await f.service.dispatch()
    await setImmediate()
    expect(f.reads).toHaveLength(1)
    for (let pass = 1; pass < f.records.length; pass++) {
      await f.service.dispatch()
      await setImmediate()
    }
    expect(new Set(f.reads)).toEqual(new Set(f.records.map(record => record.id)))
    for (const record of f.records) {
      expect((await f.service.get(f.caller, { ticketId: record.id })).run)
        .toMatchObject({ step: 'checking', observation: { status: 'available' } })
    }
  } finally {
    await f.service.close()
  }
})

it('keeps observing local tickets while slow cloud observations hold their share of the pool', async () => {
  const cloudGate = rejectableDeferred<void>()
  const cloudIds = new Set<string>()
  const f = observationFixture({ cloud: 4, local: 2, poolSize: 4,
    beforeRead: runId => cloudIds.has(runId) ? cloudGate.promise : Promise.resolve() })
  for (const record of f.records) if (record.computer?.hostRef.kind === 'cloud') cloudIds.add(record.id)
  try {
    await f.warm()
    for (let pass = 0; pass < 8; pass++) {
      await f.service.dispatch()
      await setImmediate()
    }
    const localIds = f.records.filter(record => record.computer?.hostRef.kind === 'device').map(record => record.id)
    expect(localIds.filter(id => f.reads.includes(id))).toEqual(localIds)
  } finally {
    cloudGate.resolve()
    await f.service.close()
  }
})

it('reaches cloud tickets at the end of the rotation while Worker tickets take the permit kept for them', async () => {
  // Three permits, two for cloud: a pass that fills its cloud share near the end of the rotation wraps around to a
  // Worker ticket at the front, and the next pass must still resume with the cloud tickets it had to leave waiting.
  const f = observationFixture({ cloud: 10, local: 2, poolSize: 6 })
  try {
    await f.warm()
    for (let pass = 0; pass < f.records.length; pass++) {
      await f.service.dispatch()
      await f.service.drain()
    }
    expect(new Set(f.reads)).toEqual(new Set(f.records.map(record => record.id)))
  } finally {
    await f.service.close()
  }
})
