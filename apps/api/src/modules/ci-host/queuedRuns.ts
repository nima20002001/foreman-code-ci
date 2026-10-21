import type pg from 'pg'
import { CiCoverageSelectionSchema, CiRunRecordSchema, type CiCoverageSelection, type CiDurations } from '@foreman-code/contracts'
import { CI_QUEUE_ORDER } from './priority.js'

export async function readQueuedCiRuns(pool: pg.Pool) {
  // Eligibility is resolved after loading the queue; blocked entries cannot hide runnable work.
  const queuedRows = (await pool.query<{ record: unknown; durations: CiDurations | null }>(
    `select record,durations from ci_runs where state='queued' and record->>'supersededBy' is null
      and record->>'executorCleanupPending' is distinct from 'true'
      order by ${CI_QUEUE_ORDER}`)).rows
  const parsed = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
  const durations = new Map(queuedRows.map((row, index) => [parsed[index]!.id, row.durations]))
  const groups = [...new Set(parsed.filter(run => run.suite === 'integration' && run.deriveFiles).map(run => run.groupId))]
  const inputs = groups.length ? (await pool.query<{ group_id: string; integration_selection: unknown }>(
    'select group_id,integration_selection from ci_runs where group_id=any($1::uuid[]) and integration_selection is not null',
    [groups])).rows : []
  const coverage = new Map<string, CiCoverageSelection>(inputs.map(row =>
    [row.group_id, CiCoverageSelectionSchema.parse(row.integration_selection)]))
  return { parsed, durations, coverage }
}

export async function readCiGateReservation(pool: pg.Pool) {
  const rows = (await pool.query<{ record: unknown; created_at: Date }>(`select record,created_at from ci_runs
    where record->>'gate'='true' and group_id in (
      select group_id from ci_runs where state in ('queued','starting','running') and record->>'gate'='true')`)).rows
  const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
  if (!runs.length) return { gate: undefined, reservedHosts: new Set<string | undefined>() }
  const groups = [...new Set(runs.map(run => run.groupId))]
  const failed = (await pool.query<{ group_id: string }>(`select distinct group_id from ci_runs
    where group_id=any($1::uuid[]) and state in ('failed','lost') and record->>'gate'='true'`, [groups])).rows
  // A failed or lost sibling releases the group's barrier and host reservations.
  const doomed = new Set(failed.map(row => row.group_id))
  const live = runs.filter(run => ['queued', 'starting', 'running'].includes(run.state) && !doomed.has(run.groupId))
  const started = new Set(runs.filter(run => ['starting', 'running', 'passed'].includes(run.state)).map(run => run.groupId))
  const admitted = new Map<string, number>()
  for (const [index, run] of runs.entries()) {
    const createdAt = rows[index]!.created_at.getTime()
    admitted.set(run.groupId, Math.min(admitted.get(run.groupId) ?? createdAt, createdAt))
  }
  // A started group keeps the fleet through gaps between its parts; preparation time is not admission order.
  const gate = live.sort((left, right) => Number(started.has(right.groupId)) - Number(started.has(left.groupId))
    || admitted.get(left.groupId)! - admitted.get(right.groupId)!
    || left.groupId.localeCompare(right.groupId) || left.id.localeCompare(right.id))[0]
  const reservedHosts = new Set(live.filter(run => run.groupId === gate?.groupId && run.suite === 'integration')
    .map(run => run.plannedHostKey))
  return { gate, reservedHosts }
}
