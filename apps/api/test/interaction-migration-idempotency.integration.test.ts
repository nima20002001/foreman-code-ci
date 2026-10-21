import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('preserves applied migration records and saved workflow facts when migrations run again', async () => {
  const database = await migratedDatabase()
  try {
    const fixture = await seedAgent3(database.pool, database.directory, undefined, { run: false })
    const workflows = new PostgresWorkflowRepository(database.pool)
    const version = await workflows.getVersion(fixture.version.id)
    expect(version).toBeDefined()
    const applied = await database.pool.query('select version,applied_at::text from application_migrations order by version')
    expect(applied.rows.length).toBeGreaterThan(0)
    const versions = new Set(applied.rows.map((row: { version: number }) => row.version))
    expect(versions.size).toBe(applied.rows.length)
    await database.pool.query(`create function prevent_migration_record_changes() returns trigger language plpgsql as $$
      begin raise exception 'Applied migration records must be preserved'; end;
    $$`)
    await database.pool.query(`create trigger preserve_applied_migrations before insert or update or delete
      on application_migrations for each row execute function prevent_migration_record_changes()`)
    for (let attempt = 0; attempt < 2; attempt++) {
      await applyApplicationMigrations(database.pool)
      expect((await database.pool.query('select version,applied_at::text from application_migrations order by version')).rows)
        .toEqual(applied.rows)
      expect(await workflows.getVersion(fixture.version.id)).toEqual(version)
    }
  } finally {
    await database.close()
  }
}, 30_000)
