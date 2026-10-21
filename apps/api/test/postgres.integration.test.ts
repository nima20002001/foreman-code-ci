import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'

const connectionString =
  process.env.TEST_DATABASE_URL!

function testSchema() {
  return `langgraph_probe_${randomUUID().replaceAll('-', '')}`
}

function adminPool() {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 })
}

describe('PostgreSQL infrastructure', () => {
  it('connects and keeps a LangGraph checkpoint after the saver is reopened', async () => {
    const database = createDatabase({
      connectionString,
      maxConnections: 2,
      connectionTimeoutMs: 5000,
    })
    const firstStore = createCheckpointStore(connectionString, 'langgraph_test')
    const threadId = `integration-${randomUUID()}`

    try {
      await database.ping()
      let savedConfig: RunnableConfig
      try {
        await firstStore.setup()
        const checkpoint = emptyCheckpoint()
        checkpoint.channel_values = { marker: 'durable-checkpoint' }
        checkpoint.channel_versions = { marker: 1 }
        savedConfig = await firstStore.saver.put(
          { configurable: { thread_id: threadId } },
          checkpoint,
          { source: 'input', step: -1, parents: {} },
          { marker: 1 },
        )
      } finally {
        await firstStore.close()
      }

      const reopenedStore = createCheckpointStore(connectionString, 'langgraph_test')
      try {
        await reopenedStore.ping()
        const restored = await reopenedStore.saver.getTuple(savedConfig)
        expect(restored?.checkpoint.channel_values).toEqual({ marker: 'durable-checkpoint' })
        await reopenedStore.saver.deleteThread(threadId)
      } finally {
        await reopenedStore.close()
      }
    } finally {
      await database.close()
    }
  })

  it('survives idle-connection termination in both the application and saver pools', async () => {
    const schema = testSchema()
    const admin = adminPool()
    const databaseError = vi.fn()
    const checkpointError = vi.fn()
    const options = { maxConnections: 1, connectionTimeoutMs: 500, queryTimeoutMs: 5000 }
    const database = createDatabase({ ...options, connectionString, onError: databaseError })
    const checkpoints = createCheckpointStore(connectionString, schema, {
      ...options, onError: checkpointError,
    })
    const app = buildApp({ readiness: { database, checkpoints }, readinessTimeoutMs: 1000 })
    try {
      await createFixtureSchema(admin, schema)
      await checkpoints.setup()
      await checkpoints.saver.getTuple({ configurable: { thread_id: '__pool_test__' } })
      expect((await app.inject('/health/ready')).statusCode).toBe(200)
      const databasePid = await database.pool.query<{ pid: number }>('select pg_backend_pid() as pid')
      const checkpointPids = await admin.query<{ pid: number }>(`
        select pid from pg_stat_activity
        where datname = current_database() and application_name = 'graphql-checkpoints'
          and state = 'idle' and query like $1
      `, [`%${schema}%`])
      expect(checkpointPids.rows).toHaveLength(1)
      const pids = [databasePid.rows[0]!.pid, ...checkpointPids.rows.map((row) => row.pid)]
      await admin.query('select pg_terminate_backend(pid) from unnest($1::int[]) as clients(pid)', [pids])
      await vi.waitFor(() => {
        expect(databaseError).toHaveBeenCalledOnce()
        expect(checkpointError).toHaveBeenCalledOnce()
      })
      expect((await app.inject('/health/live')).statusCode).toBe(200)
      expect((await app.inject('/health/ready')).statusCode).toBe(200)
    } finally {
      await app.close()
      await Promise.all([checkpoints.close(), database.close()])
      await dropFixtureSchema(admin, schema)
      await admin.end()
    }
  })

  it('cancels a real locked checkpoint query at the readiness deadline and recovers', async () => {
    const schema = testSchema()
    const admin = adminPool()
    const options = { maxConnections: 1, connectionTimeoutMs: 500, queryTimeoutMs: 5000 }
    const database = createDatabase({ ...options, connectionString })
    const checkpoints = createCheckpointStore(connectionString, schema, options)
    const app = buildApp({ readiness: { database, checkpoints }, readinessTimeoutMs: 100 })
    const blocker = await admin.connect()
    let locked = false
    try {
      await createFixtureSchema(admin, schema)
      await checkpoints.setup()
      await Promise.all([database.ping(), checkpoints.ping()])
      expect((await app.inject('/health/ready')).statusCode).toBe(200)
      await blocker.query('begin')
      locked = true
      await blocker.query(`lock table "${schema}".checkpoints in access exclusive mode`)
      for (let round = 0; round < 3; round += 1) {
        const started = Date.now()
        const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject('/health/ready')))
        expect(Date.now() - started).toBeLessThan(1500)
        expect(responses.every((response) => response.statusCode === 503)).toBe(true)
        expect(responses[0]?.json().checks).toEqual({ database: 'ok', checkpoints: 'unavailable' })
        // The 5s statement timeout is deliberately much longer than the HTTP
        // deadline: this proves abort destroys the actual blocked connection.
        await vi.waitFor(async () => {
          const active = await admin.query<{ count: number }>(`
            select count(*)::int as count from pg_stat_activity
            where application_name = 'graphql-checkpoints' and state = 'active' and query like $1
          `, [`%${schema}%`])
          expect(active.rows[0]?.count).toBe(0)
        }, { timeout: 1500 })
      }
      await blocker.query('commit')
      locked = false
      await vi.waitFor(async () => {
        expect((await app.inject('/health/ready')).statusCode).toBe(200)
      }, { timeout: 2000 })
    } finally {
      if (locked) await blocker.query('rollback')
      blocker.release()
      await app.close()
      await Promise.all([checkpoints.close(), database.close()])
      await dropFixtureSchema(admin, schema)
      await admin.end()
    }
  }, 15000)

  it('bounds database statements and leaves no sleeping query behind', async () => {
    const admin = adminPool()
    const database = createDatabase({
      connectionString, maxConnections: 1, connectionTimeoutMs: 500, queryTimeoutMs: 100,
    })
    try {
      const result = await database.pool.query<{ pid: number }>('select pg_backend_pid() as pid')
      const pid = result.rows[0]!.pid
      const started = Date.now()
      await expect(database.pool.query('select pg_sleep(10)')).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1500)
      await vi.waitFor(async () => {
        const active = await admin.query<{ count: number }>(`
          select count(*)::int as count from pg_stat_activity where pid = $1 and state = 'active'
        `, [pid])
        expect(active.rows[0]?.count).toBe(0)
      }, { timeout: 1500 })
      await database.ping()
    } finally {
      await database.close()
      await admin.end()
    }
  })

  it('does not accumulate queued acquisitions while the application pool is exhausted', async () => {
    const database = createDatabase({
      connectionString, maxConnections: 1, connectionTimeoutMs: 1000, queryTimeoutMs: 1000,
    })
    const app = buildApp({
      readiness: { database, checkpoints: { ping: async () => undefined } },
      readinessTimeoutMs: 30,
    })
    const blocker = await database.pool.connect()
    const backend = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
    let released = false
    try {
      expect((await app.inject('/health/ready')).statusCode).toBe(503)
      expect(database.pool.waitingCount).toBe(1)
      const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject('/health/ready')))
      expect(responses.every((response) => response.statusCode === 503)).toBe(true)
      expect(database.pool.waitingCount).toBe(1)
      blocker.release()
      released = true
      await vi.waitFor(() => {
        expect(database.pool.waitingCount).toBe(0)
        expect(database.pool.totalCount).toBe(1)
        expect(database.pool.idleCount).toBe(1)
      })
      await vi.waitFor(async () => {
        expect((await app.inject('/health/ready')).statusCode).toBe(200)
      }, { timeout: 1500 })
      const recovered = await database.pool.query<{ pid: number }>('select pg_backend_pid() as pid')
      expect(recovered.rows[0]?.pid).toBe(backend.rows[0]?.pid)
    } finally {
      if (!released) blocker.release()
      await app.close()
      await database.close()
    }
  })
})
