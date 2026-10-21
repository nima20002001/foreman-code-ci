import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { bootIdentity, identityAlive, processIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { DomainError } from '../errors.js'

type SourceUseOwner = { bootId: string; pid: number; startTicks: string }
type SourceUse = { pool: pg.Pool; id: string; owner: SourceUseOwner; snapshots: Set<string> }
const preparing = new AsyncLocalStorage<SourceUse>()
const activeUses = new Set<string>()

/** Commit the reference through the connection already reading the snapshot. */
export async function retainRunSource(pool: pg.Pool, sql: GraphSqlClient, snapshotId: string): Promise<void> {
  const use = preparing.getStore()
  if (!use || use.pool !== pool) return
  if (!activeUses.has(use.id)) {
    throw new DomainError('SOURCE_PREPARATION_CLOSED', 'Run source preparation has already finished.', 409)
  }
  use.snapshots.add(snapshotId)
  const retained = await sql.query(`insert into source_snapshot_uses(use_id,snapshot_id,owner)
    select $1,snapshot_id,$3::jsonb from source_snapshots
    where snapshot_id=$2 and availability='retained' for share
    on conflict(use_id,snapshot_id) do update set owner=excluded.owner returning snapshot_id`,
  [use.id, snapshotId, JSON.stringify(use.owner)])
  if (!retained.rowCount) {
    throw new DomainError('SOURCE_UNAVAILABLE', 'The exact accepted source bytes are no longer retained.', 410)
  }
}

/** Recover abandoned references without expiring a preparation that is still running. */
export async function removeAbandonedRunSourceUses(pool: pg.Pool): Promise<void> {
  const uses = await pool.query<{ use_id: string; owner: SourceUseOwner }>(
    'select distinct use_id,owner from source_snapshot_uses')
  const bootId = bootIdentity()
  const abandoned = uses.rows.filter(({ use_id, owner }) => owner.bootId !== bootId || !identityAlive(owner)
    || owner.pid === process.pid && !activeUses.has(use_id)).map(use => use.use_id)
  if (abandoned.length) {
    await pool.query('delete from source_snapshot_uses where use_id=any($1::uuid[])', [abandoned])
  }
}

/** Keep committed snapshot references through preparation and Run commit, without retaining a connection. */
export async function withRunSourceUse<T>(pool: pg.Pool, workspaceId: string, work: () => Promise<T>): Promise<T> {
  const owner = processIdentity(process.pid)
  if (!owner) throw new Error('Run source preparation process identity is unavailable.')
  const use: SourceUse = { pool, id: randomUUID(), snapshots: new Set(),
    owner: { bootId: bootIdentity(), pid: owner.pid, startTicks: owner.startTicks } }
  activeUses.add(use.id)
  let result: { value: T } | { error: unknown }
  try {
    result = { value: await preparing.run(use, work) }
  } catch (error) {
    result = { error }
  } finally {
    activeUses.delete(use.id)
  }
  if (use.snapshots.size) {
    try {
      await pool.query('delete from source_snapshot_uses where use_id=$1', [use.id])
    } catch (error) {
      if ('error' in result) throw new AggregateError([result.error, error],
        `Run source-use cleanup failed for workspace ${workspaceId}.`, { cause: error })
      throw error
    }
  }
  if ('error' in result) throw result.error
  return result.value
}
