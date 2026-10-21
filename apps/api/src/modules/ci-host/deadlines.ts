import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { sanitizeCiText, serializeCiJson } from './text.js'

type Deadline = NonNullable<CiRunRecord['deadlineExceeded']>
type CiPhase = Deadline['phase']

/** Maximum age of each non-terminal ticket phase, measured from the phase entry time saved on the ticket. */
export const CI_PHASE_DEADLINES_MS: Record<CiPhase, number> = {
  // Longest observed queue wait is 70 minutes (p99 16).
  queued: 6 * 60 * 60_000,
  // Three 120 s start acknowledgements, or three 75 s cloud dispatches, with recovery reads.
  starting: 30 * 60_000,
  // The 3 h CI unit ceiling plus stop, log and report margin.
  running: 3.5 * 60 * 60_000,
  // The 5 min host report window plus the 10 min cloud collection recovery.
  collection: 30 * 60_000,
}
const CODES: Record<CiPhase, Deadline['code']> = {
  queued: 'CI_QUEUE_DEADLINE_EXCEEDED', starting: 'CI_START_DEADLINE_EXCEEDED',
  running: 'CI_RUN_DEADLINE_EXCEEDED', collection: 'CI_COLLECTION_DEADLINE_EXCEEDED',
}
const ACTIVE = ['queued', 'starting', 'running']
/** Tickets that hold an executor slot: assigned work, and deadline failures whose executor has not confirmed a stop. */
export const CI_BUSY_TICKET = `(state in ('starting','running') or record#>>'{deadlineExceeded,executor}'='retained'
  or record->>'executorCleanupPending'='true')`

/** The ticket's current phase and its saved entry time. Retries keep that entry time, and so the deadline. */
export function ciPhase(run: CiRunRecord): { phase: CiPhase; enteredAt: string } | null {
  if (run.deadlineExceeded) return null
  if (run.state === 'queued') return { phase: 'queued', enteredAt: run.queuedAt }
  if (run.state === 'starting') return { phase: 'starting', enteredAt: run.dispatchedAt ?? run.startedAt ?? run.queuedAt }
  if (ACTIVE.includes(run.state)) return { phase: 'running', enteredAt: run.startedAt ?? run.queuedAt }
  if (run.collection === 'pending' || run.observation?.status === 'unavailable') {
    return { phase: 'collection', enteredAt: run.finishedAt ?? run.queuedAt }
  }
  return null
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

/** The failed ticket. Starting and running tickets keep their executor and slot until it confirms the run stopped. */
export function expireCiRun(run: CiRunRecord, now: Date): CiRunRecord | null {
  const current = ciPhase(run)
  if (!current) return null
  const age = now.getTime() - Date.parse(current.enteredAt)
  const limit = CI_PHASE_DEADLINES_MS[current.phase]
  if (age <= limit) return null
  const detectedAt = now.toISOString()
  const cause = sanitizeCiText(run.observation?.lastError ?? run.message ?? 'No progress was reported.').slice(0, 1000)
  const retained = current.phase === 'starting' || current.phase === 'running'
  const deadlineExceeded: Deadline = { code: CODES[current.phase], phase: current.phase, enteredAt: current.enteredAt,
    deadlineAt: new Date(Date.parse(current.enteredAt) + limit).toISOString(), detectedAt, cause,
    executor: retained ? 'retained' : 'none' }
  const message = `${deadlineExceeded.code}: the ${current.phase} phase lasted ${minutes(age)}, over its ${minutes(limit)} `
    + `limit. Cause: ${cause}${retained ? ' Executor cleanup is unconfirmed; its slot stays reserved until the '
      + 'computer confirms the run stopped.' : ''}`
  if (current.phase === 'collection') {
    return CiRunRecordSchema.parse({ ...run, deadlineExceeded, message: message.slice(0, 2000),
      ...(run.collection === 'pending' ? { collection: 'failed' } : {}),
      observation: { status: 'available', lastSuccessAt: run.observation?.lastSuccessAt ?? null,
        lastError: deadlineExceeded.code, consecutiveFailures: 0, nextAttemptAt: null } })
  }
  return CiRunRecordSchema.parse({ ...run, state: 'failed', step: null, finishedAt: detectedAt, deadlineExceeded,
    message: message.slice(0, 2000), dispatchRequest: undefined, cancellation: undefined,
    ...(retained ? { collection: 'failed', observation: { status: 'unavailable',
      lastSuccessAt: run.observation?.lastSuccessAt ?? null, lastError: 'Executor cleanup unconfirmed.',
      consecutiveFailures: 0, nextAttemptAt: null } } : {}) })
}

/** Reconciles assigned work before expiry. Each write replaces only the exact record it read, so a concurrent
 * dispatch or observation that changed the ticket first wins and the next sweep re-evaluates it. */
export async function expireOverdueCiRuns(pool: pg.Pool, now = new Date(),
  reconcile?: (run: CiRunRecord, hostKey: string | null) => Promise<CiRunRecord>): Promise<number> {
  const rows = (await pool.query<{ id: string; state: string; record: unknown; host_key: string | null }>(
    // Candidates come from the state and recovery indexes; reading every ticket's record took seconds.
    `select id,state,record,host_key from ci_runs where id in (
      select id from ci_runs where state in ('queued','starting','running')
      union
      select id from ci_runs where state in ('starting','running') or record->>'collection'='pending'
        or state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable')
    and record->'deadlineExceeded' is null and (state in ('queued','starting','running')
      or record->>'collection'='pending' or record#>>'{observation,status}'='unavailable')`)).rows
  let expired = 0
  for (const row of rows) {
    let run = CiRunRecordSchema.parse(row.record)
    if (!expireCiRun(run, now)) continue
    if (run.state === 'starting' || run.state === 'running') {
      if (!reconcile) continue
      run = await reconcile(run, row.host_key)
    }
    const next = expireCiRun(run, now)
    if (!next) continue
    const saved = await pool.query(`update ci_runs set state=$2,
        host_key=case when $5 then host_key else null end, record=$3::jsonb
      where id=$1 and state=$4 and record=$6::jsonb`,
    [run.id, next.state, serializeCiJson(next), run.state,
      next.deadlineExceeded!.executor === 'retained' || next.executorCleanupPending
        || !ACTIVE.includes(run.state), JSON.stringify(run)])
    if (!saved.rowCount) continue
    expired++
    componentLogger('jobs').error({ runId: run.id, deadline: next.deadlineExceeded }, next.message ?? 'CI ticket deadline exceeded')
  }
  return expired
}
