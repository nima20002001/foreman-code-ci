import type pg from 'pg'
import type { WorkerReleasePublication } from '@foreman-code/contracts/computer-maintenance'
import { withTransaction } from '../../infrastructure/transaction.js'
import { expireOverdueCiRuns } from '../ci-host/deadlines.js'
import { componentLogger } from './logger.js'
import { registerService, reportService, reportServiceFailure, trackService } from './serviceHealth.js'

/** One cleanup episode, including every retry, from its first request. Native cancellation retries are minutes apart. */
export const RUN_CLEANUP_DEADLINE_MS = 30 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const log = componentLogger('engine')

export interface StateDeadlineSources {
  ciRuns?: (now: Date) => Promise<number>
  workerPublication?: () => Promise<WorkerReleasePublication>
}

/** Marks overdue cleanup failed while it stays pending: native settlement is unconfirmed, so ownership is retained. */
async function expireRunCleanup(pool: pg.Pool, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RUN_CLEANUP_DEADLINE_MS)
  const overdue = (await pool.query<{ run_id: string }>(`select run_id from run_cleanup_intents
    where pending and deadline_exceeded_at is null and requested_at < $1`, [cutoff])).rows
  let expired = 0
  for (const { run_id: runId } of overdue) {
    // Run writers lock the Run before its cleanup intent and activity.
    const marked = await withTransaction(pool, async sql => {
      await sql.query('select 1 from runs where id=$1 for update', [runId])
      const row = (await sql.query<{ requested_at: Date; attempts: number; last_error: string | null }>(
        `update run_cleanup_intents set deadline_exceeded_at=$2
          where run_id=$1 and pending and deadline_exceeded_at is null and requested_at < $3
          returning requested_at,attempts,last_error`, [runId, now, cutoff])).rows[0]
      if (!row) return null
      const payload = { failed: true, attempt: row.attempts, code: 'RUN_CLEANUP_DEADLINE_EXCEEDED', phase: 'cleanup',
        ageMs: now.getTime() - row.requested_at.getTime(), deadlineMs: RUN_CLEANUP_DEADLINE_MS,
        cause: row.last_error ?? 'Native cleanup has not confirmed settlement.', ownership: 'retained' }
      await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
        values($1,'backend','run_cleanup_checked',$2,$3::jsonb)`, [runId, now, JSON.stringify(payload)])
      return payload
    })
    if (!marked) continue
    expired++
    log.error({ runId, ...marked }, 'RUN_CLEANUP_DEADLINE_EXCEEDED: Run cleanup is overdue; native ownership is retained')
  }
  return expired
}

/** A Job's accepted cleanup deadline covers every cleanup retry; physical closure may still finish later. */
async function expireJobCleanup(pool: pg.Pool, now: Date): Promise<number> {
  const rows = (await pool.query<{ execution_id: string; state: string; deadline_at: string }>(`
    update source_execution_materializations m set cleanup_deadline_exceeded_at=$1
    from job_executions e
    where m.execution_id=e.id and m.attempt_id=e.attempt_id and m.state<>'closed'
      and m.cleanup_deadline_exceeded_at is null
      and (e.accepted_spec#>>'{lifecycle,cleanupDeadlineAt}')::timestamptz < $1
    returning m.execution_id,m.state,e.accepted_spec#>>'{lifecycle,cleanupDeadlineAt}' as deadline_at`, [now])).rows
  for (const row of rows) {
    log.error({ executionId: row.execution_id, phase: 'cleanup', deadlineAt: row.deadline_at,
      ageMs: now.getTime() - Date.parse(row.deadline_at), cause: `source materialization is ${row.state}` },
    'JOB_CLEANUP_DEADLINE_EXCEEDED: Job source cleanup is overdue; its computers stay reserved until it closes')
  }
  return rows.length
}

/** The publication unit runs outside this process; its saved record is its health. */
function reportPublication(publication: WorkerReleasePublication, now: number) {
  const startedAt = publication.startedAt ? Date.parse(publication.startedAt) : null
  const deadline = publication.deadlineAt ? Date.parse(publication.deadlineAt) : null
  reportService('worker-publication', { deadlineMs: startedAt !== null && deadline !== null ? deadline - startedAt : 30 * 60_000 }, {
    lastStartedAt: startedAt, lastSuccessAt: publication.state === 'published' ? now : null,
    lastFailureAt: publication.state === 'failed' ? now : null, lastError: publication.lastError,
    nextDueAt: publication.nextRetryAt ? Date.parse(publication.nextRetryAt) : null,
    inFlightSince: publication.state === 'pending' ? startedAt : null,
  }, now)
}

export async function sweepStateDeadlines(pool: pg.Pool, sources: StateDeadlineSources = {}, now = new Date()) {
  const ci = sources.ciRuns ? await sources.ciRuns(now) : await expireOverdueCiRuns(pool, now)
  const runCleanup = await expireRunCleanup(pool, now)
  const jobCleanup = await expireJobCleanup(pool, now)
  if (sources.workerPublication) {
    try { reportPublication(await sources.workerPublication(), now.getTime()) }
    catch (error) {
      registerService('worker-publication', { deadlineMs: 30 * 60_000 })
      reportServiceFailure('worker-publication', error)
    }
  }
  return { ci, runCleanup, jobCleanup }
}

/** Sweeps at startup and every minute; a pass still running delays the next one. */
export function startStateDeadlineSweeper(pool: pg.Pool, sources: StateDeadlineSources = {}): () => void {
  const schedule = { cadenceMs: SWEEP_INTERVAL_MS, deadlineMs: 5 * 60_000 }
  registerService('state-deadlines', schedule)
  let running: Promise<unknown> | undefined
  const sweep = () => {
    running ??= trackService('state-deadlines', schedule, () => sweepStateDeadlines(pool, sources))
      .catch((error: unknown) => { log.warn({ err: error }, 'State deadline sweep failed; retrying next minute') })
      .finally(() => { running = undefined })
  }
  sweep()
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
