import { afterEach, describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { publicationSignal } from './helpers/publicationSignal.js'
import { rejectableDeferred } from './helpers/deferred.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

describe.skipIf(!postgresEnabled)('native publication observation', () => {
  it('wakes only after committed native output is readable', async () => {
    const held = rejectableDeferred()
    const release = rejectableDeferred()
    const publications = publicationSignal()
    let blocked = false
    const f = await checkpointRuntimeFixture(1, 1, {
      approvalNodeIds: [],
      nativeCommitted: async () => { publications.notify() },
      nativeSourcePersisted: async (_sql, _evidence, source) => {
        if (blocked || source.original.type !== 'event' || source.original.event.type !== 'turn.started') return
        blocked = true
        held.resolve()
        await release.promise
      },
    })
    closes.push(f.close)
    const task = f.engine.start(f.f.run.id)
    try {
      await held.promise
      let observed = false
      const notified = publications.next().then(() => { observed = true })
      const before = await f.db.pool.query(`select 1 from harness_native_events n join harness_executions e
        on e.id=n.execution_id where e.run_id=$1 and n.record->>'type'='turn.started'`, [f.f.run.id])
      expect(before.rowCount).toBe(0)
      expect(observed).toBe(false)
      release.resolve()
      await notified
      const after = await f.db.pool.query(`select 1 from harness_native_events n join harness_executions e
        on e.id=n.execution_id where e.run_id=$1 and n.record->>'type'='turn.started'`, [f.f.run.id])
      expect(after.rowCount).toBeGreaterThan(0)
      await task
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2 })
    } finally {
      release.resolve()
      await task.catch(() => undefined)
    }
  }, 60_000)
})
