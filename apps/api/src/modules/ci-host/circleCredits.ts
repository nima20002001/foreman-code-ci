import { gunzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import type { CircleCredits } from '@foreman-code/contracts'
import type { CircleCreditAllowance } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { CloudHttp } from './cloudHttp.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart, type CircleCreditState } from './circleCreditCache.js'
import { withoutCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'

const log = componentLogger('jobs')
const REFRESH_MS = 3 * 60 * 60_000
const POLL_MS = 6_000
const EXPORT_WAIT_MS = 120_000
const SHUTDOWN_GRACE_MS = 5_000
const MAX_AGE_MS = 4 * 60 * 60_000
const DAILY_EXPORT_LIMIT = 10

export interface CircleCreditsReading { credits: CircleCredits | null; creditsUnavailable?: string }
export interface CircleCreditsReader {
  reading(owner?: string, circleAccountId?: string): Promise<CircleCreditsReading>
  close?(): Promise<void>
}
type UsageHttp = Pick<CloudHttp, 'request' | 'check' | 'json' | 'downloadUrl'>
type HttpSource = UsageHttp | ((circleAccountId: string) => UsageHttp | Promise<UsageHttp>)

/** Sums compute separately from storage and other charges in a usage export (RFC 4180 quoting). */
export function sumComputeCredits(csv: string): number {
  let column = -1
  let total = 0
  let row = 0
  let field = 0
  let value = ''
  let quoted = false
  const endField = () => {
    if (row === 0) { if (value.trim().toLowerCase() === 'compute_credits') column = field }
    else if (field === column) { const credits = Number(value); if (Number.isFinite(credits)) total += credits }
    value = ''
    field++
  }
  const endRow = () => {
    endField()
    if (row === 0 && column === -1) {
      throw new DomainError('CI_CLOUD_FAILED', 'CircleCI usage export has no compute_credits column.', 502)
    }
    row++
    field = 0
  }
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]!
    if (quoted) {
      if (char !== '"') value += char
      else if (csv[index + 1] === '"') { value += '"'; index++ }
      else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') endField()
    else if (char === '\n') endRow()
    else if (char !== '\r') value += char
  }
  if (value !== '' || field > 0) endRow()
  return total
}

/** Org usage is sampled at most every three hours; all readers share the persisted export and attempt budget. */
export class CircleCreditUsage implements CircleCreditsReader {
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly shutdown = new AbortController()
  private closed = false
  private readonly cache: CircleCreditCache
  private readonly now: () => number
  private readonly pollMs: number
  private readonly waitMs: number

  constructor(private readonly http: HttpSource, private readonly source: {
    allowance(): Promise<CircleCreditAllowance>
    primaryOwner(): Promise<string | null>
  }, options: { now?: () => number; pollMs?: number; waitMs?: number; cache?: CircleCreditCache } = {}) {
    this.now = options.now ?? Date.now
    this.pollMs = Math.max(POLL_MS, options.pollMs ?? POLL_MS)
    this.waitMs = options.waitMs ?? EXPORT_WAIT_MS
    this.cache = options.cache ?? new CircleCreditCache()
  }

  async close(): Promise<void> {
    this.closed = true
    const timer = setTimeout(() => {
      this.shutdown.abort(new Error('CircleCI usage shutdown deadline reached.'))
    }, SHUTDOWN_GRACE_MS)
    try {
      await Promise.all(this.refreshing.values())
    } finally {
      clearTimeout(timer)
    }
  }

  async reading(account?: string, circleAccountId = 'default'): Promise<CircleCreditsReading> {
    const owner = (account ?? await this.source.primaryOwner())?.toLowerCase()
    if (!owner) return { credits: null, creditsUnavailable: 'The CircleCI organization of the CI mirror is not known.' }
    const key = circleCreditKey(owner, circleAccountId)
    const state = await this.cache.transaction(states => structuredClone(states[key] ?? { attempts: [] }))
    const due = state.job ? this.now() >= (state.nextPollAt ?? 0)
      : this.now() - (state.lastAttemptAt ?? -Infinity) >= REFRESH_MS
    if (!this.closed && due && this.now() >= (state.retryAt ?? 0) && !this.refreshing.has(key)) {
      const task = withoutCiDatabasePriority(() => this.refresh(key, owner, circleAccountId)).catch(() => {
        log.warn({ operation: 'read CircleCI credits', circleAccountId, owner }, 'CircleCI usage cache could not be read')
      }).finally(() => { this.refreshing.delete(key) })
      this.refreshing.set(key, task)
    }
    const snapshot = state.snapshot
    const fresh = snapshot?.basis === 'compute' && this.now() - Date.parse(snapshot.windowEnd) <= MAX_AGE_MS
      && snapshot.periodStart === circleMonthStart(this.now())
    if (!fresh) return { credits: null, creditsUnavailable: state.failure ?? 'Credits are still being read.' }
    const allowance = await this.source.allowance()
    const total = Object.entries(allowance.accounts).find(([name]) => name.toLowerCase() === owner)?.[1]
      ?? allowance.defaultMonthlyCredits
    return { credits: { total, used: snapshot.used, remaining: Math.max(0, total - snapshot.used), asOf: snapshot.asOf } }
  }

  private async refresh(key: string, owner: string, circleAccountId: string) {
    const now = this.now()
    const claimed = await this.cache.transaction(states => {
      const state = states[key] ??= { attempts: [] }
      if ((state.refreshingUntil ?? 0) > now || now < (state.retryAt ?? 0)) return false
      const due = state.job ? now >= (state.nextPollAt ?? 0) : now - (state.lastAttemptAt ?? -Infinity) >= REFRESH_MS
      if (!due) return false
      state.refreshingUntil = now + this.waitMs + 2 * 60_000
      return true
    })
    if (!claimed) return
    try {
      this.shutdown.signal.throwIfAborted()
      const http = typeof this.http === 'function' ? await this.http(circleAccountId) : this.http
      if (circleAccountId !== 'default' && typeof this.http !== 'function') {
        throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'This CircleCI login is not configured.', 503)
      }
      const state = await this.cache.transaction(states => structuredClone(states[key]!))
      const orgId = state.orgId ?? await this.organizationId(http, owner)
      await this.cache.transaction(states => { states[key]!.orgId = orgId })
      const job = state.job ?? await this.createExport(http, key, orgId)
      if (!job) return
      const urls = await this.waitForExport(http, key, orgId, job.id)
      if (!urls) return
      let used = 0
      for (const url of urls) {
        this.shutdown.signal.throwIfAborted()
        const file = await http.downloadUrl(url, 120_000, this.shutdown.signal)
        used += sumComputeCredits((file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file).toString('utf8'))
      }
      await this.cache.transaction(states => {
        const current = states[key]!
        delete current.job
        delete current.failure
        delete current.retryAt
        // Old jobs may drain after midnight, but can never become a new month's balance.
        if (job.periodStart === circleMonthStart(this.now())) current.snapshot = {
          used: Math.round(used), asOf: new Date(this.now()).toISOString(),
          periodStart: job.periodStart, windowEnd: job.windowEnd, basis: 'compute',
        }
      })
    } catch (error) {
      // Shutdown retains the saved export and provider retry schedule for the next reader.
      if (this.shutdown.signal.aborted) return
      const message = error instanceof DomainError ? error.message : 'CircleCI usage could not be read.'
      await this.cache.transaction(states => {
        const state = states[key]!
        state.failure = message.slice(0, 300)
        const retryAt = error instanceof DomainError ? error.details?.retryAt : undefined
        state.retryAt = typeof retryAt === 'number' ? retryAt
          : this.now() + (state.job ? POLL_MS : 10 * 60_000)
      })
      log.warn({ operation: 'read CircleCI credits', circleAccountId, owner }, 'CircleCI credit usage could not be read')
    } finally {
      await this.cache.transaction(states => { delete states[key]!.refreshingUntil })
    }
  }

  private async call(http: UsageHttp, path: string, what: string, options: { method?: string; body?: string } = {}) {
    this.shutdown.signal.throwIfAborted()
    const response = await http.request(path, { timeoutMs: 60_000, signal: this.shutdown.signal, ...options })
    if (!response) throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI is not logged in on Main.', 503)
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter === null ? NaN : Number(retryAfter)
      const at = Number.isFinite(seconds) ? this.now() + seconds * 1000 : Date.parse(retryAfter ?? '')
      const retryAt = Number.isFinite(at) ? Math.max(this.now() + POLL_MS, at) : this.now() + POLL_MS
      throw new DomainError('CI_CLOUD_RATE_LIMITED', 'CircleCI usage is rate limited; the cached reading is retained.',
        503, { retryAt })
    }
    await http.check(response, detail => `CircleCI did not accept ${what}: ${detail}`)
    return response
  }

  private async organizationId(http: UsageHttp, owner: string) {
    const response = await this.call(http, '/api/v2/me/collaborations', 'the organization lookup')
    const orgs = await http.json<{ id: string; name?: string; slug?: string; vcs_type?: string }[]>(response)
    const match = orgs.find(org => org.vcs_type !== 'bitbucket'
      && (org.name?.toLowerCase() === owner || org.slug?.toLowerCase() === `gh/${owner}`))
    if (!match) throw new DomainError('CI_CLOUD_FAILED', `CircleCI organization ${owner} is not visible to this login.`, 502)
    return match.id
  }

  private async createExport(http: UsageHttp, key: string, orgId: string): Promise<CircleCreditState['job']> {
    const now = this.now()
    const reserved = await this.cache.transaction(states => {
      const state = states[key]!
      state.attempts = state.attempts.filter(at => new Date(at).toISOString().slice(0, 10)
        === new Date(now).toISOString().slice(0, 10))
      if (state.attempts.length >= DAILY_EXPORT_LIMIT || now - (state.lastAttemptAt ?? -Infinity) < REFRESH_MS) return false
      // Reserve before POST, including failures or a process crash after transmission.
      state.lastAttemptAt = now
      state.attempts.push(now)
      return true
    })
    if (!reserved) return undefined
    const periodStart = circleMonthStart(now)
    const windowEnd = new Date(now).toISOString()
    const response = await this.call(http, `/api/v2/organizations/${encodeURIComponent(orgId)}/usage_export_job`,
      'the usage export', { method: 'POST', body: JSON.stringify({ start: periodStart, end: windowEnd }) })
    const result = await http.json<{ usage_export_job_id: string }>(response)
    if (!result.usage_export_job_id) throw new DomainError('CI_CLOUD_FAILED', 'CircleCI returned an invalid usage export.', 502)
    const job = { id: result.usage_export_job_id, periodStart, windowEnd }
    await this.cache.transaction(states => { states[key]!.job = job })
    return job
  }

  private async waitForExport(http: UsageHttp, key: string, orgId: string, jobId: string): Promise<string[] | null> {
    const deadline = Date.now() + this.waitMs
    for (;;) {
      this.shutdown.signal.throwIfAborted()
      const now = this.now()
      const canPoll = await this.cache.transaction(states => {
        const state = states[key]!
        if (now < (state.nextPollAt ?? 0)) return false
        state.nextPollAt = now + this.pollMs
        return true
      })
      if (!canPoll) return null
      const response = await this.call(http,
        `/api/v2/organizations/${encodeURIComponent(orgId)}/usage_export_job/${encodeURIComponent(jobId)}`, 'the usage export read')
      const job = await http.json<{ state: string; download_urls?: string[] | null }>(response)
      if (job.state === 'completed') {
        if (!job.download_urls?.length) throw new DomainError('CI_CLOUD_FAILED', 'CircleCI usage export contained no downloads.', 502)
        return job.download_urls
      }
      if (job.state === 'failed') {
        await this.cache.transaction(states => { delete states[key]!.job })
        throw new DomainError('CI_CLOUD_FAILED', 'CircleCI usage export failed.', 502)
      }
      if (Date.now() + this.pollMs > deadline) return null
      await delay(this.pollMs, undefined, { signal: this.shutdown.signal })
    }
  }
}
