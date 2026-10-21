import { RetryBackoff } from '../../infrastructure/retryBackoff.js'
import type pg from 'pg'
import { withClientTransaction } from '../../infrastructure/transaction.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import { removeAbandonedRunSourceUses } from './runSourceUse.js'

export const SOURCE_RETENTION_SECONDS = 3600
const SNAPSHOT_SCAN_BATCH_SIZE = 50
type SnapshotStore = Pick<PrivateSourceSnapshotStore, 'remove' | 'withCaptureLock'>

/** Pressure can shorten retention, but cannot release a source that is still in use. */
async function releasableSnapshots(sql: GraphSqlClient, snapshotIds: string[],
  underPressure: boolean): Promise<Set<string>> {
  const result = await sql.query<{ snapshot_id: string }>(`with candidates as (
    select snapshot_id::text,(record->>'approvedAt')::timestamptz as approved_at,availability
    from source_snapshots where snapshot_id=any($1::uuid[])
  ), uses(snapshot_id,active,used_at,retention) as (
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from source_snapshot_uses u join candidates candidate on u.snapshot_id::text=candidate.snapshot_id
    union all
    select candidate.snapshot_id,e.record#>>'{process,phase}' is distinct from 'terminal'
        or e.record#>>'{process,processStopped}' is distinct from 'true'
        or e.record->>'publication' in ('pending','collecting'),
      greatest((e.record->>'updatedAt')::timestamptz,(e.record->>'finishedAt')::timestamptz),
      (e.accepted_spec#>>'{policy,retentionSeconds}')::integer
    from job_executions e join candidates candidate on e.accepted_spec#>>'{source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,q.record->>'state' is distinct from 'terminal' or q.record->>'cleanupStatus'='pending',
      coalesce((q.record->>'finishedAt')::timestamptz,(q.record->>'enqueuedAt')::timestamptz),
      (q.record#>>'{definition,spec,policy,retentionSeconds}')::integer
    from job_admission_queue q join candidates candidate
      on q.record#>>'{definition,spec,source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,e.id is null and c.status is distinct from 'closed',
      greatest(p.created_at,(c.closure->>'observedAt')::timestamptz),
      (p.definition#>>'{spec,policy,retentionSeconds}')::integer
    from job_preparations p left join job_executions e on e.id=p.execution_id
      left join source_preparation_reconciliations c on c.operation_id=p.operation_id
      join candidates candidate on p.definition#>>'{spec,source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,s.released_at is null,s.released_at,(s.spec#>>'{policy,retentionSeconds}')::integer
    from job_computer_selections s join candidates candidate on s.spec#>>'{source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from source_storage_reservations s
      left join job_preparations p on p.operation_id=s.owner_id
      left join job_computer_selections c on c.operation_id=s.owner_id
      left join execution_dispatch_intents i on i.operation_id=s.owner_id
      left join run_node_placements n on n.run_id=i.run_id and n.node_id=i.node_id
      join candidates candidate on p.definition#>>'{spec,source,snapshotId}'=candidate.snapshot_id
        or c.spec#>>'{source,snapshotId}'=candidate.snapshot_id
        or n.record#>>'{source,snapshotId}'=candidate.snapshot_id
        or s.record#>>'{preparation,source,snapshotId}'=candidate.snapshot_id
    where s.owner_kind='materialization' and s.state in ('preparing','owned','uncertain')
    union all
    select candidate.snapshot_id,m.state<>'closed',
      greatest((m.record#>>'{receipt,verifiedAt}')::timestamptz,m.cleanup_lease_expires_at),null::integer
    from source_execution_materializations m
      join candidates candidate on m.record#>>'{receipt,binding,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,c.status<>'closed',
      greatest(c.created_at,(c.closure->>'observedAt')::timestamptz),null::integer
    from source_preparation_reconciliations c
      join candidates candidate on c.owner#>>'{source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,r.execution_state<>'completed' or exists(
        select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending),
      coalesce((r.record->>'finishedAt')::timestamptz,(r.record->>'createdAt')::timestamptz),null::integer
    from run_node_placements p join runs r on r.id=p.run_id
      join candidates candidate on p.record#>>'{source,snapshotId}'=candidate.snapshot_id
        or p.record#>>'{source,revisionId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,r.execution_state<>'completed' or exists(
        select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending),
      coalesce((r.record->>'finishedAt')::timestamptz,(r.record->>'createdAt')::timestamptz),
      (d.record#>>'{spec,policy,retentionSeconds}')::integer
    from runs r join workflow_versions v on v.id=r.workflow_version_id
      cross join lateral jsonb_array_elements(v.record#>'{definition,nodes}') n
      join job_definition_versions d on d.id=n->>'jobDefinitionVersionId'
      join candidates candidate on d.record#>>'{spec,source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,true,(p.record->>'updatedAt')::timestamptz,null::integer
    from job_runtime_profiles p join candidates candidate
      on p.record#>>'{root,source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,a.record->>'status' in ('qualifying','recovery-required')
        or (a.record->>'status' in ('captured','awaiting-approval','approved')
          and (a.record->>'expiresAt')::timestamptz>clock_timestamp()),
      greatest((a.record->>'requestedAt')::timestamptz,(a.record->>'expiresAt')::timestamptz),null::integer
    from job_runtime_qualification_approvals a join candidates candidate
      on a.record#>>'{fingerprint,root,source,snapshotId}'=candidate.snapshot_id
    union all
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from workspace_repository_imports i join workspaces w on w.id=i.workspace_id
      join candidates candidate on i.results#>>'{approvedSource,manifest,snapshotId}'=candidate.snapshot_id
    where i.phase='ready' and w.archived_at is null
      and w.record->'repository'=i.input->'repository'
      and w.location_revision::text=i.results#>>'{location,locationRevision}'
    union all
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from workflows w join workspaces workspace on workspace.id=w.workspace_id
      join workflow_versions v on v.id=w.current_version_id
      join source_root_bindings b
        on b.workspace_id=w.workspace_id
        and b.root_id::text=v.record#>>'{definition,defaultWorktree,rootBinding,rootId}'
        and b.binding_revision::text=v.record#>>'{definition,defaultWorktree,rootBinding,bindingRevision}'
      join candidates candidate on b.snapshot_id::text=candidate.snapshot_id
    where w.archived_at is null and workspace.archived_at is null
    union all
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from workflows w join workspaces workspace on workspace.id=w.workspace_id
      join workflow_versions v on v.id=w.current_version_id
      cross join lateral jsonb_array_elements(v.record#>'{definition,nodes}') node
      join source_root_bindings b on b.workspace_id=w.workspace_id
        and b.root_id::text=node#>>'{placement,rootBinding,rootId}'
        and b.binding_revision::text=node#>>'{placement,rootBinding,bindingRevision}'
      join candidates candidate on b.snapshot_id::text=candidate.snapshot_id
    where w.archived_at is null and workspace.archived_at is null
    union all
    select candidate.snapshot_id,true,null::timestamptz,null::integer
    from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      join workspaces w on w.id=c.workspace_id
      join candidates candidate on b.snapshot_id::text=candidate.snapshot_id
    where w.archived_at is null
    union all
    select candidate.snapshot_id,false,(b.record->>'boundAt')::timestamptz,null::integer
    from source_root_bindings b join candidates candidate on b.snapshot_id::text=candidate.snapshot_id
  ) select s.snapshot_id from candidates s left join uses on uses.snapshot_id=s.snapshot_id
    group by s.snapshot_id,s.approved_at,s.availability
    having s.availability='unavailable' or (not coalesce(bool_or(active),false)
      and ($3::boolean or greatest(max(used_at),s.approved_at)
        + make_interval(secs=>coalesce(max(retention),$2)) < clock_timestamp()))`,
  [snapshotIds, SOURCE_RETENTION_SECONDS, underPressure])
  return new Set(result.rows.map(row => row.snapshot_id))
}

