import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HarnessCompatibilitySchema, type CompatibilityHarness, type HarnessCompatibility,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { isAuthorized, requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { FileCompatibilityCache, type CompatibilityCache, type CompatibilityCacheEntry } from './cache.js'
import { CompatibilityCheckError, compatibilityReason } from './errors.js'
import { nativeCompatibilityProbe, type CompatibilityProbe, type HarnessInstallation } from './probe.js'

const COMPATIBILITY_CHECKER_REVISION = 'runtime-contracts-v2'
const HARNESSES = ['codex'] as const
const CACHE_WARNING = 'This result is available now, but the compatibility cache could not be read or saved. A later startup may repeat the check.'
export interface CompatibilityOptions {
  probe: CompatibilityProbe
  commands?: Pick<PostgresCommandCoordinator, 'recordAudit'>
  cache: CompatibilityCache
  now?: () => number
  checkerRevision?: string
  timeoutMs?: number
}
export function compatibilityCacheKey(harness: CompatibilityHarness, installation: HarnessInstallation, revision: string): string {
  return createHash('sha256').update(JSON.stringify([
    harness, installation.identity, installation.installationFingerprint ?? null, installation.version, process.platform, process.arch,
    process.version, revision,
  ])).digest('hex')
}
async function cacheOperation<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cache I/O deadline exceeded.')), 200)
    })])
  } finally { clearTimeout(timer) }
}

/**
 * Diagnostics are deliberately not an admission/authorization dependency.
 * Reads return immediately. At most one owned diagnostic per harness is active.
 */
