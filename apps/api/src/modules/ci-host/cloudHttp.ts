import { AsyncLocalStorage } from 'node:async_hooks'
import { CircleAccountIdSchema, DEFAULT_CIRCLE_ACCOUNT_ID, type CiHostRun } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'
import { configuredCircleToken } from './circleCredentials.js'

export interface CloudRestOptions {
  fetch?: typeof fetch
  circleAccountId?: string
  circleToken?: () => Promise<string | null>
}
type Provider = 'github' | 'circleci'
interface TokenEntry {
  pending: Promise<string | null>
  expiresAt: number
  lastError: string | null
}
type TokenCache = Map<string, TokenEntry>
const TOKEN_RETRY_MS = 30_000
const log = componentLogger('jobs')
const deadlines = new AsyncLocalStorage<AbortSignal>()
const credentials = new WeakMap<HostCiPorts, TokenCache>()

export class CloudHttp {
  private readonly cache: TokenCache
  private readonly fetch: typeof fetch
  private readonly credentialKey: string
  private readonly responseTokens = new WeakMap<Response, string[]>()
  private observedTransport: CiHostRun['transport']
  private fallbackCount = 0

  get transport() { return this.observedTransport }

  constructor(private readonly ports: HostCiPorts, private readonly provider: Provider,
    private readonly options: CloudRestOptions = {}) {
    const accountId = CircleAccountIdSchema.parse(options.circleAccountId ?? DEFAULT_CIRCLE_ACCOUNT_ID)
    this.credentialKey = `${provider}:${provider === 'circleci' ? accountId : ''}`
    let cache = credentials.get(ports)
    if (!cache) {
      cache = new Map()
      credentials.set(ports, cache)
    }
    this.cache = cache
    this.fetch = options.fetch ?? globalThis.fetch
  }

  invalidate(): void {
    this.cache.delete(this.credentialKey)
  }

  /** The account adapter uses the same cached credential for CLI and REST. */
  async withCredential<T>(operation: (token: string | null) => Promise<T>): Promise<T> {
    return operation(await this.token())
  }

  private token() {
    let entry = this.cache.get(this.credentialKey)
    if (entry && entry.expiresAt <= Date.now()) {
      this.cache.delete(this.credentialKey)
      entry = undefined
    }
    if (!entry) {
      const next: TokenEntry = { pending: Promise.resolve(null), expiresAt: Infinity, lastError: null }
      next.pending = this.loadToken(next).then(token => {
        if (!token) next.expiresAt = Date.now() + TOKEN_RETRY_MS
        return token
      }, error => {
        if (this.cache.get(this.credentialKey) === next) this.cache.delete(this.credentialKey)
        throw error
      })
      this.cache.set(this.credentialKey, next)
      entry = next
    }
    return entry.pending
  }