type Candidate = { snapshot_id: string; requested_by: string; command_id: string }

async function lockSnapshot(sql: pg.PoolClient, candidate: Candidate, scopeId: string) {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${scopeId}`])
  const command = (await sql.query<{ locked: boolean }>(
    'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
    [`command:${candidate.requested_by}:source.approve:${candidate.command_id}`])).rows[0]
  if (!command?.locked) return null
  // Admission locks the snapshot before storage; skip its row to avoid reversing that lock order.
  const snapshot = (await sql.query<{ availability: string; workspace_id: string }>(`select availability,workspace_id
    from source_snapshots where snapshot_id=$1 for update skip locked`, [candidate.snapshot_id])).rows[0]
  if (!snapshot) return null
  const reservation = (await sql.query<{ record: SourceReservation }>(`select record
    from source_storage_reservations where scope_id=$1 and owner_kind='capture' and owner_id=$2
      and state='retained' for update`, [scopeId, candidate.snapshot_id])).rows[0]
  return reservation ? { ...snapshot, reservation: reservation.record } : null
}

async function releaseSnapshot(pool: pg.Pool, store: SnapshotStore,
  scopeId: string, candidate: Candidate, underPressure: boolean): Promise<void> {
  // The directory lock excludes other removers without database locks spanning deletion.
  await store.withCaptureLock(candidate.snapshot_id, async () => {
    const sql = await pool.connect()
    try {
      const unavailable = await withClientTransaction(sql, async () => {
        const snapshot = await lockSnapshot(sql, candidate, scopeId)
        if (!snapshot || (snapshot.availability === 'retained'
          && !(await releasableSnapshots(sql, [candidate.snapshot_id], underPressure)).has(candidate.snapshot_id))) {
          return false
        }
        await sql.query("update source_snapshots set availability='unavailable' where snapshot_id=$1", [candidate.snapshot_id])
        // A crash leaves charged bytes, never usable missing bytes.
        return true
      })
      if (!unavailable) return
      await store.remove(candidate.snapshot_id)
      await withClientTransaction(sql, async () => {
        const fenced = await lockSnapshot(sql, candidate, scopeId)
        if (fenced?.availability === 'unavailable') {
          await new PostgresSourceReservations().reclaimed(sql, fenced.reservation, async () => true)
          await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,'system','source.snapshot.release',$2,'succeeded',$3::jsonb)`,
          [candidate.requested_by, fenced.workspace_id, JSON.stringify({ snapshotId: candidate.snapshot_id })])
        }
      })
    } finally { sql.release() }
  })
}

