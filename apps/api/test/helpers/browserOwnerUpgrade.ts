import type pg from 'pg'
import { localHumanMigration } from '../../src/infrastructure/localHumanMigration.js'

/** Restore the pre-upgrade owner mapping while keeping application records intact. */
export async function browserOwnerUpgrade(pool: pg.Pool, principalId: string,
  options: { ownerMapping?: 'present' | 'empty' } = {}): Promise<void> {
  await pool.query('drop table local_human_principal')
  await pool.query("delete from management_principals where id='principal-local-human'")
  await pool.query('delete from application_migrations where version=$1', [localHumanMigration.version])
  await pool.query('alter table management_principals drop constraint management_principals_credential_required')
  await pool.query(`create table browser_auth_owner (
    singleton boolean primary key default true check (singleton),
    principal_id text not null unique references management_principals(id)
  )`)
  if (options.ownerMapping !== 'empty') {
    await pool.query('insert into browser_auth_owner(singleton,principal_id) values(true,$1)', [principalId])
  }
}
