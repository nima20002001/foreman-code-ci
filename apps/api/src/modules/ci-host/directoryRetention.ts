import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { CiHostRequestSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'

export const CI_DIRECTORY_RETENTION_MS = 3 * 86_400_000
export const CI_DIRECTORY_KEEP = 200
export const CI_DIRECTORY_PAGE_SIZE = 1000
const terminalStates = new Set(['passed', 'failed', 'canceled', 'lost'])

/** Main's saved ticket, including its executor attempts, determines which local directories can expire. */
export async function ciDirectoryCleanupCandidates(pool: Pick<pg.Pool, 'query'>, host: CiRunRecord['computer'], now = Date.now(),
  options: { offset?: number } = {}) {
  if (!host) return []
  const hostRef = { ...host.hostRef }
  delete hostRef.slot
  const circleAccountId = hostRef.circleAccountId ?? 'default'
  if (circleAccountId === 'default') delete hostRef.circleAccountId
  const rows = (await pool.query<{ run_id: string; state: string; finished_at: string | null;
    collection: string | null; rank: string }>(`
    with tickets as materialized (
      -- Each operator on a stored record reads it from TOAST again: extract the fields once per ticket.
      select c.id::text as run_id, c.state, x."finishedAt" as finished_at, x.collection,
        x.computer->'hostRef' as host_ref, x."setupRetry" as setup_retry, x."executionRunId" as execution_run_id,
        x."executionHistory" as execution_history
      from ci_runs c cross join lateral jsonb_to_record(c.record)
        as x("finishedAt" text, collection text, computer jsonb, "setupRetry" jsonb, "executionRunId" text,
          "executionHistory" jsonb)
      where c.state in ('passed','failed','canceled','lost')
        and c.record->>'executorCleanupPending' is distinct from 'true'
        and (c.record->'retainedExecutions' @> '[{"executor":"retained"}]'::jsonb) is not true
        and ((c.record#>'{computer,hostRef}') @> $1::jsonb
          or (c.record#>'{setupRetry,failedComputer}') @> $1::jsonb
          or (c.record->'executionHistory') @> jsonb_build_array(jsonb_build_object('hostRef',$1::jsonb)))
    ), attempts as (
      select coalesce(execution_run_id,setup_retry->>'runId',run_id) as run_id,
        state, finished_at, collection, host_ref from tickets
      union all
      select run_id, state, finished_at, collection, setup_retry->'failedComputer' from tickets
        where setup_retry is not null and execution_history is null
      union all
      select attempt."runId", state, finished_at, collection, attempt."hostRef" from tickets
        cross join lateral jsonb_to_recordset(coalesce(execution_history,'[]'::jsonb))
          as attempt("runId" text,"hostRef" jsonb)
    ), owned_attempts as (
      select distinct run_id,state,finished_at,collection from attempts where host_ref @> $1::jsonb
        and coalesce(host_ref->>'circleAccountId','default')=$6
    ), ranked as (
      select *, row_number() over (order by finished_at::timestamptz desc nulls first, run_id desc) as rank
      from owned_attempts
    )
    select run_id,state,finished_at,collection,rank from ranked
    where rank > $2 and collection is distinct from 'pending'
      and finished_at::timestamptz < $3::timestamptz
    order by rank limit $4 offset $5`,
  [JSON.stringify(hostRef), CI_DIRECTORY_KEEP, new Date(now - CI_DIRECTORY_RETENTION_MS).toISOString(),
    CI_DIRECTORY_PAGE_SIZE, options.offset ?? 0, circleAccountId])).rows
  const cutoff = now - CI_DIRECTORY_RETENTION_MS
  return rows.filter(row => terminalStates.has(row.state) && row.collection !== 'pending'
    && row.finished_at !== null && Date.parse(row.finished_at) < cutoff).map(row => row.run_id)
}

/** Unknown, active and locally busy directories remain, even when Main has finished the ticket. */
export async function sweepCiRunDirectories(options: {
  root: string
  runIds: readonly string[]
  isInUse: (runId: string) => boolean | Promise<boolean>
  withRun: (runId: string, work: () => Promise<boolean>) => Promise<boolean | undefined>
}): Promise<string[]> {
  const request = CiHostRequestSchema.parse({ operation: 'status', cleanupRunIds: options.runIds }) as
    Extract<CiHostRequest, { operation: 'status' }>
  const runIds = request.cleanupRunIds ?? []
  const removed: string[] = []
  for (const runId of new Set(runIds)) {
    try {
      if (await options.isInUse(runId)) continue
      const deleted = await options.withRun(runId, async () => {
        if (await options.isInUse(runId)) return false
        const directory = join(options.root, 'runs', runId)
        const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as { state: string }
        if (!terminalStates.has(meta.state) || await options.isInUse(runId)) return false
        await rm(directory, { recursive: true, force: true })
        return true
      })
      if (deleted) removed.push(runId)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'CI_RUN_UNKNOWN') throw error
      // The runner translates missing metadata into CI_RUN_UNKNOWN. Only an
      // absent directory confirms cleanup; damaged metadata alone does not.
      const exists = await lstat(join(options.root, 'runs', runId)).then(() => true, missing => {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw missing
      })
      if (!exists) removed.push(runId)
    }
  }
  return removed
}


/** Only the final executor's confirmed cleanup can expire Main's fallback log. Ticket facts stay intact. */
export async function expireCiLogTails(pool: Pick<pg.Pool, 'query'>, host: NonNullable<CiRunRecord['computer']>,
  removedRunIds: readonly string[], now: number): Promise<void> {
  if (!removedRunIds.length) return
  const hostRef = { ...host.hostRef }
  delete hostRef.slot
  await pool.query(`update ci_runs c set log_tail=''
    where coalesce(c.record->>'executionRunId',c.record#>>'{setupRetry,runId}',c.id::text)=any($1::text[])
      and c.state in ('passed','failed','canceled','lost')
      and c.record#>'{computer,hostRef}' @> $2::jsonb
      and c.record->>'collection' is distinct from 'pending'
      and c.record->>'executorCleanupPending' is distinct from 'true'
      and c.record#>>'{deadlineExceeded,executor}' is distinct from 'retained'
      and (c.record->>'finishedAt')::timestamptz<$3::timestamptz and c.log_tail<>''
      and not exists (
        select 1 from harness_executions e join runs r on r.id=e.run_id
        where (e.id=c.record#>>'{initiator,executionId}' or exists (
          select 1 from ci_group_requesters q where q.group_id=c.group_id and q.execution_id=e.id))
          and (r.execution_state<>'completed' or exists (
            select 1 from run_cleanup_intents cleanup where cleanup.run_id=r.id and cleanup.pending))
      )`, [removedRunIds, JSON.stringify(hostRef), new Date(now - CI_DIRECTORY_RETENTION_MS)])
}
