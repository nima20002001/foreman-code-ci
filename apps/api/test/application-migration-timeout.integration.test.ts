import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { activityHistoryIndexesMigration } from '../src/infrastructure/activityHistoryIndexesMigration.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl } from './helpers/testResources.js'

// Register a slow fixture migration while exercising the real runner and PostgreSQL transaction.
vi.mock('../src/infrastructure/activityHistoryIndexesMigration.js', () => ({
  activityHistoryIndexesMigration: {
    version: 2026101517,
    sql: `
      select pg_sleep(0.5);
      create table migration_timeout_probe as
        select current_setting('statement_timeout') as statement_timeout,
          current_setting('lock_timeout') as lock_timeout;
    `,
  },
}))

it('applies a migration longer than the pool deadline without changing the lock timeout or pooled session', async () => {
  const connectionString = ownedTestDatabaseUrl()
  const schema = `migration_timeout_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString, max: 1 })
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schema} -c statement_timeout=100 -c lock_timeout=250`,
  })
  try {
    await createFixtureSchema(admin, schema)
    await admin.query(`create table ${schema}.application_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    )`)
    const version = activityHistoryIndexesMigration.version
    await admin.query(`insert into ${schema}.application_migrations(version)
      select unnest($1::integer[])`, [migrations.filter(migration => migration.version !== version)
      .map(migration => migration.version)])

    const settings = `select current_setting('statement_timeout') as statement_timeout,
      current_setting('lock_timeout') as lock_timeout`
    expect((await pool.query(settings)).rows).toEqual([{ statement_timeout: '100ms', lock_timeout: '250ms' }])

    await applyApplicationMigrations(pool)

    expect((await pool.query('select * from migration_timeout_probe')).rows)
      .toEqual([{ statement_timeout: '0', lock_timeout: '250ms' }])
    expect((await pool.query('select version from application_migrations where version=$1', [version])).rows)
      .toEqual([{ version }])
    expect((await pool.query(settings)).rows).toEqual([{ statement_timeout: '100ms', lock_timeout: '250ms' }])
  } finally {
    await pool.end()
    try {
      await dropFixtureSchema(admin, schema)
    } finally {
      await admin.end()
    }
  }
})
