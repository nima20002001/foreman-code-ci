import { randomUUID } from 'node:crypto'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('checkpoint Run-owner generation', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  it.each(['checkpoint', 'writes'] as const)('rejects delayed predecessor %s after successor acquisition', async (mutation) => {
    const graph = await graphFixture(database, { form: 'single' })
    const saver = new ApprovalPostgresSaver(database.pool, undefined, { schema: database.schema })
    await saver.setup()
    const lost = deferred()
    let owner = await RunOwnership.acquire(database.pool, graph.run.id, () => lost.resolve())
    if (!owner) throw new Error('Expected the first Run owner')
    const oldConfig = { configurable: { thread_id: graph.run.id, checkpoint_ns: '', checkpoint_owner_generation: '1' } }
    const checkpoint = { ...emptyCheckpoint(), id: randomUUID(), channel_values: { marker: 'successor' },
      channel_versions: { marker: 1 } }
    const metadata = { source: 'loop' as const, step: 0, parents: {} }
    const initial = await saver.put(oldConfig, checkpoint, metadata, { marker: 1 })
    const entered = deferred()
    const release = deferred()
    const serde = saver.serde
    const delayed = new ApprovalPostgresSaver(database.pool, {
      loadsTyped: serde.loadsTyped.bind(serde),
      dumpsTyped: async (value) => {
        entered.resolve()
        await release.promise
        return serde.dumpsTyped(value)
      },
    }, { schema: database.schema })
    const config = { configurable: { ...initial.configurable, ...oldConfig.configurable } }
    const late = mutation === 'checkpoint'
      ? delayed.put(config, { ...checkpoint, ts: '2000-01-01T00:00:00.000Z',
        channel_values: { marker: 'predecessor' }, channel_versions: { marker: 2 } }, metadata, { marker: 2 })
      : delayed.putWrites(config, [['__interrupt__', [{ id: 'stale-interrupt' }]]], 'stale-task')
    const observed = late.then(() => ({ accepted: true }), error => ({ error }))
    try {
      await entered.promise
      const pid = (await owner.client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await database.pool.query('select pg_terminate_backend($1)', [pid])
      await lost.promise
      await owner.release()
      owner = await RunOwnership.acquire(database.pool, graph.run.id, () => undefined)
      if (!owner) throw new Error('Expected the successor Run owner')
      const nextConfig = { configurable: { ...config.configurable, checkpoint_owner_generation: '2' } }
      await saver.put(nextConfig, checkpoint, metadata, { marker: 1 })
      release.resolve()
      expect(await observed).toMatchObject({ error: { code: 'RUN_OWNERSHIP_LOST' } })
      const selected = await saver.getTuple(nextConfig)
      expect(selected?.checkpoint.channel_values).toMatchObject({ marker: 'successor' })
      expect(selected?.pendingWrites).toEqual([])
    } finally {
      release.resolve()
      await observed
      await owner?.release()
      await graph.app.close()
    }
  })
})