  private async loadToken(entry: TokenEntry): Promise<string | null> {
    if (this.provider === 'circleci') {
      try {
        const token = await (this.options.circleToken
          ? this.options.circleToken() : configuredCircleToken(this.ports))
        if (!token) entry.lastError = `${this.label} REST credential resolution failed.`
        return token
      } catch {
        throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI credential configuration could not be read.', 503)
      }
    }
    try {
      const result = await this.ports.run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 15_000 })
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim()
    } catch {
      entry.lastError = `${this.label} REST credential resolution failed.`
      return null
    }
    entry.lastError = `${this.label} REST credential resolution failed.`
    return null
  }

  private observeTransport(token: string | null) {
    const previous = this.observedTransport?.source
    const lastError = token ? null : this.cache.get(this.credentialKey)?.lastError ?? null
    if (token) {
      this.observedTransport = { source: 'rest', reason: null, lastError: null, fallbackCount: this.fallbackCount }
      if (previous === 'cli') {
        log.info({ provider: this.provider, transport: this.observedTransport }, 'Cloud CI is using REST transport')
      }
      return
    }
    this.fallbackCount++
    const reason = lastError ?? 'REST token unavailable; using CLI credential resolution.'
    this.observedTransport = { source: 'cli', reason, lastError, fallbackCount: this.fallbackCount }
    if (previous !== 'cli') {
      log.warn({ provider: this.provider, transport: this.observedTransport }, 'Cloud CI is using CLI transport')
    }
  }

  private requestSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
    const signals = [AbortSignal.timeout(timeoutMs)]
    const deadline = deadlines.getStore()
    if (deadline) signals.push(deadline)
    if (callerSignal) signals.push(callerSignal)
    return AbortSignal.any(signals)
  }

  async request(path: string, options: {
    timeoutMs?: number; headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal
  } = {}) {
    const token = await this.token()
    const pending = this.cache.get(this.credentialKey)
    this.observeTransport(token)
    if (!token) return null
    const base = this.provider === 'github' ? 'https://api.github.com' : 'https://circleci.com'
    const signal = this.requestSignal(options.timeoutMs ?? 120_000, options.signal)
    const send = (value: string) => this.fetch(`${base}${path}`, {
      signal, redirect: 'manual', method: options.method ?? 'GET', ...(options.body === undefined ? {} : { body: options.body }),
      headers: {
        Authorization: `Bearer ${value}`, 'User-Agent': 'foreman-code',
        ...(this.provider === 'github' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    })
    const usedTokens = [token]
    try {
      let response = await send(token)
      if (response.status === 401) {
        await response.body?.cancel()
        // A concurrent rejected request must share the same credential refresh.
        if (this.cache.get(this.credentialKey) === pending) this.cache.delete(this.credentialKey)
        const refreshed = await this.token()
        this.observeTransport(refreshed)
        if (!refreshed) return null
        usedTokens.push(refreshed)
        response = await send(refreshed)
      }
      this.responseTokens.set(response, usedTokens)
      return response
    } catch (error) {
      if (error instanceof DomainError) throw error
      // Transport errors must not expose a token, signed URL, or credential-file path.
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} HTTPS request failed.`, 502, undefined,
        { cause: new Error('Cloud CI HTTPS transport failed.') })
    }
  }

  async operation<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    try {
      return await deadlines.run(AbortSignal.timeout(timeoutMs), operation)
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} HTTPS request failed.`, 502, undefined,
        { cause: new Error('Cloud CI HTTPS transport failed.') })
    }
  }

  async json<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T
    } catch {
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} returned an invalid response.`, 502)
    }
  }

  async available() {
    const token = await this.token()
    this.observeTransport(token)
    return token !== null
  }

  get label() { return this.provider === 'github' ? 'GitHub Actions' : 'CircleCI' }

  async check(response: Response, message: (detail: string) => string): Promise<void> {
    if (response.ok || response.status === 304) return
    const text = await response.text()
    if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
      || /rate limit|too many requests/i.test(text)) {
      throw new DomainError('CI_CLOUD_RATE_LIMITED', `${this.label} rate limit reached; polling paused.`, 503)
    }
    let detail = response.statusText
    try {
      const body = JSON.parse(text) as { message?: unknown }
      if (typeof body.message === 'string') detail = body.message
    } catch {
      // ignore: non-JSON error bodies use the HTTP status description.
    }
    const tokens = this.responseTokens.get(response) ?? [await this.token()]
    for (const token of tokens) {
      if (token) detail = detail.split(token).join('[redacted]')
    }
    if (this.provider === 'github') detail = `gh: ${detail} (HTTP ${response.status})`
    throw new DomainError('CI_CLOUD_FAILED', message(detail.trim().slice(0, 300)), 502)
  }

  async download(response: Response, timeoutMs: number): Promise<Buffer> {
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      return this.downloadUrl(location, timeoutMs)
    }
    await this.check(response, () => `${this.label} artifacts could not be downloaded.`)
    return Buffer.from(await response.arrayBuffer())
  }

  async downloadUrl(url: string, timeoutMs: number, callerSignal?: AbortSignal): Promise<Buffer> {
    // Signed artifact/log URLs must never receive API credentials, including across redirects.
    try {
      const signal = this.requestSignal(timeoutMs, callerSignal)
      const response = await this.fetch(url, { signal })
      await this.check(response, () => `${this.label} artifacts could not be downloaded.`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} artifacts could not be downloaded.`, 502, undefined,
        { cause: new Error('Cloud CI artifact transport failed.') })
    }
  }
}
