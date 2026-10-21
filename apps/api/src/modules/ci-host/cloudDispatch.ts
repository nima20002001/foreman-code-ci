import { CiHostReplySchema, CiRunRecordSchema, type CiHostReply, type CiHostRequest,
  type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { CLOUD_START_TIMEOUT_MS } from './cloudProviders.js'
import { CI_START_MAX_ATTEMPTS, rejectedCiStart, releaseCiDispatch, requestCiStart } from './dispatch.js'
import type { CiRunSettlement, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { serializeCiJson } from './text.js'
import { ciExecutionRunId } from './executionAttempt.js'

const log = componentLogger('jobs')
type DispatchOutcome = { outcome: 'pending' | 'busy' | 'rejected' }
  | { outcome: 'settled'; run: CiRunRecord; observed: CiRunSettlement }

function unstarted(run: CiRunRecord, state: 'queued' | 'failed', message: string): CiRunSettlement {
  return { runId: run.id, state, step: null, startedAt: null,
    finishedAt: state === 'queued' ? null : new Date().toISOString(), exitCode: null, logBytes: 0, message }
}

export function requestCloud(endpoint: HostCiEndpoint, computer: HostCiComputer,
  request: CiHostRequest): Promise<CiHostReply> {
  return requestCiStart(() => endpoint.request(computer, request.operation === 'start'
    ? { ...request, deferMirror: true } : request), { timeoutMs: CLOUD_START_TIMEOUT_MS })
}

function cloudDispatchStartedAt(run: CiRunRecord, observed?: CiHostRun): number {
  const timestamps = [observed?.mirrorPublication?.finishedAt, run.mirrorPublication?.finishedAt,
    observed?.startedAt, run.startedAt, run.dispatchedAt]
    .filter((at): at is string => at != null)
    .map(at => Date.parse(at))
  return timestamps.length > 0 ? Math.max(...timestamps) : Date.parse(run.queuedAt)
}

export async function expireCloudDispatch(endpoint: HostCiEndpoint, computer: HostCiComputer,
  run: CiRunRecord, observed?: CiHostRun): Promise<CiRunSettlement | null> {
  if (observed?.mirrorPublication?.state === 'pending') return observed
  const at = cloudDispatchStartedAt(run, observed)
  if ((observed?.state ?? run.state) !== 'starting'
    || Date.now() - at < CLOUD_START_TIMEOUT_MS * CI_START_MAX_ATTEMPTS) return observed ?? null
  try {
    const reply = CiHostReplySchema.parse(await requestCloud(endpoint, computer,
      { operation: 'cancel', runId: ciExecutionRunId(run) }))
    if (reply.operation !== 'cancel' || reply.run.runId !== ciExecutionRunId(run)
      || ['queued', 'starting', 'running'].includes(reply.run.state)) {
      throw new DomainError('CI_CLOUD_CLEANUP_PENDING', 'Cloud cancellation was not confirmed; ownership retained.', 503)
    }
    if (reply.run.state !== 'canceled' || reply.run.executorCleanupPending) return reply.run
  } catch (error) {
    log.warn({ runId: run.id }, 'Expired cloud dispatch cleanup remains pending; ownership retained')
    if (error instanceof DomainError && error.code === 'CI_CLOUD_CLEANUP_PENDING') throw error
    throw new DomainError('CI_CLOUD_CLEANUP_PENDING', 'Cloud cancellation failed; ownership retained.', 503, undefined, { cause: error })
  }
  const reason = observed?.message ?? run.message
  return unstarted(run, 'queued', ['Cloud dispatch created no workflow after recovery attempts; queued for another computer.',
    reason].filter(Boolean).join(' '))
}

/** Main also bounds failures before the cloud adapter can persist its provider dispatch. */
export async function dispatchCloudTicket(sql: SqlQuery, endpoint: HostCiEndpoint,
  computer: HostCiComputer, run: CiRunRecord, onRejected?: (error: unknown) => void): Promise<DispatchOutcome> {
  const attempts = run.dispatchAttempts ?? 1
  const elapsed = Date.now() - cloudDispatchStartedAt(run)
  if (attempts > 0) {
    try {
      const reply = await requestCloud(endpoint, computer, { operation: 'read', runId: ciExecutionRunId(run),
        afterOffset: 0, maxBytes: 1 })
      if (reply.operation !== 'read') throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected cloud CI read.', 502)
      const observed = await expireCloudDispatch(endpoint, computer, run, reply.run) ?? reply.run
      return { outcome: 'settled', run, observed }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CI_CLOUD_CLEANUP_PENDING') throw error
      if (!(error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN')) {
        log.warn({ err: error, runId: run.id }, 'Cloud CI dispatch ownership could not be read')
        if (elapsed >= CLOUD_START_TIMEOUT_MS * CI_START_MAX_ATTEMPTS) {
          const observed = await expireCloudDispatch(endpoint, computer, run)
          if (observed) return { outcome: 'settled', run, observed }
        }
        return { outcome: 'pending' }
      }
    }
    if (elapsed < CLOUD_START_TIMEOUT_MS) return { outcome: 'pending' }
    if (attempts >= CI_START_MAX_ATTEMPTS || !run.dispatchRequest) {
      return { outcome: 'settled', run, observed: unstarted(run, 'queued',
        'Cloud dispatch created no workflow within 75 seconds; dispatch retries exhausted; queued for another computer.') }
    }
  }
  const next = CiRunRecordSchema.parse({ ...run, dispatchAttempts: attempts + 1,
    dispatchedAt: new Date().toISOString() })
  const saved = await sql.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='starting' and host_key=$3 and record=$5::jsonb`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  if (!saved.rowCount) return { outcome: 'pending' }
  try {
    const reply = CiHostReplySchema.parse(await requestCloud(endpoint, computer, next.dispatchRequest!))
    if (reply.operation !== 'start') throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected cloud CI start.', 502)
    return { outcome: 'settled', run: next, observed: reply.run }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'CI_MIRROR_PRIVATE_DATA') {
      return { outcome: 'settled', run: next, observed: unstarted(next, 'failed', error.message) }
    }
    if (rejectedCiStart(error)) {
      const released = await releaseCiDispatch(sql, next, computer, (error as Error).message, { clearRetry: true })
      if (released) {
        onRejected?.(error)
        return { outcome: (error as DomainError).code === 'CI_HOST_BUSY' ? 'busy' : 'rejected' }
      }
    }
    log.warn({ err: error, runId: run.id, attempts: next.dispatchAttempts }, 'Cloud CI start remains pending')
    return { outcome: 'pending' }
  }
}
