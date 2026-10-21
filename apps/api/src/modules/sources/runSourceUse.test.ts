import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { bootIdentity, processIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { removeAbandonedRunSourceUses, retainRunSource, withRunSourceUse } from './runSourceUse.js'

type Use = { use_id: string; snapshot_id: string; owner: unknown }
function fixture() {
  let held = false
  const uses = new Map<string, Use>()
  const query = async (text: string, values: unknown[] = []) => {
    if (text.startsWith('insert')) {
      const [useId, snapshotId, owner] = values as [string, string, string]
      uses.set(useId, { use_id: useId, snapshot_id: snapshotId, owner: JSON.parse(owner) })
      return { rows: [{ snapshot_id: snapshotId }], rowCount: 1 }
    }
    if (text.startsWith('delete')) {
      const ids = Array.isArray(values[0]) ? values[0] : [values[0]]
      for (const id of ids) uses.delete(String(id))
      return { rows: [], rowCount: ids.length }
    }
    return { rows: [...uses.values()], rowCount: uses.size }
  }
  const connect = async () => {
    if (held) throw new Error('Pool connection unavailable')
    held = true
    return Object.assign(new EventEmitter(), {
      query,
      release() { held = false },
    })
  }
  const pool = { connect, async query(text: string, values?: unknown[]) {
    const client = await connect()
    try { return await client.query(text, values) } finally { client.release() }
  } } as unknown as pg.Pool
  const readSource = async () => {
    const sql = await pool.connect()
    try { await retainRunSource(pool, sql, 'snapshot') } finally { sql.release() }
  }
  return { pool, held: () => held, uses, readSource }
}

it('keeps snapshot use persisted while releasing the connection before slow preparation', async () => {
  const f = fixture()
  const entered = deferred()
  const resume = deferred()
  const start = withRunSourceUse(f.pool, 'workspace', async () => {
    await f.readSource()
    entered.resolve()
    await resume.promise
    return 'accepted'
  })
  const finishedEarly = start.then(() => { throw new Error('Source use finished before its preparation barrier') })
  try {
    await Promise.race([entered.promise, finishedEarly])
    expect(f.held()).toBe(false)
    expect(f.uses.size).toBe(1)
    await removeAbandonedRunSourceUses(f.pool)
    expect(f.uses.size).toBe(1)
    const accountConnection = await f.pool.connect()
    accountConnection.release()
    expect(f.uses.size).toBe(1)
  } finally {
    resume.resolve()
    await start
  }
  expect(await start).toBe('accepted')
  expect(f.held()).toBe(false)
  expect(f.uses.size).toBe(0)
})

it('preserves a preparation error and releases its persisted snapshot use', async () => {
  const f = fixture()
  const failure = new Error('Source preparation failed')
  await expect(withRunSourceUse(f.pool, 'workspace', async () => {
    await f.readSource()
    throw failure
  })).rejects.toBe(failure)
  expect(f.held()).toBe(false)
  expect(f.uses.size).toBe(0)
})

it.each(['exited', 'reused-pid', 'previous-boot'] as const)(
  'recovers a snapshot reference after its owner is %s', async state => {
    const f = fixture()
    const parent = processIdentity(process.ppid)!
    const owner = { bootId: bootIdentity(), pid: parent.pid, startTicks: parent.startTicks }
    f.uses.set('abandoned', { use_id: 'abandoned', snapshot_id: 'snapshot', owner })
    await removeAbandonedRunSourceUses(f.pool)
    expect(f.uses.size).toBe(1)
    if (state === 'exited') {
      const gone = spawnSync(process.execPath, ['-e', ''])
      expect(gone.status).toBe(0)
      owner.pid = gone.pid
    } else if (state === 'reused-pid') owner.startTicks = `${owner.startTicks}-old`
    else owner.bootId = 'previous-boot'
    await removeAbandonedRunSourceUses(f.pool)
    expect(f.uses.size).toBe(0)
    expect(f.held()).toBe(false)
  },
)

it('reports interrupted cleanup and recovers the reference while its process is still alive', async () => {
  const f = fixture()
  const query = f.pool.query.bind(f.pool)
  const failure = new Error('Snapshot reference cleanup interrupted')
  f.pool.query = (async () => { throw failure }) as pg.Pool['query']
  await expect(withRunSourceUse(f.pool, 'workspace', async () => {
    await f.readSource()
  })).rejects.toBe(failure)
  expect(f.uses.size).toBe(1)
  f.pool.query = query
  await removeAbandonedRunSourceUses(f.pool)
  expect(f.uses.size).toBe(0)
  expect(f.held()).toBe(false)
})
