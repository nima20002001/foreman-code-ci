import pg from 'pg'
import { DomainError } from '../modules/errors.js'
import { retryStartupDatabase } from './startupDatabase.js'
import { isDatabaseTimeout, retryDatabaseOperation } from './databaseTimeout.js'
import { withAbortSignal } from './abortSignal.js'
import { componentLogger } from './logger.js'

const ownershipRetryMs = 30_000
const ownershipCheckIntervalMs = 5_000
const ownershipCheckBudgetMs = 5_000
const ownershipLockKey = 710_014

interface RuntimeSession {
  pid: number
  /** Epoch microseconds retain PostgreSQL's precision when a PID is reused. */
  backend_start: string
}

function reportOwnershipCheckFailure(error: unknown): void {
  componentLogger('db').warn({ operation: 'check native runtime ownership', err: error },
    'Runtime ownership could not be checked; keeping the owner active and retrying.')
}

function isRuntimeDatabaseTimeout(error: unknown): error is DomainError {
  return error instanceof DomainError && error.code === 'NATIVE_RUNTIME_DATABASE_TIMEOUT'
}

/**
 * One API/native owner per database, with a separate pool checking its session lock.
 * Checks have a five-second budget and run five seconds after the previous check settles.
 * With responsive checks, loss is detected within 15 seconds: at most five for an in-flight
 * snapshot, five until the next check, and five for that check. Unavailable checks cannot prove loss.
 */
export class OperatorRuntimeOwner {
  private client: pg.Client
  private readonly checks: pg.Pool
  private readonly startup = new AbortController()
  private held = false
  private closing = false
  private loss: Error | undefined
  private acquisition: Promise<void> | undefined
  private closure: Promise<void> | undefined
  private ending: Promise<void> | undefined
  private backendSession: RuntimeSession | undefined
  private checkTimer: ReturnType<typeof setTimeout> | undefined
  private checkController: AbortController | undefined
  private checking: Promise<void> | undefined

  constructor(private readonly connectionString: string, private readonly onLost: (error: Error) => void) {
    this.client = this.createClient()
    this.checks = new pg.Pool({
      connectionString, max: 1, connectionTimeoutMillis: ownershipCheckBudgetMs,
      statement_timeout: ownershipCheckBudgetMs, query_timeout: ownershipCheckBudgetMs,
    })
    this.checks.on('error', reportOwnershipCheckFailure)
  }

