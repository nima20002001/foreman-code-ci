import type pg from 'pg'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../../../infrastructure/transaction.js'

import { cleanupBatchSize, type FileArtifactCleanupCandidate,
  type FileCleanupOutcome } from './repository.js'

// Sessions issued before storage tracking have no binding in their record. Conservatively
// retain artifacts until those legacy sessions close/expire (accepted sessions live at most 1h).
const eligible = `(a.record->>'retiredAt' is not null or not exists (
  select 1 from file_tool_sessions s where s.revoked_at is null and s.expires_at>clock_timestamp()
    and (s.record->>'binding'=a.binding or s.record->>'binding' is null)))`
const ownsKey = `(coalesce(a.record->'storageKeys','[]'::jsonb) ? k.storage_key::text
  or a.record #>> '{snapshot,storageKey}'=k.storage_key::text)`

/** Artifact records are the durable byte registry, including writes that never became snapshots.
 * Never infer ownership of an unknown disk key. The snapshot fallback also reclaims current
 * pre-upgrade artifacts; a later write registers that old snapshot before replacing its pointer. */
export class PostgresFileArtifactCleanupRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByStorageKeys(keys: readonly string[]): Promise<FileArtifactCleanupCandidate[]> {
    if (!keys.length) return []
    cleanupBatchSize(keys.length)
    const result = await this.pool.query<{ artifact_id: string; binding: string; storage_key: string }>(`
      select a.artifact_id,a.binding,k.storage_key from unnest($1::uuid[]) k(storage_key)
      join file_tool_artifacts a on ${ownsKey}
      where ${eligible} and not exists (select 1 from file_revisions r where r.storage_key=k.storage_key)
      order by k.storage_key,a.artifact_id`, [keys])
    return result.rows.map((row) => ({ artifactId: row.artifact_id, binding: row.binding, storageKey: row.storage_key }))
  }

  async remove(expected: FileArtifactCleanupCandidate, removeBytes: () => Promise<boolean>): Promise<FileCleanupOutcome> {
    const client = await this.pool.connect()
    let broken = false, inTransaction = false, locked = false
    const onError = () => { broken = true }
    client.on('error', onError)
    const check = () => { if (broken) throw new Error('Artifact cleanup database ownership was lost.') }
    const begin = async () => {
      check()
      await beginTransaction(client).catch((error: unknown) => { broken = true; throw error })
      inTransaction = true
      await client.query("set local lock_timeout='1s'; set local statement_timeout='5s'")
    }
    const commit = async () => {
      check()
      await commitTransaction(client).catch((error: unknown) => { broken = true; throw error })
      inTransaction = false; check()
    }
    const read = async () => {
      check()
      const result = await client.query<{ retired_at: string | null; eligible: boolean }>(`
        select a.record->>'retiredAt' as retired_at,${eligible} as eligible
        from file_tool_artifacts a cross join (select $3::uuid as storage_key) k
        where a.artifact_id=$1 and a.binding=$2 and ${ownsKey}
          and not exists (select 1 from file_revisions r where r.storage_key=k.storage_key)
        for update of a`, [expected.artifactId, expected.binding, expected.storageKey])
      check(); return result.rows[0]
    }
    try {
      // Same key/seed as session issuance. Keep the lock through the retirement COMMIT and
      // unlink; a newly issued token cannot revive a handle which has already been retired.
      const lock = await client.query<{ locked: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1,273605)) as locked', [expected.binding])
        .catch((error: unknown) => { broken = true; throw error })
      locked = lock.rows[0]?.locked === true
      if (!locked) return 'busy'
      await begin()
      const before = await read()
      if (!before?.eligible) return 'stale'
      if (before.retired_at === null) {
        await client.query(`update file_tool_artifacts set record=record ||
          jsonb_build_object('state','failed','retiredAt',clock_timestamp())
          where artifact_id=$1 and binding=$2 and record->>'retiredAt' is null`,
        [expected.artifactId, expected.binding])
      }
      // This terminal marker must survive a failed unlink, restart or uncertain acknowledgement.
      // beginWrite/finishWrite/registerStorage cannot change a retired artifact back to ready.
      await commit()
      await begin()
      const current = await read()
      if (!current?.retired_at) return 'stale'
      check()
      const complete = await removeBytes()
      await commit()
      return complete ? 'cleaned' : 'remaining'
    } finally {
      if (inTransaction) {
        try { await rollbackTransaction(client) } catch { broken = true }
      }
      if (locked && !broken) {
        try {
          const result = await client.query<{ unlocked: boolean }>(
            'select pg_advisory_unlock(hashtextextended($1,273605)) as unlocked', [expected.binding])
          if (result.rows[0]?.unlocked !== true) broken = true
        } catch { broken = true }
      }
      client.removeListener('error', onError)
      client.release(broken)
    }
  }
}
