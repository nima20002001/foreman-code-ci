import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { CiRunRecordSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import { errorMessage } from '../../shared/errorMessage.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
export { withCiTicketLock, type CiTicketSql } from './ticketLock.js'

export const CI_START_ACK_TIMEOUT_MS = 120_000
export const CI_START_MAX_ATTEMPTS = 3

/** A stale planning or queue snapshot may only replace the same unassigned queued record. */
export async function saveQueuedCiRun(pool: pg.Pool, previous: CiRunRecord, next: CiRunRecord) {
  if (isDeepStrictEqual(previous, next)) return false
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
  [previous.id, next.state, null, serializeCiJson(next), JSON.stringify(previous)])
  return Boolean(saved.rowCount)
}

/** Only the winning database claim may enter an executor. */
export async function claimCiDispatch(pool: SqlQuery, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | null> {
  const next = CiRunRecordSchema.parse({ ...run, state: 'starting', step: 'dispatch', message: null,
    computer: { hostRef: computer.hostRef, label: computer.label }, dispatchRequest: request,
    dispatchAttempts: computer.hostRef.kind === 'cloud' ? 0 : (run.dispatchAttempts ?? 0) + 1,
    dispatchedAt: new Date().toISOString(),
    ...(computer.hostRef.kind !== 'cloud' ? { dispatchHostKey: computer.key } : {}) })
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb
      and (record->>'gate' is distinct from 'true' or not exists (
        select 1 from ci_runs failed where failed.workspace_id=ci_runs.workspace_id
          and failed.group_id=ci_runs.group_id and failed.state='failed' and failed.record->>'gate'='true'))`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return saved.rowCount ? next : null
}

/** Uncertain host deliveries retain dispatchHostKey for same-computer retries. */
export async function releaseCiDispatch(sql: SqlQuery, run: CiRunRecord, computer: HostCiComputer, message: string,
  options: { clearRetry?: boolean } = {}) {
  if (run.state !== 'starting') return false
  const next = CiRunRecordSchema.parse({ ...run, state: 'queued', computer: null, step: null,
    startedAt: null, finishedAt: null,
    dispatchHostKey: options.clearRetry ? undefined : run.dispatchHostKey ?? computer.key,
    dispatchAttempts: options.clearRetry ? undefined : run.dispatchAttempts ?? 1,
    dispatchRequest: undefined, dispatchedAt: undefined, ...ciMessages(run, sanitizeCiText(message)) })
  const saved = await sql.query(`update ci_runs set state=$2, host_key=null, record=$4::jsonb
    where id=$1 and state='starting' and host_key=$3 and record=$5::jsonb`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return Boolean(saved.rowCount)
}

export function ciMessages(run: CiRunRecord, observed: string | null) {
  const providerMessage = observed?.slice(0, 2000) ?? null
  const history = [...run.messageHistory ?? []]
  if (providerMessage && providerMessage !== run.providerMessage) {
    if (!history.includes(providerMessage)) history.push(providerMessage)
  }
  const messageHistory = history.slice(-8)
  const message = run.supersededBy ? `superseded by ${run.supersededBy}` : providerMessage
  return {
    ...(providerMessage !== null || run.providerMessage !== undefined ? { providerMessage } : {}),
    ...(messageHistory.length > 0 || run.messageHistory !== undefined ? { messageHistory } : {}),
    message,
  }
}

/** No Start was sent, so even a transport failure here is safe to requeue. */
export class CiStartPreflightError extends Error {
  readonly code: string

  constructor(cause: unknown) {
    super(errorMessage(cause, 'CI start preflight failed.'), { cause })
    this.code = cause && typeof cause === 'object' && 'code' in cause
      ? String(cause.code) : 'CI_START_PREFLIGHT_FAILED'
  }
}

export function structuralCiStartRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['COMPUTER_GITHUB_REQUIRED', 'CI_HOST_PROTOCOL_UNSUPPORTED']
    .includes(String(error.code))
}

export function rejectedCiStart(error: unknown) {
  if (error instanceof CiStartPreflightError || error instanceof DeviceApplicationAdmissionError) return true
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['CI_HOST_BUSY', 'COMPUTER_GITHUB_REQUIRED', 'CI_CLOUD_UNAVAILABLE',
    'BUILD_COMPUTER_DISABLED', 'CI_HOST_PROTOCOL_UNSUPPORTED', 'CI_MIRROR_PRIVATE_DATA',
    'WORKER_RUNTIME_DRAINING', 'WORKER_UPDATING', 'WORKER_VERSION_SKEW',
    'WORKER_STATUS_UNAVAILABLE', 'WORKER_BUNDLE_UNPUBLISHED'].includes(String(error.code))
}

/** The request may finish later; its reply cannot settle a ticket after this deadline. */
export async function requestCiStart<T>(request: () => Promise<T>,
  options: { timeoutMs?: number } = {}): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([request(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CI start acknowledgement timed out.')),
        options.timeoutMs ?? CI_START_ACK_TIMEOUT_MS)
      timer.unref()
    })])
  } finally {
    clearTimeout(timer)
  }
}