async function scanUnusedSourceSnapshots(pool: pg.Pool,
  store: SnapshotStore, scopeId: string,
  underPressure: boolean): Promise<unknown[]> {
  await removeAbandonedRunSourceUses(pool)
  const candidates = await pool.query<Candidate>(`select a.snapshot_id,a.requested_by,a.command_id
    from source_approvals a join source_snapshots s on s.snapshot_id=a.snapshot_id
    join source_storage_reservations r on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
    where a.state='approved' and r.state='retained' and r.scope_id=$1 order by a.created_at`, [scopeId])
  if (!candidates.rows.length) return []
  // Scan without the storage lock; only eligible snapshots need a locked recheck.
  const releasable = new Set<string>()
  for (let offset = 0; offset < candidates.rows.length; offset += SNAPSHOT_SCAN_BATCH_SIZE) {
    const batch = candidates.rows.slice(offset, offset + SNAPSHOT_SCAN_BATCH_SIZE)
    for (const id of await releasableSnapshots(pool, batch.map(row => row.snapshot_id), underPressure)) {
      releasable.add(id)
    }
  }
  const errors: unknown[] = []
  for (const candidate of candidates.rows) {
    if (!releasable.has(candidate.snapshot_id)) continue
    try {
      await releaseSnapshot(pool, store, scopeId, candidate, underPressure)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

type ReleaseScan = { pressure: { requested: boolean }; result: Promise<unknown[]> }
const releaseScans = new WeakMap<pg.Pool, Map<string, ReleaseScan>>()
const releaseRetries = new WeakMap<pg.Pool, Map<string, RetryBackoff>>()

export async function releaseUnusedSourceSnapshots(pool: pg.Pool,
  store: SnapshotStore, scopeId: string,
  report?: (error: unknown) => void, underPressure = false): Promise<void> {
  let retries = releaseRetries.get(pool)
  if (!retries) {
    retries = new Map()
    releaseRetries.set(pool, retries)
  }
  const retry = retries.get(scopeId) ?? new RetryBackoff({ initialMs: 10 * 60_000, maxMs: 60 * 60_000 })
  retries.set(scopeId, retry)
  // Maintenance reports failures for later retry; direct callers propagate errors and may retry immediately.
  if (report !== undefined && !underPressure && !retry.ready()) return
  let scopes = releaseScans.get(pool)
  if (!scopes) {
    scopes = new Map()
    releaseScans.set(pool, scopes)
  }
  let scan = scopes.get(scopeId)
  if (scan) {
    scan.pressure.requested ||= underPressure
  } else {
    const pressure = { requested: underPressure }
    const activeScopes = scopes
    const result = (async () => {
      try {
        const errors = await scanUnusedSourceSnapshots(pool, store, scopeId, underPressure)
        // A capacity failure joining periodic maintenance still needs a pressure pass.
        if (!underPressure && pressure.requested) {
          errors.push(...await scanUnusedSourceSnapshots(pool, store, scopeId, true))
        }
        if (errors.length) retry.fail()
        else retry.reset()
        return errors
      } catch (error) {
        retry.fail()
        return [error]
      } finally {
        activeScopes.delete(scopeId)
      }
    })()
    scan = { pressure, result }
    scopes.set(scopeId, scan)
  }
  for (const error of await scan.result) {
    if (!report) throw error
    report(error)
  }
}
