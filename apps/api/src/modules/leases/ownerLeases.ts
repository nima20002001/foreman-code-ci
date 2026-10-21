import { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS } from '../access/credentialLifetime.js'
import { DomainError } from '../errors.js'
import { deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { explicitFailureClass, isDatabaseTimeout } from '@foreman-code/contracts/failure'

/** A renewal may be retried after database, socket or device loss, unless the failure states otherwise. A non-503
 * domain refusal is final. */
export function isTransientRefreshFailure(error: unknown): boolean {
  if (isDatabaseTimeout(error)) return true
  if (error instanceof DomainError && error.status !== 503) return false
  return (explicitFailureClass(error) ?? deviceApplicationFailure(error).class) === 'transient'
}

/** One lease held by an owner. No token or secret is passed through here. */
export interface OwnedLease {
  /** Names the lease in failures, e.g. "execution credential". */
  readonly name: string
  /** Renew once no more than this lifetime remains. */
  readonly renewWithinMs: number
  /** Remaining lifetime; NaN once the owner no longer holds the lease. */
  remainingMs(): number
  renew(): Promise<void>
}

export type LeaseRenewalPhase = 'check' | 'refresh'

/** A one-line, secret-free description of why a renewal failed, for Agents and route files. */
export function leaseFailureCause(error: unknown): string {
  const describe = (value: unknown) => {
    if (!(value instanceof Error)) return String(value)
    const code = 'code' in value && (typeof value.code === 'string' || typeof value.code === 'number') ? `${value.code}: ` : ''
    return `${code}${value.message}`
  }
  const own = describe(error)
  const cause = error instanceof Error && error.cause !== undefined ? ` (cause: ${describe(error.cause)})` : ''
  return `${own}${cause}`.slice(0, 500)
}

/**
 * The single renewer for everything one owner holds (an execution attempt, a native turn, a queued resume).
 * Leases are renewed together, in the listed dependency order, while the owner is live. Aborting the owner's
 * signal stops renewal at once. The first non-transient failure, or reaching the earliest lease's safety
 * margin, stops renewal and reports the original error (deadline failures carry the last renewal error as cause).
 */
export function renewOwnedLeases(input: {
  signal: AbortSignal
  leases: readonly OwnedLease[]
  /** Confirms the owner is still live; runs before every renewal pass. */
  check?(): Promise<void>
  onFailure(error: Error, phase: LeaseRenewalPhase, lease?: string): void
}): () => Promise<void> {
  let stopped = false
  let running: Promise<void> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryMs = 1_000
  let phase: LeaseRenewalPhase = 'check'
  let current: string | undefined
  let lastFailure: unknown
  const earliest = () => {
    let lease: OwnedLease | undefined
    let remaining = NaN
    for (const candidate of input.leases) {
      const value = candidate.remainingMs()
      if (Number.isNaN(value)) return { lease: candidate, remaining: NaN }
      if (!lease || value < remaining) { lease = candidate; remaining = value }
    }
    return { lease, remaining }
  }
  const deadlineFailure = (lease: OwnedLease | undefined, reason: string) =>
    new Error(`The ${lease?.name ?? 'lease'} ${reason}`, { cause: lastFailure })
  const stopTimers = () => {
    stopped = true
    clearTimeout(timer)
    clearTimeout(deadline)
    input.signal.removeEventListener('abort', stopTimers)
  }
  const fail = (error: unknown, lease?: string) => {
    if (stopped || input.signal.aborted) return
    stopTimers()
    const failure = error instanceof Error ? error : new Error('Lease renewal failed.', { cause: error })
    if (lease === undefined) input.onFailure(failure, phase)
    else input.onFailure(failure, phase, lease)
  }
  const expired = () => {
    const { lease, remaining } = earliest()
    if (remaining > WORKER_CREDENTIAL_EXPIRY_MARGIN_MS) return false
    fail(deadlineFailure(lease, Number.isNaN(remaining)
      ? 'was lost by its owner.' : 'could not be renewed before its safety deadline.'), lease?.name)
    return true
  }
  const schedule = (backoffMs?: number) => {
    if (stopped || input.signal.aborted || expired()) return
    const { lease, remaining } = earliest()
    clearTimeout(deadline)
    // This deadline also stops the owner if a renewal hangs.
    const safeRemaining = Math.min(remaining - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS, 2_147_483_647)
    deadline = setTimeout(() => fail(deadlineFailure(lease, 'renewal timed out.'), lease?.name), safeRemaining)
    deadline.unref()
    const due = Math.min(...input.leases.map(item => item.remainingMs() - item.renewWithinMs))
    const waitMs = backoffMs ?? Math.min(20_000, Math.max(1_000, due))
    timer = setTimeout(tick, Math.min(waitMs, safeRemaining))
    timer.unref()
  }
  const tick = () => {
    if (stopped || input.signal.aborted || expired()) return
    let stalled = false
    running = (async () => {
      phase = 'check'
      current = undefined
      await input.check?.()
      for (const lease of input.leases) {
        if (stopped || input.signal.aborted) return
        const before = lease.remainingMs()
        if (before > lease.renewWithinMs) continue
        phase = 'refresh'
        current = lease.name
        await lease.renew()
        // A dependent lease that did not move (its source has not renewed yet) is retried with backoff.
        if (!(lease.remainingMs() > before)) stalled = true
      }
    })().then(() => {
      if (stopped || input.signal.aborted) return
      if (stalled) {
        schedule(retryMs)
        retryMs = Math.min(5_000, retryMs * 2)
        return
      }
      retryMs = 1_000
      lastFailure = undefined
      schedule()
    }, (error: unknown) => {
      lastFailure = error
      if (!isTransientRefreshFailure(error)) {
        fail(error, current)
        return
      }
      schedule(retryMs)
      retryMs = Math.min(5_000, retryMs * 2)
    }).finally(() => { running = undefined })
  }
  input.signal.addEventListener('abort', stopTimers, { once: true })
  if (input.signal.aborted) stopTimers()
  else schedule(0)
  return async () => {
    stopTimers()
    // Do not hold owner finalization forever behind a stalled renewal query.
    // Owner checks inside renew prevent a late completion reviving the lease.
    const pending = running
    if (pending) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([pending, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1_000) })]) }
      finally { clearTimeout(timeout) }
    }
  }
}
