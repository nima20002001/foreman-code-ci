import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { appLauncherPath, registerAppRouteDigest, type AppMcpRouteRegistration } from './appMcpLauncher.js'
import { withAbortSignal } from '../../infrastructure/abortSignal.js'
import { DomainError } from '../errors.js'

interface RuntimeRouteOwner {
  readonly active: boolean
  readRuntimeEpoch(options?: { signal?: AbortSignal | undefined }): Promise<string>
}

interface RouteRefresh {
  controller: AbortController
  promise: Promise<void>
  requested: number
  waiters: number
  finished: boolean
}

/** Operator and Worker credentials follow their owning database across restarts, port changes and lease renewals. */
export class AppMcpRoutes {
  private readonly registered = new Map<string, AppMcpRouteRegistration>()
  private readonly runtimeEpoch = randomUUID()
  private pending: RouteRefresh | undefined
  private closing = false

  constructor(
    private readonly pool: pg.Pool, private readonly endpoint: string, private readonly launcher = appLauncherPath(),
    private readonly owner?: () => RuntimeRouteOwner,
  ) {}

  async refresh(options: { signal?: AbortSignal | undefined } = {}): Promise<void> {
    options.signal?.throwIfAborted()
    if (this.closing) throw new Error('MCP route publication is closing.')
    const operation = this.pending ?? this.startRefresh()
    operation.requested += 1
    operation.waiters += 1
    const signal = options.signal
      ? AbortSignal.any([operation.controller.signal, options.signal]) : operation.controller.signal
    try {
      await withAbortSignal(() => operation.promise, signal)
    } finally {
      operation.waiters -= 1
      if (!operation.waiters && !operation.finished) {
        operation.controller.abort(signal.reason ?? new Error('MCP route refresh has no waiting callers.'))
      }
    }
  }

  private startRefresh(): RouteRefresh {
    const operation: RouteRefresh = {
      controller: new AbortController(), promise: Promise.resolve(), requested: 0, waiters: 0, finished: false,
    }
    this.pending = operation
    const timer = setTimeout(() => operation.controller.abort(new DomainError('APP_MCP_REFRESH_TIMEOUT',
      'MCP route refresh did not complete within its deadline.', 503, { retryable: true })), 30_000)
    timer.unref()
    operation.promise = withAbortSignal(() => this.refreshRoutes(operation), operation.controller.signal).finally(() => {
      clearTimeout(timer)
      operation.finished = true
      if (this.pending === operation) this.pending = undefined
    })
    return operation
  }

  private assertActive(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.closing || this.owner && !this.owner().active) {
      throw new Error('The MCP route runtime owner is no longer active.')
    }
  }

  private async refreshRoutes(operation: RouteRefresh): Promise<void> {
    const signal = operation.controller.signal
    this.assertActive(signal)
    const owner = this.owner?.()
    const runtimeEpoch = owner
      ? await withAbortSignal(() => owner.readRuntimeEpoch({ signal }), signal) : this.runtimeEpoch
    for (;;) {
      const revision = operation.requested
      await this.refreshCredentials(runtimeEpoch, signal)
      if (revision === operation.requested) break
    }
    // A later caller needs a fresh snapshot even before this promise's finalizers run.
    if (this.pending === operation) this.pending = undefined
  }

  private async refreshCredentials(runtimeEpoch: string, signal: AbortSignal): Promise<void> {
    this.assertActive(signal)
    // Delegated Operator chat credentials register their own route for the conversation lifetime.
    const result = await withAbortSignal(() => this.pool.query<{ token_hash: string; expires_at: Date }>(`select token_hash, expires_at
      from management_principals where audience='operator' and delegated_from is null
      and token_hash is not null and revoked_at is null and expires_at>now()
      union all
      select p.token_hash, p.expires_at
      from management_principals p join worker_credential_bindings b on b.principal_id=p.id where p.audience='worker'
      and p.revoked_at is null and b.revoked_at is null and p.expires_at>now()`), signal)
    this.assertActive(signal)
    const current = new Set(result.rows.map(row => row.token_hash))
    for (const [digest, remove] of this.registered) {
      if (!current.has(digest)) {
        this.registered.delete(digest)
        await withAbortSignal(remove, signal)
      }
    }
    for (const row of result.rows) {
      this.assertActive(signal)
      const existing = this.registered.get(row.token_hash)
      if (existing) await withAbortSignal(() => existing.refresh(row.expires_at.toISOString(), signal), signal)
      else {
        await withAbortSignal(() => this.registerRoute(row, runtimeEpoch, signal), signal)
      }
    }
  }

  private async registerRoute(
    row: { token_hash: string; expires_at: Date }, runtimeEpoch: string, signal: AbortSignal,
  ): Promise<void> {
    const registration = await registerAppRouteDigest(row.token_hash, this.endpoint,
      row.expires_at.toISOString(), this.launcher, { runtimeEpoch, assertActive: () => this.assertActive() }, { signal })
    if (signal.aborted) {
      await registration()
      signal.throwIfAborted()
    }
    this.registered.set(row.token_hash, registration)
  }

  stopAdmission(): void {
    this.closing = true
    this.pending?.controller.abort(new Error('MCP route publication is closing.'))
  }

  async close(): Promise<void> {
    this.stopAdmission()
    // Each refresh caller receives its failure; shutdown still removes published routes.
    await this.pending?.promise.then(() => undefined, () => undefined)
    await Promise.all([...this.registered.values()].map(remove => remove()))
    this.registered.clear()
  }
}
