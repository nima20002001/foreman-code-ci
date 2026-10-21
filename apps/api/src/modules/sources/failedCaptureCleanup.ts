import type pg from 'pg'
import { withClientTransaction, rollbackTransaction } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { SOURCE_RETENTION_SECONDS } from './snapshotRetention.js'

type CaptureStore = Pick<PrivateSourceSnapshotStore,
  'retainedCaptureBytes' | 'manifest' | 'withCaptureLock' | 'remove'>
type Candidate = { snapshot_id: string; requested_by: string; command_id: string }
type CaptureRow = { record: SourceReservation; state: string; workspace_id: string; expired: boolean }

async function readCapture(sql: pg.PoolClient, candidate: Candidate,
  options: { lock?: 'skip-locked' } = {}): Promise<CaptureRow | undefined> {
  return (await sql.query<CaptureRow>(`select r.record,a.state,a.workspace_id,
    a.created_at+make_interval(secs=>$2)<clock_timestamp() as expired
    from source_approvals a join source_storage_reservations r
      on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
        and r.reservation_id::text=(a.origin#>>'{reservation,reservationId}')
    where a.snapshot_id=$1 and a.state in ('failed','capturing')
      and r.state in ('preparing','uncertain','retained')
      and not exists(select 1 from source_snapshots s where s.snapshot_id=a.snapshot_id)
    ${options.lock ? 'for update of a,r skip locked' : ''}`,
  [candidate.snapshot_id, SOURCE_RETENTION_SECONDS])).rows[0]
}

async function canReplay(sql: pg.PoolClient, store: CaptureStore,
  candidate: Candidate, row: CaptureRow): Promise<boolean> {
  if (row.state !== 'capturing' || row.expired) return false
  try {
    const principal = await readLiveManagementPrincipal(sql, candidate.requested_by)
    const scope = { workspaceId: row.workspace_id }
    requireAuthorization(principal, 'source_roots:bind', scope)
    requireAuthorization(principal, 'sources:read', scope)
    requireAuthorization(principal, 'workspace_locations:read', scope)
    await store.manifest(candidate.snapshot_id)
    return true
  } catch (error) {
    if ((error instanceof DomainError && error.status === 403)
      || (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function reconcileCapture(sql: pg.PoolClient, store: CaptureStore, candidate: Candidate,
  row: CaptureRow): Promise<void> {
  if (row.record.ownerKind !== 'capture' || row.record.ownerId !== candidate.snapshot_id) {
    throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Failed capture reservation changed.', 409)
  }
  const replayable = await canReplay(sql, store, candidate, row)
  const bytes = await store.retainedCaptureBytes(candidate.snapshot_id)
  const reservations = new PostgresSourceReservations()
  const claimed = await withClientTransaction(sql, async () => {
    const storage = (await sql.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
      [`source-storage:${row.record.scopeId}`])).rows[0]
    const claimed = storage?.locked ? await readCapture(sql, candidate, { lock: 'skip-locked' }) : undefined
    if (!claimed) return undefined
    if (!replayable || claimed.expired) {
      await sql.query("update source_approvals set state='failed' where snapshot_id=$1 and state='capturing'",
        [candidate.snapshot_id])
    }
    await reservations.retain(sql, row.record, 'retained', bytes + 16 * 1024)
    // Persist the failed approval fence and release storage/row locks before filesystem deletion.
    return claimed
  })
  if (!claimed?.expired) return
  await store.remove(candidate.snapshot_id)
  await withClientTransaction(sql, async () => {
    await reservations.reclaimed(sql, row.record, async () => true)
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'system','source.capture.release',$2,'succeeded',$3::jsonb)`,
    [candidate.requested_by, row.workspace_id, JSON.stringify({ snapshotId: candidate.snapshot_id })])
  })
}

/** Command ownership spans commits; filesystem locks also exclude writers during database disconnects. */
export async function reconcileFailedCaptures(pool: pg.Pool, store: CaptureStore,
  report: (error: unknown) => void, scopeId?: string): Promise<void> {
  const candidates = await pool.query<Candidate>(`select a.snapshot_id,a.requested_by,a.command_id
    from source_approvals a join source_storage_reservations r
      on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
    where a.state in ('failed','capturing') and r.state in ('preparing','uncertain','retained')
      and ($1::text is null or r.scope_id=$1)
      and (r.state<>'retained' or a.created_at+make_interval(secs=>$2)<clock_timestamp())
      and not exists(select 1 from source_snapshots s where s.snapshot_id=a.snapshot_id)
    order by (r.state='preparing') desc,a.created_at limit 100`, [scopeId ?? null, SOURCE_RETENTION_SECONDS])
  for (const candidate of candidates.rows) {
    const sql = await pool.connect()
    const commandLock = `command:${candidate.requested_by}:source.approve:${candidate.command_id}`
    let commandLocked = false
    let releaseError: Error | undefined
    try {
      const lock = (await sql.query<{ locked: boolean }>(
        'select pg_try_advisory_lock(hashtext($1)) as locked', [commandLock])).rows[0]
      commandLocked = lock?.locked === true
      if (commandLocked) {
        const row = await readCapture(sql, candidate)
        if (row) {
          await store.withCaptureLock(candidate.snapshot_id,
            () => reconcileCapture(sql, store, candidate, row), { nonBlocking: true })
        }
      }
    } catch (error) {
      await rollbackTransaction(sql)
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'SOURCE_CLAIM_LOCK_FAILED') report(error)
    } finally {
      if (commandLocked) {
        try {
          await sql.query('select pg_advisory_unlock(hashtext($1))', [commandLock])
        } catch (error) {
          releaseError = error instanceof Error ? error : new Error('Capture reconciliation unlock failed.')
        }
      }
      sql.release(releaseError)
      if (releaseError) report(releaseError)
    }
  }
}
