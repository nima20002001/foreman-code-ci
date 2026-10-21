import type pg from 'pg'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../../../infrastructure/transaction.js'
import type { ArtifactPhysicalDeletionOwnership } from '../distributed/cleanup.js'

import { PostgresFileArtifactCleanupRepository } from './artifacts.js'

import { cleanupBatchSize, type FileCleanupCandidate, type FileCleanupOutcome, type FileCleanupRepository } from './repository.js'

interface Row {
  file_id: string; revision_id: string; storage_key: string; owner_principal_id: string
  request_id: string | null; expires_at: string; retention_revision: number
  state: string; due: boolean
}
const projection = `f.file_id,r.revision_id,r.storage_key,f.owner_principal_id,a.request_id,
  to_char(f.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,coalesce(p.revision,0) as retention_revision,
  f.state,f.expires_at<=clock_timestamp() as due`
const joins = `join file_revisions r on r.file_id=f.file_id
  left join file_allocations a on a.file_id=r.file_id and a.revision_id=r.revision_id
  left join file_retention_preferences p on p.owner_principal_id=f.owner_principal_id`
const eligible = `f.scope_kind in ('temporary','job_execution') and
  ((f.state in ('pending','ready','expired') and f.expires_at<=statement_timestamp()) or f.state='removed')`
function candidate(row: Row): FileCleanupCandidate {
  return { fileId: row.file_id, revisionId: row.revision_id, storageKey: row.storage_key,
    ownerPrincipalId: row.owner_principal_id, requestId: row.request_id,
    expiresAt: row.expires_at, retentionRevision: row.retention_revision }
}
function matches(row: Row | undefined, expected: FileCleanupCandidate): row is Row {
  return !!row && row.file_id === expected.fileId && row.revision_id === expected.revisionId
    && row.storage_key === expected.storageKey && row.owner_principal_id === expected.ownerPrincipalId
    && row.request_id === expected.requestId && row.expires_at === expected.expiresAt
    && row.retention_revision === expected.retentionRevision && (row.due || row.state === 'removed')
}

/** No cleanup receipt/migration: committed tombstones + remaining disk entries are the durable queue.
 * Never scan all historical tombstones each poll; the metadata expiry index discovers new work,
 * and the bounded objects/staging walk finds failed deletions, old revisions and late upload residue. */
export class PostgresFileCleanupRepository implements FileCleanupRepository {
  readonly artifacts: PostgresFileArtifactCleanupRepository
  constructor(private readonly pool: pg.Pool, private readonly physicalOwnership?: ArtifactPhysicalDeletionOwnership) {
    this.artifacts = new PostgresFileArtifactCleanupRepository(pool)
  }

  async findDue(afterFileId: string | null, limit: number): Promise<FileCleanupCandidate[]> {
    const result = await this.pool.query<Row>(`select ${projection} from files f ${joins}
      where f.scope_kind in ('temporary','job_execution') and f.state in ('pending','ready') and f.expires_at<=statement_timestamp()
        and r.revision_id=f.current_revision_id and ($1::text is null or f.file_id>$1)
      order by f.file_id limit $2`, [afterFileId, cleanupBatchSize(limit)])
    return result.rows.map(candidate)
  }

  async findByStorageKeys(keys: readonly string[]): Promise<FileCleanupCandidate[]> {
    if (!keys.length) return []
    cleanupBatchSize(keys.length)
    const result = await this.pool.query<Row>(`select ${projection} from files f ${joins}
      where ${eligible} and r.storage_key=any($1::uuid[]) order by r.storage_key`, [keys])
    return result.rows.map(candidate)
  }

  async remove(expected: FileCleanupCandidate, removeBytes: () => Promise<boolean>): Promise<FileCleanupOutcome> {
    const client = await this.pool.connect()
    const locks: { key: string; seed: number }[] = []
    let broken = false, inTransaction = false
    const onError = () => { broken = true }
    client.on('error', onError)
    const check = () => { if (broken) throw new Error('File cleanup database ownership was lost.') }
    const lock = async (key: string, seed: number) => {
      check()
      const result = await client.query<{ locked: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1,$2::bigint)) as locked', [key, seed])
        .catch((error: unknown) => { broken = true; throw error })
      if (result.rows[0]?.locked !== true) return false
      locks.push({ key, seed }); return true
    }
    const begin = async () => {
      check()
      await beginTransaction(client).catch((error: unknown) => { broken = true; throw error }); inTransaction = true
      await client.query("set local lock_timeout='1s'; set local statement_timeout='5s'")
    }
    const commit = async () => {
      check()
      await commitTransaction(client).catch((error: unknown) => { broken = true; throw error })
      inTransaction = false; check()
    }
    const read = async () => {
      check()
      // FOR UPDATE protects the file against lifecycle/scope changes through the actual unlink.
      // Revision storage keys are UNIQUE and immutable in FIL-03. No other revision (permanent
      // or temporary) can claim this object pathname; hard links at other keys are not removed.
      const result = await client.query<Row>(`select ${projection} from files f ${joins}
        where f.file_id=$1 and r.revision_id=$2 and f.scope_kind in ('temporary','job_execution') for update of f`,
      [expected.fileId, expected.revisionId])
      check(); return result.rows[0]
    }
    try {
      // Match PostgresFileRepository.withAllocation exactly. Allocation creation takes this
      // before the FIL-40 owner lock, so use the same order. Never wait behind a network stream.
      if (expected.requestId !== null && !await lock(
        JSON.stringify(['file-allocation', expected.ownerPrincipalId, expected.requestId]), 273601)) return 'busy'
      // Session variant of FIL-40's xact lock: same hash/key space, held across the tombstone
      // COMMIT and byte deletion. A missing preference row (revision 0) is protected too.
      if (!await lock(expected.ownerPrincipalId, 273640)) return 'busy'
      await begin()
      const before = await read()
      if (!matches(before, expected)) return 'stale'
      if (before.state === 'pending' || before.state === 'ready') {
        const marked = await client.query(`update files set state='expired' where file_id=$1
          and scope_kind in ('temporary','job_execution') and state in ('pending','ready')
          and expires_at=$2::timestamptz and expires_at<=clock_timestamp() returning file_id`,
        [expected.fileId, expected.expiresAt])
        if (!marked.rowCount) return 'stale'
      } else if (before.state !== 'expired' && before.state !== 'removed') return 'stale'
      // A crash/failed filesystem operation can never roll this tombstone back to a ready file.
      // An uncertain COMMIT acknowledgment never authorizes an unlink in this process.
      await commit()
      await begin()
      const current = await read()
      if (!matches(current, expected) || (current.state !== 'expired' && current.state !== 'removed')) return 'stale'
      check()
      // Holds defer physical deletion only. The already committed tombstone still denies access.
      if (this.physicalOwnership && !await this.physicalOwnership.assertCanDelete(expected, client)) return 'busy'
      check()
      const complete = await removeBytes()
      await commit()
      return complete ? 'cleaned' : 'remaining'
    } finally {
      if (inTransaction) {
        try { await rollbackTransaction(client) } catch { broken = true }
      }
      for (const held of locks.reverse()) {
        if (broken) break
        try {
          const result = await client.query<{ unlocked: boolean }>(
            'select pg_advisory_unlock(hashtextextended($1,$2::bigint)) as unlocked', [held.key, held.seed])
          if (result.rows[0]?.unlocked !== true) broken = true
        } catch { broken = true }
      }
      client.removeListener('error', onError)
      client.release(broken)
    }
  }
}
