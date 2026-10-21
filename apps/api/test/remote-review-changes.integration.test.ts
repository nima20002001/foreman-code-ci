import pg from 'pg'
import { expect, it } from 'vitest'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { readUntil } from './helpers/observableCondition.js'
import { remoteReviewChanges } from './helpers/remoteReviewChanges.js'

it('wakes a native routing read on committed rows and observes a change committed during the read', async () => {
  const database = await migratedDatabase()
  const pool = new pg.Pool({ connectionString: database.databaseUrl,
    options: '-c search_path=remote_review_events' })
  let changes: Awaited<ReturnType<typeof remoteReviewChanges>> | undefined
  try {
    await database.pool.query('create schema remote_review_events')
    await pool.query(`create table durable_interactions (id text primary key);
      create table harness_executions (id text primary key);
      create table review_jobs (id text primary key)`)
    changes = await remoteReviewChanges(pool)
    const notifications = changes
    let readSnapshot!: () => void
    const snapshotRead = new Promise<void>(resolve => { readSnapshot = resolve })
    let finishRead!: () => void
    const reading = new Promise<void>(resolve => { finishRead = resolve })
    let first = true
    const result = readUntil(async () => {
      notifications.assertHealthy()
      const rows = (await pool.query<{ id: string }>('select id from durable_interactions')).rows
      if (first) {
        first = false
        readSnapshot()
        await reading
      }
      return rows
    }, rows => rows.length === 1, {
      timeoutMs: 5_000, description: 'committed routed interaction', subscribe: notifications.subscribe,
    })
    await snapshotRead
    let stopObservingCommit!: () => void
    const committedNotification = new Promise<void>(resolve => {
      stopObservingCommit = notifications.subscribe(resolve)
    })
    const writer = await pool.connect()
    try {
      await writer.query('begin')
      await writer.query("insert into durable_interactions values ('interaction-original')")
      expect((await pool.query('select id from durable_interactions')).rows).toEqual([])
      await writer.query('commit')
      await committedNotification
    } finally {
      stopObservingCommit()
      writer.release()
    }
    finishRead()
    await expect(result).resolves.toEqual([{ id: 'interaction-original' }])
    const executionChanged = readUntil(async () => {
      notifications.assertHealthy()
      return (await pool.query<{ id: string }>('select id from harness_executions')).rows
    }, rows => rows.length === 1, {
      timeoutMs: 5_000, description: 'native execution change', subscribe: notifications.subscribe,
    })
    await pool.query("insert into harness_executions values ('execution-original')")
    await expect(executionChanged).resolves.toEqual([{ id: 'execution-original' }])
    const reviewChanged = readUntil(async () => {
      notifications.assertHealthy()
      return (await pool.query<{ id: string }>('select id from review_jobs')).rows
    }, rows => rows.length === 1, {
      timeoutMs: 5_000, description: 'native review change', subscribe: notifications.subscribe,
    })
    await pool.query("insert into review_jobs values ('review-original')")
    await expect(reviewChanged).resolves.toEqual([{ id: 'review-original' }])
    await expect(readUntil(async () => {
      notifications.assertHealthy()
      return (await pool.query<{ id: string }>('select id from durable_interactions')).rows
    }, rows => rows.length === 1, {
      timeoutMs: 5_000, description: 'previously committed interaction', subscribe: notifications.subscribe,
    })).resolves.toEqual([{ id: 'interaction-original' }])
    const closingRead = readUntil(async () => {
      notifications.assertHealthy()
      return false
    }, Boolean, {
      timeoutMs: 5_000, description: 'unfinished native execution', subscribe: notifications.subscribe,
    })
    const rejected = expect(closingRead).rejects.toThrow('Remote review change listener closed.')
    await changes.close()
    changes = undefined
    await rejected
  } finally {
    try { await changes?.close() }
    finally {
      await pool.end()
      await database.close()
    }
  }
})
