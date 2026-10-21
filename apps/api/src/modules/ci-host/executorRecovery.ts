import type pg from 'pg'
import type { CiHostStatus, CiRunRecord } from '@foreman-code/contracts'
import { withoutCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { errorMessage } from '../../shared/errorMessage.js'
import type { HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'
import { ciExecutionRunId } from './executionAttempt.js'

const log = componentLogger('jobs')
export const CI_RETAINED_EXECUTORS = `record->'retainedExecutions' @> '[{"executor":"retained"}]'::jsonb`

/** Only a failed executor status/read proves lost observability; log/report collection failures do not. */
export class CiExecutorObservationError extends Error {
  readonly code: string | undefined

  constructor(cause: unknown) {
    super(errorMessage(cause, 'CI executor observation failed.'), { cause })
    this.code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : undefined
  }
}

export function ciTransportUnavailable(error: unknown) {
  return error instanceof CiExecutorObservationError
    && ['transport', 'timeout', 'CI_COMPUTER_OFFLINE'].includes(error.code ?? '')
}

export function ciExecutorOutageLimit(run: CiRunRecord) {
  // Two expected runtimes allow setup and timing variation. Five minutes absorb short link outages;
  // fifteen minutes cap the wait for long parts because transport failure gives no evidence of progress.
  return Math.min(15 * 60_000, Math.max(5 * 60_000, 2 * (run.expectedDurationMs ?? 0)))
}

export async function recordCiExecutorStatus(pool: pg.Pool, run: CiRunRecord,
  computer: HostCiComputer, status: CiHostStatus | null) {
  const executionRunId = ciExecutionRunId(run)
  const observed = status?.runs.some(execution => execution.runId === executionRunId)
  if (!observed) return
  // Status proves this execution is observable even when log reads fail; keep their retry backoff.
  await pool.query(`update ci_runs set record=jsonb_set(record,'{observation}',
      ((record->'observation') - 'transportUnavailableSince') || jsonb_build_object('lastSuccessAt',$4::text))
    where id=$1 and host_key=$2 and state in ('starting','running')
      and coalesce(record->>'executionRunId',record#>>'{setupRetry,runId}',id::text)=$3
      and record#>'{computer,hostRef}'=$5::jsonb
      and record#>>'{observation,transportUnavailableSince}' is not null`,
  [run.id, computer.key, executionRunId, new Date().toISOString(), JSON.stringify(computer.hostRef)])
}

/** Stop abandoned executions separately, so an unreachable old computer cannot delay the replacement's observation. */
export class CiRetainedExecutors {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly pool: pg.Pool, private readonly endpoint: HostCiEndpoint,
    private readonly computer: (hostRef: HostRef) => Promise<HostCiComputer>) {}

  work() { return [...this.pending.values()] }

  refresh(runs: CiRunRecord[], computers: HostCiComputer[], onReleased: () => void) {
    const limit = Math.max(1, Math.floor((this.pool.options?.max ?? 10) / 2))
    for (const run of runs) {
      if (this.pending.size >= limit) break
      if (this.pending.has(run.id) || !run.retainedExecutions?.some(attempt =>
        attempt.executor === 'retained' && Date.parse(attempt.nextAttemptAt) <= Date.now())) continue
      const work = withoutCiDatabasePriority(() => this.cleanup(run, computers))
        .then(released => { if (released) onReleased() })
        .catch(error => log.warn({ err: error, runId: run.id }, 'Abandoned CI executor cleanup failed'))
        .finally(() => { this.pending.delete(run.id) })
      this.pending.set(run.id, work)
    }
  }

  private async cleanup(listed: CiRunRecord, computers: HostCiComputer[]) {
    let released = false
    for (const attempt of listed.retainedExecutions ?? []) {
      if (attempt.executor !== 'retained' || Date.parse(attempt.nextAttemptAt) > Date.now()) continue
      let stopped: boolean
      try {
        const computer = computers.find(computer => computer.key === attempt.hostKey)
          ?? { ...await this.computer(attempt.computer.hostRef), key: attempt.hostKey }
        const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: attempt.runId },
          { priority: 'background' })
        stopped = reply.operation === 'cancel' && reply.run.runId === attempt.runId
          && !['queued', 'starting', 'running'].includes(reply.run.state) && !reply.run.executorCleanupPending
      } catch (error) {
        stopped = error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN'
        if (!stopped) log.warn({ err: error, runId: attempt.runId }, 'Abandoned CI executor remains reserved')
      }
      // Cleanup retries keep a one-minute interval even when the replacement is observed every second.
      const saved = await this.pool.query(`update ci_runs set record=jsonb_set(record,'{retainedExecutions}',
          (select jsonb_agg(case when entry->>'runId'=$2 then entry || $3::jsonb else entry end)
            from jsonb_array_elements(record->'retainedExecutions') entry))
        where id=$1 and record->'retainedExecutions' @> $4::jsonb`,
      [listed.id, attempt.runId, JSON.stringify({ executor: stopped ? 'released' : 'retained',
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString() }), JSON.stringify([attempt])])
      released ||= stopped && !!saved.rowCount
    }
    return released
  }
}
