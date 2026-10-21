import { DatabaseSync } from 'node:sqlite'
import type pg from 'pg'
import { expect, it } from 'vitest'
import type { PostgresAccessService } from '../access/postgres.js'
import type { NativeRollout } from '../harnesses/nativeRollout.js'
import { PostgresOperatorChatAuthority } from './operatorChatAuthority.js'

it('startup revokes live Operator credentials without rewriting revoked or unrelated principals', async () => {
  const database = new DatabaseSync(':memory:')
  database.function('now', () => '2026-10-01T00:00:00Z')
  try {
    database.exec(`
      create table management_principals(id text primary key, revoked_at text);
      create table operator_chat_credentials(principal_id text);
      create table writes(principal_id text);
      create trigger track_updates after update on management_principals begin
        insert into writes values(new.id);
      end;
      insert into management_principals values ('live', null), ('revoked', '2026-09-01T00:00:00Z'), ('unrelated', null);
      insert into operator_chat_credentials values ('live'), ('revoked');
    `)
    const pool = { query: async (statement: string) => {
      database.exec(statement)
      return { rows: [] }
    } } as unknown as pg.Pool
    const authority = new PostgresOperatorChatAuthority(pool, {} as PostgresAccessService,
      {} as NativeRollout, '/runtime', 'http://localhost/mcp')
    await authority.revokeOrphanedCredentials()
    await authority.revokeOrphanedCredentials()
    expect(database.prepare('select id,revoked_at from management_principals order by id').all()).toEqual([
      { id: 'live', revoked_at: '2026-10-01T00:00:00Z' },
      { id: 'revoked', revoked_at: '2026-09-01T00:00:00Z' },
      { id: 'unrelated', revoked_at: null },
    ])
    expect(database.prepare('select principal_id from writes').all()).toEqual([{ principal_id: 'live' }])
  } finally {
    database.close()
  }
})