  private createClient(): pg.Client {
    const client = new pg.Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 4_000,
      query_timeout: 6_000,
    })
    const lost = (error: Error) => {
      if (client === this.client) this.loseOwnership(error)
    }
    client.on('error', lost)
    client.on('end', () => lost(new Error('The native runtime ownership connection ended.')))
    return client
  }

  /** Passive authority for local telemetry; no lock acquisition or owner mutation. */
  get active(): boolean { return this.held && !this.closing && !this.loss }
  async readRuntimeEpoch(options: { signal?: AbortSignal | undefined } = {}): Promise<string> {
    const signal = options.signal ? AbortSignal.any([this.startup.signal, options.signal]) : this.startup.signal
    const assertActive = () => {
      if (!this.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner is not active.', 503)
    }
    // The advisory lock lasts for the session; an epoch read timeout does not release ownership.
    const result = await retryDatabaseOperation(() => withAbortSignal(() => this.queryWithDeadline<{ epoch: string }>(`
      select (extract(epoch from backend_start)*1000000)::bigint::text as epoch
      from pg_stat_activity where pid=pg_backend_pid()`), signal), isRuntimeDatabaseTimeout, {
      signal,
      check: assertActive,
      timeoutMs: ownershipRetryMs,
    })
    const row = result.rows[0]
    if (!this.active || !row?.epoch) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner epoch is unavailable.', 503)
    return row.epoch
  }

  acquire(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Native runtime ownership is closing.'))
    if (this.loss) return Promise.reject(this.loss)
    this.acquisition ??= Promise.resolve().then(() => retryStartupDatabase(async () => {
      if (this.ending) {
        await this.ending
        this.ending = undefined
        this.loss = undefined
        this.client = this.createClient()
      }
      try {
        await this.client.connect()
        if (this.closing) throw new Error('Native runtime ownership is closing.')
        const result = await this.query<RuntimeSession & { acquired: boolean }>(`
          select pg_try_advisory_lock($1) as acquired, pid,
            (extract(epoch from backend_start)*1000000)::bigint::text as backend_start
          from pg_stat_activity where pid=pg_backend_pid()`, [ownershipLockKey])
        if (!result.rows[0]?.acquired) {
          throw new DomainError('OPERATOR_API_ALREADY_OWNED', 'Another API process owns the native runtime for this database. Multi-instance native execution is not enabled.', 503)
        }
        if (this.loss) throw this.loss
        const session = result.rows[0]!
        this.backendSession = { pid: session.pid, backend_start: session.backend_start }
        this.held = true
        this.checkController = new AbortController()
        this.scheduleCheck()
      } catch (error) {
        // No protected work is admitted until acquisition succeeds.
        try { await this.end() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Native runtime ownership acquisition cleanup failed.', { cause: cleanupError })
        }
        throw error
      }
    }, { signal: this.startup.signal })).catch(error => {
      // A late lock result still belongs to close(), which waits before unlocking it.
      if (this.closing && this.held && this.startup.signal.aborted) return
      throw error
    })
    return this.acquisition
  }

  /** Call only AFTER successful protected cleanup, never in a cleanup finally block. */
  close(): Promise<void> {
    this.closing = true
    this.stopChecks()
    this.startup.abort(new Error('Native runtime ownership is closing.'))
    this.closure ??= Promise.resolve().then(async () => {
      // A shutdown during connect must not leave a late-acquired lock behind.
      if (!this.acquisition) {
        await this.checks.end()
        return
      }
      // The acquisition caller reports startup errors; release only waits for its connection cleanup.
      await this.acquisition.then(() => undefined, () => undefined)
      try {
        await this.checking
        if (this.held) await this.query('select pg_advisory_unlock($1)', [ownershipLockKey])
      } finally {
        this.held = false
        await Promise.all([this.end(), this.checks.end()])
      }
    })
    return this.closure
  }

  private end(): Promise<void> {
    this.ending ??= Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.client.end(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.destroySession()
            reject(new Error('The runtime ownership connection did not close within its deadline.'))
          }, 1_000)
        })])
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
    return this.ending
  }

  private destroySession(): void {
    const connection = (this.client as pg.Client & {
      connection?: { stream?: { destroy(): void } }
    }).connection
    connection?.stream?.destroy()
  }

  private loseOwnership(error: Error): void {
    if (this.ending || this.loss) return
    this.loss = error
    const held = this.held
    this.held = false
    this.stopChecks()
    if (held && !this.closing) this.onLost(error)
  }

  private stopChecks(): void {
    clearTimeout(this.checkTimer)
    this.checkTimer = undefined
    this.checkController?.abort(new Error('Runtime ownership checking is stopped.'))
  }

  private scheduleCheck(): void {
    const signal = this.checkController?.signal
    if (!this.active || !signal || signal.aborted) return
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined
      this.checking = this.checkOwnership(signal).finally(() => {
        this.checking = undefined
        this.scheduleCheck()
      })
    }, ownershipCheckIntervalMs)
    this.checkTimer.unref()
  }

  private async checkOwnership(signal: AbortSignal): Promise<void> {
    let owners: RuntimeSession[]
    try {
      owners = await this.readLockOwners(signal)
    } catch (error) {
      if (!signal.aborted) reportOwnershipCheckFailure(error)
      return
    }
    if (!this.active || signal.aborted) return
    const isOriginalSession = (owner: RuntimeSession) => owner.pid === this.backendSession?.pid
      && owner.backend_start === this.backendSession?.backend_start
    if (!owners.some(isOriginalSession) || owners.some(owner => !isOriginalSession(owner))) {
      this.loseOwnership(new DomainError('NATIVE_RUNTIME_UNAVAILABLE',
        'The original runtime session no longer owns the native runtime lock.', 503))
    }
  }

  private async readLockOwners(lifetime: AbortSignal): Promise<RuntimeSession[]> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([lifetime, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new Error('Runtime ownership check timed out.')), ownershipCheckBudgetMs)
    timer.unref()
    let client: pg.PoolClient | undefined
    let failed = true
    try {
      const acquired = await withAbortSignal(async () => {
        const connection = await this.checks.connect()
        if (signal.aborted) {
          connection.release(true)
          signal.throwIfAborted()
        }
        client = connection
        return connection
      }, signal)
      acquired.on('error', reportOwnershipCheckFailure)
      const result = await withAbortSignal(() => acquired.query<RuntimeSession>(`
        select locks.pid, (extract(epoch from activity.backend_start)*1000000)::bigint::text as backend_start
        from pg_locks locks join pg_stat_activity activity on activity.pid=locks.pid
        where locks.locktype='advisory' and locks.classid=0::oid and locks.objid=$1::oid
        and locks.objsubid=1 and locks.granted
        and locks.database=(select oid from pg_database where datname=current_database())`, [ownershipLockKey]), signal)
      failed = false
      return result.rows
    } finally {
      clearTimeout(timer)
      client?.removeListener('error', reportOwnershipCheckFailure)
      client?.release(failed || signal.aborted)
    }
  }

  private async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.queryWithDeadline<R>(text, values)
    } catch (error) {
      if (!isRuntimeDatabaseTimeout(error)) throw error
      // An unanswered lock request may have acquired ownership on the server.
      this.destroySession()
      await this.end()
      throw error
    }
  }

  private async queryWithDeadline<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const timeout = new DomainError('NATIVE_RUNTIME_DATABASE_TIMEOUT',
      'The runtime ownership database did not respond within its deadline.', 503)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout), 5_000)
      })
      return await Promise.race([this.client.query<R>(text, values), deadline])
    } catch (error) {
      if (error === timeout || isDatabaseTimeout(error)) {
        throw timeout
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
