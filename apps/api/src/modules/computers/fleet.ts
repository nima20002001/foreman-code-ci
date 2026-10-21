import { errorMessage } from '../../shared/errorMessage.js'
import type { ReadObservation } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { failedReadObservation, successfulReadObservation } from '../diagnostics/readObservation.js'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, WORKER_UPDATE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceReadInputSchema,
  ComputerMaintenanceStartInputSchema, SyncedMarketplaceSchema,
  ComputerMaintenanceStartResultSchema, ComputerMaintenanceDispatchSchema, MaintenanceReplySchema, SyncedMcpServerSchema,
  type ComputerConnections, type ComputerMaintenanceList, type ComputerMaintenanceStartInput, type ComputerMaintenanceStartResult,
  type MaintenanceStatus, type MaintenanceTask, type MaintenanceTaskStart, type SyncedMarketplace, type SyncedMcpServer,
  type WorkerReleasePublication,
  type WorkerBundleReadiness,
  type SyncedPlugin,
} from '@foreman-code/contracts/computer-maintenance'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ClaudePluginCatalog } from './claudePlugins.js'
import type { ComputerMaintenance } from './maintenance.js'
import { syncFingerprint } from './syncFingerprint.js'
import { assertComputerTarget } from './target.js'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

export interface MaintenanceEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ payload: unknown }>
  workerBundleReadiness?(deviceId: string): Promise<WorkerBundleReadiness>
}
/** What Main has installed; paired computers are brought to the same set. */
export interface FleetSources {
  codexUserMcpServers(): Promise<Record<string, unknown>>
  claudeUserMcpServers(): Promise<Record<string, unknown>>
  codexPlugins(): Promise<SyncedPlugin[]>
  codexMarketplaces(): Promise<SyncedMarketplace[]>
  claudePlugins(): Promise<ClaudePluginCatalog>
  workerManifestSha256s?(): Promise<readonly string[]>
  workerContentSha256s?(): Promise<readonly string[]>
  workerPublication?(): Promise<WorkerReleasePublication>
  /** Sign-in and Foreman Code MCP facts for one computer, read with the caller's own authority. */
  connections?(principal: ManagementPrincipal, target: DeviceProvisioningTarget): Promise<ComputerConnections>
}

interface WorkerArtifactIdentities {
  manifests: readonly string[]
  contents: readonly string[]
}

interface MaintenanceObservation {
  status: MaintenanceStatus | null
  observation: ReadObservation
}

const CACHE_MS = 20_000
const RUNNING_CACHE_MS = 3_000
const SYNC_RETRY_MS = 5 * 60_000
const MAX_SYNC_RETRY_MS = 60 * 60_000
const RETIRED_APP_SERVERS = ['graphql-app', 'graphql-operator', 'graphql-worker']

/** Server definitions safe to copy: no inline secret values. Servers needing a login are set up per computer later. */
export function syncableServers(
  entries: Record<string, unknown>, skipped?: (name: string, reason?: string, disposition?: 'exclude') => void,
): SyncedMcpServer[] {
  const servers: SyncedMcpServer[] = []
  for (const [name, raw] of Object.entries(entries)) {
    if ([...APP_MCP_SERVER_NAMES, ...RETIRED_APP_SERVERS].includes(name as never)) continue
    if (!raw || typeof raw !== 'object') {
      skipped?.(name)
      continue
    }
    const entry = raw as Record<string, unknown>
    const unsupported = (entry.enabled !== undefined && entry.enabled !== true)
      || Object.hasOwn(entry, 'enabled_tools') || Object.hasOwn(entry, 'disabled_tools')
      || (entry.env_vars !== undefined && (!Array.isArray(entry.env_vars) || entry.env_vars.length > 0))
    if (unsupported) {
      skipped?.(name, 'has unsupported native policy or environment references')
      continue
    }
    const hasSecrets = ['env', 'headers', 'http_headers', 'env_http_headers'].some(key =>
      entry[key] && typeof entry[key] === 'object' && Object.keys(entry[key] as object).length > 0)
    if (hasSecrets) {
      skipped?.(name, 'contains credentials; configure it separately on each computer')
      continue
    }
    const url = typeof entry.url === 'string' ? entry.url : undefined
    let candidate: unknown
    if (url) {
      candidate = { transport: 'http', name, url,
        bearerTokenEnvVar: typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : null }
    } else if (typeof entry.command === 'string') {
      candidate = { transport: 'stdio', name, command: entry.command, args: entry.args ?? [], envVars: [] }
    }
    const parsed = candidate ? SyncedMcpServerSchema.safeParse(candidate) : undefined
    if (parsed?.success && parsed.data.transport === 'http') {
      const hostname = new URL(parsed.data.url).hostname.toLowerCase().replace(/\.$/u, '')
      if (hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname.startsWith('127.') || ['[::1]', '[::]', '0.0.0.0'].includes(hostname)) {
        skipped?.(name, 'uses a host-local endpoint; configure it separately on each computer', 'exclude')
        continue
      }
    }
    if (parsed?.success) servers.push(parsed.data)
    else skipped?.(name)
  }
  return servers
}

