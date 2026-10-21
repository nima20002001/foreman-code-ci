import type pg from 'pg'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileRetentionPreferenceSchema,
  type FileRetentionPreference,
} from '@foreman-code/contracts/files'

import { DomainError } from '../errors.js'

type Query = Pick<pg.PoolClient, 'query'>

/** Called inside the SAME transaction as save or allocation insertion, never over a network upload. */
export async function lockFileRetentionOwner(client: Query, ownerPrincipalId: string): Promise<void> {
  await client.query("set local lock_timeout = '5s'")
  try {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,273640))', [ownerPrincipalId])
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
      throw new DomainError('FILE_RETENTION_BUSY', 'Retention is being updated. Retry the same request.', 409, undefined, { cause: error })
    }
    throw error
  }
}

export async function readFileRetentionPreference(query: Query, ownerPrincipalId: string): Promise<FileRetentionPreference> {
  const result = await query.query<{ duration_seconds: number; revision: number }>(
    'select duration_seconds,revision from file_retention_preferences where owner_principal_id=$1', [ownerPrincipalId])
  const row = result.rows[0]
  return FileRetentionPreferenceSchema.parse({ ownerPrincipalId,
    durationSeconds: row?.duration_seconds ?? DEFAULT_FILE_RETENTION_SECONDS, revision: row?.revision ?? 0 })
}

/** FIL-03 transactional allocation adapter. Its lock lasts through file/revision/receipt COMMIT. */
export async function readFileRetentionSnapshot(client: pg.PoolClient, ownerPrincipalId: string): Promise<number> {
  await lockFileRetentionOwner(client, ownerPrincipalId)
  return (await readFileRetentionPreference(client, ownerPrincipalId)).durationSeconds
}

// Keep preview and save predicates identical. $3 is one explicit instant sampled AFTER the owner lock.
// A pending/ready row that is already overdue is NOT live, even before FIL-04 persists its expiry.
export const LIVE_OWNER_TEMPORARY_FILES_SQL = `owner_principal_id=$1 and scope_kind='temporary'
  and state in ('pending','ready') and expires_at>$3::timestamptz`
export const PROPOSED_FILE_EXPIRY_SQL = "created_at + $2::integer * interval '1 second'"