export class HarnessCompatibilityService {
  private readonly reports: Record<CompatibilityHarness, HarnessCompatibility>
  private readonly flights = new Map<CompatibilityHarness, Promise<void>>()
  private readonly cleanupBlocked = new Set<CompatibilityHarness>()
  private readonly refreshPending = new Set<CompatibilityHarness>()
  private readonly retryTimers = new Map<CompatibilityHarness, NodeJS.Timeout>()
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private readonly revision: string
  private readonly timeoutMs: number
  constructor(private readonly options: CompatibilityOptions) {
    this.now = options.now ?? Date.now
    this.revision = options.checkerRevision ?? COMPATIBILITY_CHECKER_REVISION
    this.timeoutMs = options.timeoutMs ?? 6000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new RangeError('Invalid compatibility deadline.')
    this.reports = { codex: this.initial('codex') }
  }
  private initial(harness: CompatibilityHarness): HarnessCompatibility {
    return {
      harness, checkId: randomUUID(), installedVersion: null, status: 'not-checked',
      checkedAt: null, source: 'none', checkerRevision: this.revision,
      reason: null, schemaSha256: null,
      cacheWarning: null, scope: 'protocol-settings-diagnostic-only',
    }
  }
  list(): HarnessCompatibility[] { return HARNESSES.map((harness) => this.get(harness)) }
  get(harness: CompatibilityHarness): HarnessCompatibility {
    // Contract parsing also prevents callers from mutating the in-memory report.
    return HarnessCompatibilitySchema.parse(this.reports[harness])
  }
  read(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'harnesses:read')
    return { harnesses: this.list(), canRetry: isAuthorized(principal, 'harnesses:update') }
  }
  async requestRetry(principal: ManagementPrincipal, source: 'http' | 'mcp', harness: CompatibilityHarness) {
    requireAuthorization(principal, 'harnesses:update')
    const result = this.retry(harness)
    await this.options.commands?.recordAudit(principal.id, source, 'harness.compatibility.retry', harness, 'succeeded')
    return result
  }
  start(): void {
    for (const harness of HARNESSES) this.begin(harness, false)
  }
  retry(harness: CompatibilityHarness): HarnessCompatibility {
    this.begin(harness, true)
    return this.get(harness)
  }
  refreshAfterQualification(harness: CompatibilityHarness): void {
    if (this.lifetime.signal.aborted || this.cleanupBlocked.has(harness)) return
    if (this.flights.has(harness)) this.refreshPending.add(harness)
    else this.begin(harness, true)
  }
  async checkAll(): Promise<HarnessCompatibility[]> {
    this.start()
    await Promise.all(this.flights.values())
    return this.list()
  }
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Compatibility checks are stopping.'))
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    await Promise.allSettled(this.flights.values())
    await this.options.probe.close?.()
  }
  private begin(harness: CompatibilityHarness, force: boolean): void {
    if (this.lifetime.signal.aborted) throw new Error('Compatibility service is closed.')
    if (this.flights.has(harness) || this.cleanupBlocked.has(harness)) return
    clearTimeout(this.retryTimers.get(harness))
    this.retryTimers.delete(harness)
    this.reports[harness] = {
      ...this.initial(harness), status: 'checking',
      installedVersion: this.reports[harness].installedVersion,
      checkedAt: this.reports[harness].checkedAt,
    }
    const checkId = this.reports[harness].checkId
    // Publish the flight before invoking any dependency, including synchronous test doubles.
    const task = Promise.resolve().then(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const deadline = attempt === 1 ? this.timeoutMs : Math.min(30_000, this.timeoutMs * 3)
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(deadline)])
        await this.check(harness, checkId, force, signal, attempt)
        if (this.reports[harness].reason?.code !== 'CHECK_TIMEOUT' || attempt === 2 || this.lifetime.signal.aborted
          || this.cleanupBlocked.has(harness)) return
        this.reports[harness] = { ...this.reports[harness], status: 'checking', reason: null }
        await delay(250, undefined, { signal: this.lifetime.signal })
      }
    })
      .catch((error: unknown) => {
        this.reports[harness] = {
          ...this.reports[harness], status: 'unavailable', checkedAt: new Date(this.now()).toISOString(),
          reason: compatibilityReason(error, this.lifetime.signal.aborted), source: 'none',
        }
      }).finally(() => {
        this.flights.delete(harness)
        if (this.refreshPending.delete(harness) && !this.lifetime.signal.aborted) this.begin(harness, true)
        else if (this.reports[harness].reason?.code === 'CHECK_TIMEOUT'
          && !this.lifetime.signal.aborted && !this.cleanupBlocked.has(harness)) {
          const timer = setTimeout(() => {
            this.retryTimers.delete(harness)
            this.begin(harness, true)
          }, 30_000)
          timer.unref()
          this.retryTimers.set(harness, timer)
        }
      })
    this.flights.set(harness, task)
  }
  private async check(harness: CompatibilityHarness, checkId: string, force: boolean, signal: AbortSignal, attempt: number): Promise<void> {
    let installation: HarnessInstallation | undefined
    let warning: string | null = null
    try {
      installation = await this.options.probe.inspect(harness, signal, attempt)
      signal.throwIfAborted()
      const base: HarnessCompatibility = {
        ...this.initial(harness), checkId, installedVersion: installation.version,
      }
      this.reports[harness] = { ...base, status: 'checking' }
      const key = compatibilityCacheKey(harness, installation, this.revision)
      let cached: CompatibilityCacheEntry | null = null
      if (!force) {
        try { cached = await cacheOperation(this.options.cache.load(harness, key, this.now())) }
        catch { warning = CACHE_WARNING }
      }
      signal.throwIfAborted()
      if (cached && cached.installedVersion === installation.version) {
        await this.options.probe.assertUnchanged(installation, signal)
        signal.throwIfAborted()
        this.reports[harness] = {
          ...base, status: cached.status, source: 'cache', checkedAt: cached.checkedAt,
          schemaSha256: cached.schemaSha256, reason: cached.reason, cacheWarning: warning,
        }
        return
      }
      let status: 'probe-passed' | 'probe-failed' = 'probe-passed'
      let reason: HarnessCompatibility['reason'] = null
      let schemaSha256: string | null = null
      try { schemaSha256 = await this.options.probe.probe(harness, installation, signal) }
      catch (error) { status = 'probe-failed'; reason = compatibilityReason(error, signal.aborted) }
      if (reason?.code === 'CLI_CLEANUP_FAILED') {
        this.cleanupBlocked.add(harness)
        throw new CompatibilityCheckError('CLI_CLEANUP_FAILED',
          'The diagnostic process did not confirm clean shutdown. Stop that process and restart the API before another check.')
      }
      if (reason?.code === 'CHECK_TIMEOUT') throw new CompatibilityCheckError('CHECK_TIMEOUT', reason.message)
      // Never cache a result for a replaced binary or an interrupted check.
      signal.throwIfAborted()
      await this.options.probe.assertUnchanged(installation, signal)
      signal.throwIfAborted()
      const checked = this.now()
      const checkedAt = new Date(checked).toISOString()
      const entry: CompatibilityCacheEntry = {
        format: 2, harness, installedVersion: installation.version, key, checkedAt, status, reason, schemaSha256,
        expiresAt: new Date(checked + (status === 'probe-passed' ? 7 * 86_400_000 : 60_000)).toISOString(),
      }
      try { await cacheOperation(this.options.cache.save(entry)) }
      catch { warning = CACHE_WARNING }
      signal.throwIfAborted()
      this.reports[harness] = {
        ...base, status, checkedAt, reason, schemaSha256, source: 'local-probe', cacheWarning: warning,
      }
    } catch (error) {
      if (error instanceof CompatibilityCheckError && error.code === 'CLI_CLEANUP_FAILED') this.cleanupBlocked.add(harness)
      this.reports[harness] = {
        ...this.initial(harness), checkId, installedVersion: installation?.version ?? null,
        status: compatibilityReason(error, signal.aborted).code === 'CHECK_TIMEOUT' ? 'unavailable'
          : installation ? 'probe-failed' : 'unavailable', checkedAt: new Date(this.now()).toISOString(),
        reason: compatibilityReason(error, signal.aborted), cacheWarning: warning,
      }
    }
  }
}
export function createHarnessCompatibility(config: { codexBinary: string; workspaceRoot: string }): HarnessCompatibilityService {
  return new HarnessCompatibilityService({
    probe: nativeCompatibilityProbe({ codex: config.codexBinary }, config.workspaceRoot),
    cache: new FileCompatibilityCache(),
  })
}
