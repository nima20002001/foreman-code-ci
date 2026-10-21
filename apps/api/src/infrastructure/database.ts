import type pg from 'pg'

import { createPool, queryForReadiness, type DatabaseOptions } from './pool.js'

export type { DatabaseOptions } from './pool.js'

import { applyApplicationMigrations } from './migrations.js'

export const MIGRATION_QUERY_TIMEOUT_MS = 30 * 60_000

export interface Database {
  readonly pool: pg.Pool
  ping(signal?: AbortSignal): Promise<void>
  migrate(): Promise<void>
  close(): Promise<void>
}

export function createDatabase(options: DatabaseOptions): Database {
  // CI admission and dispatch keep two connections of their own; timeouts match the shared pool so a burst of
  // Agent ci_run calls waits briefly instead of failing.
  const dispatchPool = createPool({ ...options, maxConnections: 2, queryTimeoutMs: 1000 }, 'graphql-ci-dispatch')
  const pool = createPool(options, 'graphql-api', dispatchPool)
  return {
    pool,
    async ping(signal) {
      await queryForReadiness(pool, 'select 1', signal)
    },
    async migrate() {
      // One-time DDL can rewrite whole history tables (minutes in production); bound it, but not by a request deadline.
      const migrationPool = createPool({ ...options, maxConnections: 1,
        queryTimeoutMs: MIGRATION_QUERY_TIMEOUT_MS, lockTimeoutMs: 5_000 }, 'graphql-migrations')
      try {
        await applyApplicationMigrations(migrationPool)
      } finally {
        await migrationPool.end()
      }
    },
    async close() {
      await pool.end()
    },
  }
}
