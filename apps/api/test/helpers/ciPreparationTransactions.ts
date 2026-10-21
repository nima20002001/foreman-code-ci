import { expect } from 'vitest'
import type { SqlQuery } from '../../src/infrastructure/transaction.js'

/** The command's retained session lock identifies the resolver even while duplicate requests are waiting. */
export async function expectCiPreparationOutsideTransaction(sql: SqlQuery, commandKey: string) {
  const { rows } = await sql.query<{ pid: number; xact_start: Date | null; owns_command: boolean }>(`
    select a.pid,a.xact_start,exists (
      select 1 from pg_locks l where l.pid=a.pid and l.database=a.datid
        and l.locktype='advisory' and l.granted and l.objsubid=1
        and ((l.classid::bigint << 32) | l.objid::bigint)=hashtext($1)::bigint
    ) as owns_command
    from pg_stat_activity a where a.datname=current_database() and a.pid<>pg_backend_pid()
      and a.application_name in ('ci-admission-test','graphql-lifecycle-command')`, [commandKey])
  const preparation = rows.filter(session => session.owns_command)
  expect(preparation).toHaveLength(1)
  expect(preparation.filter(session => session.xact_start !== null)).toHaveLength(0)
}