/** Main's view of every computer's maintenance, and the one place that starts maintenance across them. */
export class FleetMaintenanceService {
  private closing = false
  private readonly backgroundTasks = new Set<Promise<void>>()
  private readonly cache = new Map<string, {
    at: number; pending: boolean; running?: boolean; observation?: ReadObservation; status?: MaintenanceStatus | null;
    value: Promise<MaintenanceObservation>
  }>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => MaintenanceEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: ComputerMaintenance,
    private readonly sources: FleetSources,
    private readonly now: () => number = Date.now,
  ) {}

  async list(principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http', refresh = false): Promise<ComputerMaintenanceList> {
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computers_maintenance_status', this.mainId)
      throw error
    }
    const targets = await this.targets(principal, 'settings:read')
    const workerPublication = await this.sources.workerPublication?.()
    return ComputerMaintenanceListSchema.parse({ computers: await Promise.all(targets.map(async target =>
      ({ target, ...await this.observeComputer(target, refresh), ...(workerPublication ? { workerPublication } : {}),
        ...await this.connections(principal, target) }))) })
  }

  async start(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: ComputerMaintenanceStartInput): Promise<ComputerMaintenanceStartResult> {
    const input = ComputerMaintenanceStartInputSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computers_maintenance_start', this.mainId)
      throw error
    }
    if (input.task.kind === 'restart' && !input.targets) {
      throw new DomainError('COMPUTER_RESTART_TARGET_REQUIRED', 'Choose the computers to restart.', 400)
    }
    let dispatch: ReturnType<typeof ComputerMaintenanceDispatchSchema.parse> | undefined
    const prepare = async () => {
      const planned = await this.commands.execute({ principal, source, operation: 'computers.maintenance.plan',
        commandId: input.commandId, targetKey: `computers-maintenance:${this.mainId}`, payload: input,
        authorize: async sql => { requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update') },
        perform: async () => {
          const selected = input.targets ?? await this.targets(principal, 'settings:update')
          const workersOnly = ['sync-mcp', 'sync-plugins'].includes(input.task.kind)
            || (input.task.kind === 'update-worker' && !input.targets)
          const targets = workersOnly
            ? selected.filter(target => target.hostRef.kind !== 'main') : selected
          return ComputerMaintenanceDispatchSchema.parse({ targets, task: await this.taskFor(input.task) })
        },
      })
      dispatch = ComputerMaintenanceDispatchSchema.parse(planned.value)
    }
    const result = await this.commands.execute({ principal, source, operation: 'computers.maintenance.start', commandId: input.commandId,
      targetKey: `computers-maintenance:${this.mainId}`, payload: input,
      prepare,
      authorize: async sql => { requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update') },
      perform: async () => {
        const known = await this.targets(principal, 'settings:update')
        const { targets, task } = dispatch!
        const computers = await Promise.all(targets.map(async target => {
          if (!known.some(value => sameDeviceProvisioningTarget(value, target))) {
            return { target, task: null, error: 'This computer is not paired with this Main.' }
          }
          try { return { target, task: await this.startOn(target, task, input.commandId), error: null } }
          catch (error) { return { target, task: null, error: errorMessage(error, 'The computer did not answer.') } }
        }))
        for (const target of targets) this.cache.delete(this.key(target))
        return ComputerMaintenanceStartResultSchema.parse({ computers })
      },
    })
    if (!result.replayed) return result.value
    const saved = ComputerMaintenanceStartResultSchema.parse(result.value)
    if (saved.computers.some(computer => !computer.task)) await prepare()
    return this.readStartedTasks(principal, saved, input.commandId, dispatch)
  }

  async readTarget(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerMaintenanceList> {
    const input = ComputerMaintenanceReadInputSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computers_maintenance_status', this.mainId)
      throw error
    }
    const sql = await this.pool.connect()
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:read')
      await assertComputerTarget(sql, this.mainId, input.target)
    } finally { sql.release() }
    const workerPublication = await this.sources.workerPublication?.()
    return ComputerMaintenanceListSchema.parse({
      computers: [{ target: input.target, ...await this.observeComputer(input.target, input.refresh === true),
        ...(workerPublication ? { workerPublication } : {}), ...await this.connections(principal, input.target) }],
    })
  }

  private async readStartedTasks(principal: ManagementPrincipal,
    saved: ComputerMaintenanceStartResult, commandId: string,
    dispatch?: ReturnType<typeof ComputerMaintenanceDispatchSchema.parse>): Promise<ComputerMaintenanceStartResult> {
    const known = await this.targets(principal, 'settings:update')
    return ComputerMaintenanceStartResultSchema.parse({ computers: await Promise.all(saved.computers.map(async computer => {
      if (!known.some(target => sameDeviceProvisioningTarget(target, computer.target))) {
        return { ...computer, task: null, error: 'This computer is no longer paired with this Main.' }
      }
      if (!computer.task) {
        try {
          const task = await this.startOn(computer.target, dispatch!.task, commandId)
          this.cache.delete(this.key(computer.target))
          return { ...computer, task, error: null }
        } catch (error) {
          return { ...computer, error: errorMessage(error, 'The computer did not answer.') }
        }
      }
      const taskId = computer.task.id
      const status = await this.status(computer.target, true)
      const task = status?.tasks.find(task => task.id === taskId)
      if (task) return { ...computer, task }
      if (computer.task.state !== 'running') return computer
      return { ...computer, task: null, error: status
        ? 'This maintenance task is no longer retained. Read current status before starting another command.'
        : 'The computer is unavailable; this maintenance task could not be read back.' }
    })) })
  }

  /** Background upkeep: current harnesses everywhere, then Main's MCP servers and plugins on every paired computer. */
  keepCurrent(): Promise<void> {
    return this.trackBackground(() => this.keepCurrentNow())
  }

  private async keepCurrentNow(): Promise<void> {
    const targets = await this.allTargets()
    const artifacts = await this.workerArtifacts()
    const sync = await Promise.allSettled([this.taskFor({ kind: 'sync-mcp' }), this.taskFor({ kind: 'sync-plugins' })])
    await Promise.all(targets.map(async target => {
      const status = await this.status(target, true)
      if (!status) return
      const behind = status.harnesses.filter(entry => entry.latest && entry.version !== entry.latest).map(entry => entry.harness)
      if (behind.length) await this.startOn(target, { kind: 'update-harnesses', harnesses: behind })
        .catch(ignoreError('lifecycle', 'start harness update on computer', { host: target.hostRef, nextRetryMs: 60_000 }))
      if (target.hostRef.kind === 'main') return
      await this.syncWorkerUpdate(target, status, artifacts)
      for (const task of sync) {
        if (task.status === 'fulfilled') await this.syncSource(target, task.value, status)
      }
    }))
    const failures = sync.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Some fleet settings could not be read.')
  }

  private readonly deliveries = new Map<string, {
    fingerprint: string; taskId: string; state: 'pending' | 'failed' | 'delivered'; retryAt: number
  }>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly workerUpdates = new Map<string, {
    manifests: string; commandId: string; pending: boolean; retryAt: number
  }>()
  /**
   * Pushes Main's current MCP servers and plugins to every connected computer that has not received this exact set yet.
   * Runs every minute on Main, so installs and removals on Main reach the other computers within about a minute, and a
   * computer that was offline catches up when it is back.
   */
  syncChangedSources(): Promise<void> {
    return this.trackBackground(() => this.syncChangedSourcesNow())
  }

  private async syncChangedSourcesNow(): Promise<void> {
    const sources = await Promise.allSettled([this.taskFor({ kind: 'sync-mcp' }), this.taskFor({ kind: 'sync-plugins' })])
    const targets = (await this.allTargets()).filter(target => target.hostRef.kind !== 'main')
    const artifacts = await this.workerArtifacts()
    await Promise.all(targets.map(async target => {
      const status = await this.status(target, true)
      await this.syncWorkerUpdate(target, status, artifacts)
      await Promise.all(sources.map(async source => {
        if (source.status === 'fulfilled') await this.syncSource(target, source.value, status)
      }))
    }))
    const failures = sources.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Some fleet settings could not be read.')
  }

  private syncWorkerUpdate(target: DeviceProvisioningTarget, status: MaintenanceStatus | null,
    artifacts: WorkerArtifactIdentities): Promise<void> {
    const key = `${this.key(target)}:update-worker`
    const active = this.syncing.get(key)
    if (active) return active
    const task = this.deliverWorkerUpdate(target, status, artifacts).finally(() => this.syncing.delete(key))
    this.syncing.set(key, task)
    return task
  }

  private async workerArtifacts(): Promise<WorkerArtifactIdentities> {
    const [manifests, contents] = await Promise.all([
      this.sources.workerManifestSha256s?.() ?? [],
      this.sources.workerContentSha256s?.() ?? [],
    ])
    if (this.sources.workerManifestSha256s && !manifests.length
      || this.sources.workerContentSha256s && !contents.length) {
      throw new DomainError('WORKER_BUNDLE_UNPUBLISHED', 'No published Worker bundle identities are available.', 503)
    }
    return { manifests, contents }
  }

  private async deliverWorkerUpdate(target: DeviceProvisioningTarget, status: MaintenanceStatus | null,
    artifacts: WorkerArtifactIdentities): Promise<void> {
    const { manifests, contents } = artifacts
    if (!status?.worker || !manifests.length || target.hostRef.kind !== 'device') return
    if (!this.endpoint()?.capabilities(target.hostRef.deviceId).some(value => value.namespace === WORKER_UPDATE_NAMESPACE)) return
    if (status.worker.manifestSha256 && manifests.includes(status.worker.manifestSha256)) return
    if (status.worker.contentSha256 && contents.includes(status.worker.contentSha256)) return
    if (!['current', 'rolled-back', 'failed'].includes(status.worker.state)
      || status.tasks.some(task => task.kind === 'update-worker' && task.state === 'running')) return
    const key = this.key(target)
    const fingerprint = [...manifests].sort().join(':')
    const previous = this.workerUpdates.get(key)
    if (previous?.manifests === fingerprint && this.now() < previous.retryAt) return
    const commandId = previous?.manifests === fingerprint && previous.pending ? previous.commandId : randomUUID()
    const delivery = { manifests: fingerprint, commandId, pending: true, retryAt: this.now() + SYNC_RETRY_MS }
    this.workerUpdates.set(key, delivery)
    try {
      await this.startOn(target, { kind: 'update-worker', retry: false }, commandId)
      delivery.pending = false
    } catch (error) {
      ignoreError('lifecycle', 'prompt Worker manifest update', { host: target.hostRef, nextRetryMs: Math.max(0, delivery.retryAt - this.now()) })(error)
    }
  }

  stopAdmission(): void {
    this.closing = true
    this.local.stopAdmission()
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.backgroundTasks])
    await this.local.drain()
  }

  private trackBackground(action: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve()
    const task = action().finally(() => this.backgroundTasks.delete(task))
    this.backgroundTasks.add(task)
    return task
  }

  private syncSource(target: DeviceProvisioningTarget, source: MaintenanceTaskStart,
    status: MaintenanceStatus | null): Promise<void> {
    const key = `${this.key(target)}:${source.kind}`
    const active = this.syncing.get(key)
    if (active) return active
    const delivery = this.deliverSource(target, source, status).finally(() => this.syncing.delete(key))
    this.syncing.set(key, delivery)
    return delivery
  }

  private async deliverSource(target: DeviceProvisioningTarget, source: MaintenanceTaskStart,
    status: MaintenanceStatus | null): Promise<void> {
    if (!status) return
    const key = `${this.key(target)}:${source.kind}`
    const fingerprint = syncFingerprint(source)
    const delivery = this.deliveries.get(key)
    const tasks = status.tasks.filter(task => task.kind === source.kind)
    const latest = tasks[0]
    if (latest?.sourceFingerprint === fingerprint) {
      if (latest.state === 'succeeded') {
        this.deliveries.set(key, { fingerprint, taskId: latest.id, state: 'delivered', retryAt: 0 })
        return
      }
      if (latest.state === 'running') return
      let failures = 0
      for (const task of tasks) {
        if (task.sourceFingerprint !== fingerprint || task.state !== 'failed') break
        failures++
      }
      const delay = Math.min(SYNC_RETRY_MS * 2 ** (failures - 1), MAX_SYNC_RETRY_MS)
      // Compare timestamps from the same Worker so its clock offset cannot defeat backoff.
      const elapsed = Math.max(0, Date.parse(status.observedAt) - Date.parse(latest.finishedAt ?? latest.startedAt))
      let retryAt = this.now() + Math.max(0, delay - elapsed)
      if (delivery?.taskId === latest.id && delivery.state === 'failed') {
        retryAt = Math.min(retryAt, delivery.retryAt)
      }
      if (delivery?.taskId !== latest.id || delivery.state !== 'failed') {
        logIgnoredError('lifecycle', 'retry fleet configuration sync',
          Object.assign(new Error('Fleet configuration task failed; its original delivery will retry.'),
            { code: 'FLEET_SYNC_FAILED' }), { attempt: failures, nextRetryMs: Math.max(0, retryAt - this.now()) })
      }
      this.deliveries.set(key, { fingerprint, taskId: latest.id, state: 'failed', retryAt })
      if (this.now() < retryAt) return
    } else if (delivery?.fingerprint === fingerprint) {
      if (delivery.state === 'delivered' && !latest) return
      if (this.now() < delivery.retryAt) return
    }
    const retryingUnknown = delivery?.fingerprint === fingerprint && !tasks.some(task => task.id === delivery.taskId)
    const commandId = retryingUnknown ? delivery.taskId : randomUUID()
    // An unanswered start keeps its command ID so retrying cannot duplicate accepted work.
    this.deliveries.set(key, { fingerprint, taskId: commandId, state: 'pending', retryAt: this.now() + SYNC_RETRY_MS })
    const result = await Promise.allSettled([this.startOn(target, source, commandId)])
    const started = result[0]!
    if (started.status !== 'fulfilled') return
    if (started.value.sourceFingerprint !== fingerprint) {
      this.deliveries.get(key)!.retryAt = 0
      return
    }
    this.deliveries.set(key, { fingerprint, taskId: started.value.id,
      state: started.value.state === 'succeeded' ? 'delivered' : 'pending', retryAt: this.now() + SYNC_RETRY_MS })
  }

  private async taskFor(task: ComputerMaintenanceStartInput['task']): Promise<MaintenanceTaskStart> {
    if (task.kind === 'sync-mcp') {
      const catalogs = await Promise.allSettled([
        this.sources.codexUserMcpServers(), this.sources.claudeUserMcpServers(),
      ])
      const servers: Extract<MaintenanceTaskStart, { kind: 'sync-mcp' }>['servers'] = {}
      const skippedServers: NonNullable<Extract<MaintenanceTaskStart, { kind: 'sync-mcp' }>['skippedServers']> = {}
      const warnings: string[] = []
      for (const [index, harness] of (['codex', 'claude'] as const).entries()) {
        const catalog = catalogs[index]!
        if (catalog.status === 'rejected') warnings.push(`${harness} MCP catalog could not be read; skipped.`)
        else {
          const skipped: string[] = []
          servers[harness] = syncableServers(catalog.value, (name, reason = 'is unsafe or invalid', disposition) => {
            if (disposition !== 'exclude' && name.length > 0 && name.length <= 100) skipped.push(name)
            warnings.push(`${harness} MCP server ${name.slice(0, 100)} ${reason}; skipped.`)
          })
          if (skipped.length) skippedServers[harness] = skipped
        }
      }
      if (servers.codex === undefined && servers.claude === undefined) {
        throw new Error('Main\'s MCP catalogs could not be read.')
      }
      return { kind: 'sync-mcp', servers,
        ...(Object.keys(skippedServers).length ? { skippedServers } : {}),
        ...(warnings.length ? { warnings } : {}) }
    }
    if (task.kind === 'sync-plugins') {
      const [codex, claude] = await Promise.allSettled([
        Promise.all([this.sources.codexPlugins(), this.sources.codexMarketplaces()]), this.sources.claudePlugins(),
      ])
      if (codex.status === 'rejected' && claude.status === 'rejected') {
        throw new Error('Main\'s plugin catalogs could not be read.')
      }
      const request: Extract<MaintenanceTaskStart, { kind: 'sync-plugins' }> = { kind: 'sync-plugins' }
      const warnings: string[] = []
      if (codex.status === 'fulfilled') {
        const marketplaces = SyncedMarketplaceSchema.array().safeParse(codex.value[1])
        if (marketplaces.success) {
          request.plugins = codex.value[0].map(plugin => plugin.pluginId)
          const versions = codex.value[0].flatMap(plugin => plugin.version === null ? [] : [[plugin.pluginId, plugin.version]])
          if (versions.length) request.pluginVersions = Object.fromEntries(versions)
          request.marketplaces = marketplaces.data
        } else warnings.push('Codex marketplace sources are unsafe or invalid; plugin sync skipped.')
      } else warnings.push('Codex plugin catalog could not be read; skipped.')
      if (claude.status === 'fulfilled') {
        const marketplaces = SyncedMarketplaceSchema.array().safeParse(claude.value.marketplaces
          .flatMap(item => item.source ? [{ name: item.name, source: item.source }] : []))
        if (marketplaces.success) {
          request.claudePlugins = claude.value.plugins.filter(plugin => plugin.installed)
            .map(({ pluginId, enabled, version }) => ({ pluginId, enabled, ...(version === null ? {} : { version }) }))
          request.claudeMarketplaces = marketplaces.data
        } else warnings.push('Claude marketplace sources are unsafe or invalid; plugin sync skipped.')
      } else warnings.push('Claude plugin catalog could not be read; skipped.')
      if (request.plugins === undefined && request.claudePlugins === undefined) {
        throw new Error('Main\'s plugin catalogs do not contain safe marketplace sources.')
      }
      if (warnings.length) request.warnings = warnings
      return request
    }
    return task
  }

  private async startOn(target: DeviceProvisioningTarget, task: MaintenanceTaskStart,
    commandId: string = randomUUID()): Promise<MaintenanceTask> {
    if (this.closing) {
      throw new DomainError('COMPUTER_MAINTENANCE_CLOSING', 'Computer maintenance is shutting down.', 503)
    }
    if (target.hostRef.kind === 'main') {
      if (task.kind === 'update-worker') {
        throw new DomainError('COMPUTER_WORKER_UPDATE_UNSUPPORTED',
          'Main is updated with production:install. Choose a paired Worker for this task.', 400)
      }
      return this.local.start(task, commandId)
    }
    if (task.kind === 'update-worker') {
      const publication = await this.sources.workerPublication?.()
      if (publication && publication.state !== 'published') {
        throw new DomainError('WORKER_RELEASE_ASSET_UNAVAILABLE', publication.lastError
          ?? `Worker ${publication.version} is waiting for GitHub publication and verification.`, 503)
      }
      const capabilities = this.endpoint()?.capabilities(target.hostRef.deviceId) ?? []
      const maintenanceAvailable = capabilities.some(value =>
        value.namespace === COMPUTER_MAINTENANCE_NAMESPACE && value.mainCanRequest)
      if (maintenanceAvailable && !capabilities.some(value => value.namespace === WORKER_UPDATE_NAMESPACE)) {
        throw new DomainError('COMPUTER_WORKER_UPDATE_UNSUPPORTED',
          'Install an updater-enabled Worker once on this computer before automatic updates are available.', 409)
      }
    }
    const reply = MaintenanceReplySchema.parse((await this.request(target.hostRef.deviceId,
      { operation: 'start', commandId, task })).payload)
    if (reply.operation !== 'start') throw new DomainError('COMPUTER_MAINTENANCE_INVALID', 'The computer returned an unexpected reply.', 502)
    return reply.task
  }

  private async status(target: DeviceProvisioningTarget, refresh: boolean): Promise<MaintenanceStatus | null> {
    const { status, observation } = await this.observeStatus(target, refresh)
    return observation.status === 'available' ? status : null
  }

  private async connections(principal: ManagementPrincipal, target: DeviceProvisioningTarget) {
    try {
      const connections = await this.sources.connections?.(principal, target)
      return connections ? { connections } : {}
    } catch (error) {
      logIgnoredError('lifecycle', 'read computer connections', error, { host: target.hostRef })
      return {}
    }
  }

  private async observeComputer(target: DeviceProvisioningTarget, refresh: boolean) {
    const observation = await this.observeStatus(target, refresh)
    const endpoint = this.endpoint()
    if (!observation.status || observation.observation.status !== 'available'
      || target.hostRef.kind !== 'device' || !endpoint?.workerBundleReadiness) return observation
    try {
      return { ...observation, workerReadiness: await endpoint.workerBundleReadiness(target.hostRef.deviceId) }
    } catch (error) {
      const unavailable = failedReadObservation(observation.observation, error,
        'Worker readiness observation failed', this.now())
      componentLogger('lifecycle').warn({ host: target.hostRef, ...unavailable }, 'Worker readiness unavailable')
      return { status: observation.status, observation: unavailable }
    }
  }

  private observeStatus(target: DeviceProvisioningTarget, refresh: boolean): Promise<MaintenanceObservation> {
    const key = this.key(target)
    const cached = this.cache.get(key)
    // A running task's progress is read again within seconds; settled status is reused longer.
    const ttl = cached?.running ? RUNNING_CACHE_MS : CACHE_MS
    if (cached && (cached.pending || (!refresh && cached.observation?.status === 'available'
      && this.now() - cached.at < ttl))) return cached.value
    // A bounded shared observation survives one reader canceling so other readers can still use it.
    const read = (async () => {
      if (target.hostRef.kind === 'main') return this.local.status(AbortSignal.timeout(90_000))
      const reply = MaintenanceReplySchema.parse((await this.request(target.hostRef.deviceId, { operation: 'status' })).payload)
      if (reply.operation !== 'status') {
        throw new DomainError('COMPUTER_MAINTENANCE_INVALID', 'The computer returned an unexpected reply.', 502)
      }
      return reply.status
    })()
    const value = read.then(status => ({ status, observation: successfulReadObservation(this.now()) }), error => {
      const observation = failedReadObservation(cached?.observation, error, 'Maintenance observation failed', this.now())
      componentLogger('lifecycle').warn({ host: target.hostRef, ...observation }, 'Computer maintenance observation unavailable')
      return { status: cached?.status ?? null, observation }
    })
    const entry: NonNullable<ReturnType<typeof this.cache.get>> = {
      at: this.now(), pending: true, running: false, value,
    }
    this.cache.set(key, entry)
    void value.then(({ status, observation }) => {
      entry.pending = false
      entry.at = this.now()
      entry.observation = observation
      entry.status = status
      const workerUpdating = status?.worker && !['current', 'rolled-back', 'failed'].includes(status.worker.state)
      entry.running = status?.tasks.some(task => task.state === 'running') || Boolean(workerUpdating)
    })
    return value
  }

  private async request(deviceId: string, payload: unknown) {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_MAINTENANCE_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_MAINTENANCE_UNAVAILABLE', 'This computer is offline or runs an app version without maintenance support.', 409)
    }
    return endpoint.request(deviceId, COMPUTER_MAINTENANCE_NAMESPACE, payload, { signal: AbortSignal.timeout(100_000), timeoutMs: 100_000 })
  }

  private key(target: DeviceProvisioningTarget) { return `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}` }

  private async targets(principal: ManagementPrincipal, action: 'settings:read' | 'settings:update') {
    const sql = await this.pool.connect()
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
      return await this.pairedTargets(sql)
    } finally { sql.release() }
  }

  private async allTargets() {
    const sql = await this.pool.connect()
    try { return await this.pairedTargets(sql) } finally { sql.release() }
  }

  private async pairedTargets(sql: pg.PoolClient): Promise<DeviceProvisioningTarget[]> {
    const rows = await sql.query<{ record: unknown }>(`select record from device_registrations
      where main_id=$1 and record->>'status'='paired' order by id limit 100`, [this.mainId])
    return [{ hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId, keyRevision: null, authorizationRevision: null },
      ...rows.rows.map(row => DeviceRegistrationSchema.parse(row.record)).map(registration => ({
        hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
        applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
        authorizationRevision: registration.authorizationRevision }))]
  }
}
