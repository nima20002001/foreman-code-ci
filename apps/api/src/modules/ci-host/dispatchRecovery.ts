import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiHostReplySchema, type CiHostReply, type CiHostStatus,
  type CiRunRecord } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { withoutCiDatabaseDeadline, withoutCiDatabaseReservation } from '../../infrastructure/ciDatabasePriority.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { CiRunSettlement, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { CI_START_ACK_TIMEOUT_MS, CI_START_MAX_ATTEMPTS, releaseCiDispatch, rejectedCiStart,
  requestCiStart, withCiTicketLock } from './dispatch.js'
import type { CiTicketSql } from './dispatch.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { dispatchCloudTicket } from './cloudDispatch.js'
import { ciExecutionRunId } from './executionAttempt.js'

const log = componentLogger('jobs')
export type CiDispatchState = Pick<CiRunSettlement, 'state' | 'step' | 'exitCode' | 'startedAt' | 'finishedAt' | 'message'
  | 'collection' | 'provenance' | 'mirrorPublication' | 'testsStarted' | 'selection' | 'executorCleanupPending'>
interface DispatchServices {
  pool: pg.Pool
  endpoint: HostCiEndpoint
  read(id: string, workspaceId: string, client: SqlQuery): Promise<CiRunRecord>
  rejected?(run: CiRunRecord, computer: HostCiComputer, error: unknown): void
  settle(run: CiRunRecord, computer: HostCiComputer, state: CiDispatchState,
    options: { client: CiTicketSql }): Promise<boolean>
}

async function retainDispatch(client: SqlQuery, run: CiRunRecord, computer: HostCiComputer,
  message: string, attempts = run.dispatchAttempts) {
  const next = { ...run, message: sanitizeCiText(message).slice(0, 2000), dispatchAttempts: attempts }
  if (next.message === run.message && attempts === run.dispatchAttempts) return run
  const saved = await client.query(`update ci_runs set state=$2,host_key=$3,record=$4::jsonb
    where id=$1 and state='starting' and host_key=$3 and record=$5::jsonb`,
  [run.id, run.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return saved.rowCount ? next : null
}

export function sendCiDispatch(services: DispatchServices, run: CiRunRecord, computer: HostCiComputer) {
  return withoutCiDatabaseReservation(() => sendDispatch(services, run, computer))
}

async function sendDispatch(services: DispatchServices, run: CiRunRecord, computer: HostCiComputer) {
  const outcome = await withCiTicketLock(services.pool, run.id, async client => {
    const current = await services.read(run.id, run.workspaceId, client)
    if (current.cancellation) return 'pending'
    if ((!current.dispatchRequest && !(computer.hostRef.kind === 'cloud' && current.state === 'starting'))
      || !isDeepStrictEqual(current.computer?.hostRef, computer.hostRef)) return 'settled'
    return sendAssignedDispatch(services, current, computer, client)
  })
  return outcome ?? 'pending'
}

async function sendAssignedDispatch(services: DispatchServices, run: CiRunRecord,
  computer: HostCiComputer, client: CiTicketSql) {
  if (computer.hostRef.kind === 'cloud') {
    // The committed ticket claim owns provider I/O and settlement beyond the scheduling pass.
    return withoutCiDatabaseDeadline(async () => {
      const result = await dispatchCloudTicket(client, services.endpoint, computer, run,
        error => services.rejected?.(run, computer, error))
      if (result.outcome === 'settled') await services.settle(result.run, computer, result.observed, { client })
      return result.outcome
    })
  }
  const request = run.dispatchRequest
  if (!request) throw new Error('CI dispatch request is missing.')
  let reply: Extract<CiHostReply, { operation: 'start' }>
  try {
    const response = CiHostReplySchema.parse(await requestCiStart(() => services.endpoint.request(computer, request)))
    if (response.operation !== 'start') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    }
    reply = response
  } catch (error) {
    if (!rejectedCiStart(error)) {
      const message = error instanceof Error ? error.message : String(error)
      await retainDispatch(client, run, computer, `${message} Ownership retained until execution is reconciled.`)
      log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start reply unknown; retaining executor')
      return 'pending'
    }
    if ((error as DomainError).code === 'CI_MIRROR_PRIVATE_DATA') {
      const now = new Date().toISOString()
      await services.settle(run, computer, { state: 'failed', step: null, exitCode: null,
        startedAt: now, finishedAt: now, message: (error as Error).message }, { client })
      return 'settled'
    }
    if (!await releaseCiDispatch(client, run, computer, (error as Error).message, { clearRetry: true })) return 'pending'
    services.rejected?.(run, computer, error)
    return (error as DomainError).code === 'CI_HOST_BUSY' ? 'busy' : 'rejected'
  }
  try {
    await services.settle(run, computer, reply.run, { client })
    return 'settled'
  } catch (error) {
    log.warn({ operation: 'settle accepted CI start', err: error, runId: run.id, computer: computer.key },
      'CI start accepted; retaining its assignment until settlement is reconciled')
    return 'pending'
  }
}

export async function reconcileCiHostStart(services: DispatchServices, run: CiRunRecord,
  computer: HostCiComputer, status: CiHostStatus | null) {
  if (computer.hostRef.kind === 'cloud' || run.state !== 'starting' || run.startedAt || run.cancellation) return false
  const outcome = await withCiTicketLock(services.pool, run.id, async client => {
    const current = await services.read(run.id, run.workspaceId, client)
    if (current.state !== 'starting' || current.startedAt || current.cancellation
      || !isDeepStrictEqual(current.computer?.hostRef, computer.hostRef)
      || current.dispatchedAt !== run.dispatchedAt || current.dispatchAttempts !== run.dispatchAttempts) return false
    const observed = status?.runs.find(value => value.runId === ciExecutionRunId(current))
    if (observed) {
      if (observed.state === 'starting' && observed.step === 'dispatch') return false
      return services.settle(current, computer, observed, { client })
    }
    const attempts = current.dispatchAttempts ?? 1
    if (attempts >= CI_START_MAX_ATTEMPTS) {
      return Boolean(await retainDispatch(client, current, computer,
        `CI start was not acknowledged after ${attempts} attempts. Ownership retained; Operator cancellation is required.`))
    }
    if (!status) {
      const elapsed = Date.now() - Date.parse(current.dispatchedAt ?? current.queuedAt)
      if (elapsed < CI_START_ACK_TIMEOUT_MS) return false
      return Boolean(await retainDispatch(client, current, computer,
        'The start acknowledgement timed out and computer status is unavailable. Ownership retained; cancellation remains pending.'))
    }
    if (!status.ready || !current.dispatchRequest) return false
    // An absent status entry does not prove an earlier request stopped; retries keep the same assignment and run ID.
    // Commit the retry counter before entry without holding a row lock that would block cancellation intent.
    const retry = await retainDispatch(client, current, computer,
      'The computer reports no such CI run. Retrying the assigned executor.', attempts + 1)
    if (!retry) return false
    await sendAssignedDispatch(services, retry, computer, client)
    return true
  })
  return outcome ?? false
}
