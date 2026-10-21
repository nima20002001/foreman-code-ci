import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildComputerPriorityMigration } from '../src/infrastructure/buildComputerPriorityMigration.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

const mainA = '11111111-1111-4111-8111-111111111111'
const mainB = '22222222-2222-4222-8222-222222222222'

describe.skipIf(!postgresEnabled)('build computer priority migration', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { database = await agent3Database() })
  afterAll(async () => { await database?.close() })

  it('folds Primary/Backup into one priority order per Main and drops the role', async () => {
    const pool = database.pool
    const owner = (await pool.query<{ id: string }>('select id from management_principals limit 1')).rows[0]?.id
      ?? (await pool.query<{ id: string }>(`insert into management_principals (id,name,audience,token_hash,grants,expires_at)
        values ('migration-owner','Owner','operator','migration-owner-token','[]'::jsonb, now() + interval '1 day') returning id`)).rows[0]!.id
    // Recreate the pre-migration shape on the already-migrated schema.
    await pool.query(`alter table build_computer_preferences add column build_role text not null default 'primary'`)
    const rows = [
      ['a-primary-low', mainA, 10, 'primary'], ['a-backup-high', mainA, 100, 'backup'],
      ['a-primary-high', mainA, 60, 'primary'], ['b-primary', mainB, 30, 'primary'],
    ] as const
    for (const [key, mainId, priority, role] of rows) {
      await pool.query(`insert into build_computer_preferences (host_key,target,revision,build_enabled,build_priority,build_role,updated_by)
        values ($1,$2::jsonb,1,true,$3,$4,$5)`, [key, JSON.stringify({ hostRef: { kind: 'main', mainId } }), priority, role, owner])
    }
    await pool.query(buildComputerPriorityMigration.sql)
    const after = (await pool.query<{ host_key: string; build_priority: number; revision: string }>(
      'select host_key,build_priority,revision::text from build_computer_preferences order by host_key')).rows
    expect(Object.fromEntries(after.map(row => [row.host_key, row.build_priority]))).toEqual({
      // Main A keeps its old order: Primaries by priority, then the Backup.
      'a-primary-high': 100, 'a-primary-low': 99, 'a-backup-high': 98,
      // Main B had no Backup, so its priorities are untouched.
      'b-primary': 30,
    })
    expect(after.find(row => row.host_key === 'b-primary')?.revision).toBe('1')
    const columns = (await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='build_computer_preferences' and table_schema=current_schema()")).rows
    expect(columns.map(column => column.column_name)).not.toContain('build_role')
  })
})
