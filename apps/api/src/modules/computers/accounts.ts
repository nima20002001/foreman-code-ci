import type pg from 'pg'
import type { DeviceRequestPriority } from '@foreman-code/contracts/device-application'
import { COMPUTER_ACCOUNTS_NAMESPACE, ComputerAccountsListSchema, ComputerAccountsReadInputSchema, ComputerAccountsSchema,
  type ComputerAccounts, type ComputerAccountsList } from '@foreman-code/contracts/computer-accounts'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { probeComputerAccounts } from './accountProbe.js'
import { assertComputerTarget } from './target.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

export interface ComputerAccountsEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number; priority?: DeviceRequestPriority }): Promise<{ payload: unknown }>
}
const CACHE_MS = 30_000

/** Which harness and GitHub accounts each paired computer is signed in to. Identity strings only. */
export class ComputerAccountsService {
  private readonly cache = new Map<string, { at: number; pending: boolean; value: Promise<ComputerAccounts | null> }>()
  private readonly refreshRequired = new Set<string>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly probeMain: (refresh?: boolean) => Promise<ComputerAccounts> = refresh =>
      probeComputerAccounts(undefined, undefined, { refresh: refresh === true }),
    private readonly now: () => number = Date.now,
  ) {}

  async list(principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http', refresh = false,
    cursor?: string): Promise<ComputerAccountsList> {
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computer_accounts_list', this.mainId)
      throw error
    }
    const sql = await this.pool.connect()
    let targets: DeviceProvisioningTarget[]
    let nextCursor: string | null = null
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:read')
      const rows = await sql.query<{ record: unknown }>(`select record from device_registrations
        where main_id=$1 and record->>'status'='paired' and ($2::uuid is null or id>$2::uuid)
        order by id limit 101`, [this.mainId, cursor ?? null])
      const registrations = rows.rows.map(row => DeviceRegistrationSchema.parse(row.record))
      const page = registrations.slice(0, 100)
      if (registrations.length > page.length) nextCursor = page.at(-1)!.deviceId
      targets = cursor ? [] : [{ hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
        keyRevision: null, authorizationRevision: null }]
      targets.push(...page.map(registration => {
        return { hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
          applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
          authorizationRevision: registration.authorizationRevision }
      }))
    } finally { sql.release() }
    const computers = await Promise.all(targets.map(async target => ({ target, accounts: await this.read(target, refresh) })))
    return ComputerAccountsListSchema.parse({ computers, nextCursor })
  }

  invalidate(target: DeviceProvisioningTarget): void {
    const key = `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}`
    this.cache.delete(key)
    this.refreshRequired.add(key)
  }

  async readTarget(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerAccountsList> {
    const input = ComputerAccountsReadInputSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computer_accounts_list', this.mainId)
      throw error
    }
    const sql = await this.pool.connect()
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:read')
      await assertComputerTarget(sql, this.mainId, input.target)
    } finally { sql.release() }
    return ComputerAccountsListSchema.parse({
      computers: [{ target: input.target, accounts: await this.read(input.target, input.refresh === true) }],
      nextCursor: null,
    })
  }

  /** Cached probe without authorization; callers must authorize first. */
  read(target: DeviceProvisioningTarget, refresh: boolean): Promise<ComputerAccounts | null> {
    const key = `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}`
    refresh ||= this.refreshRequired.has(key)
    const cached = this.cache.get(key)
    if (cached && (cached.pending || (!refresh && this.now() - cached.at < CACHE_MS))) return cached.value
    this.refreshRequired.delete(key)
    const probe = target.hostRef.kind === 'main'
      ? this.probeMain(refresh) : this.readDevice(target.hostRef.deviceId, refresh)
    const value: Promise<ComputerAccounts | null> = probe.catch(error => {
      if (this.cache.get(key) === entry) this.cache.delete(key)
      logIgnoredError('lifecycle', 'read computer accounts', error, { host: target.hostRef })
      return null
    })
    const entry = { at: this.now(), pending: true, value }
    this.cache.set(key, entry)
    void value.then(() => {
      entry.pending = false
      entry.at = this.now()
    }, () => {
      if (this.cache.get(key) === entry) this.cache.delete(key)
    })
    return value
  }

  private async readDevice(deviceId: string, refresh: boolean): Promise<ComputerAccounts | null> {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_ACCOUNTS_NAMESPACE && value.mainCanRequest)) return null
    const reply = await endpoint.request(deviceId, COMPUTER_ACCOUNTS_NAMESPACE,
      { operation: 'read', ...(refresh ? { refresh: true } : {}) },
      { signal: AbortSignal.timeout(25_000) })
    return ComputerAccountsSchema.parse(reply.payload)
  }
}
