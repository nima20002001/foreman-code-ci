import { join } from 'node:path'
import { CiRuntimeRequestSchema, CiRuntimeWorkerStateSchema, PreparedCiRuntimeSchema,
  type CiRuntimeRequest, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ensureCommit, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { prepareCiRuntime } from './ciRuntimePrepare.js'
import { lastCiRuntimeRefresh, scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'
import { readCiInstalledStorage } from './ciInstalledStorage.js'
import { ciPreparationLimits } from './ciPreparationLimits.js'
import { readCiManagedSetup } from './ciRuntimeInstallation.js'
import { readCiRuntimeState, writeCiRuntimeState } from './ciRuntimeState.js'
import { componentLogger } from '../diagnostics/logger.js'

export interface CiRuntimeWorkerPorts {
  git: GitWorktreePorts
  /** This build computer's managed runtime root; the installer workspace lives inside it. */
  managedRuntimeRoot(): Promise<string>
  prepare: typeof prepareCiRuntime
  /** Omitted on Host CI computers, which do not install a container CI runtime. */
  refresh?: (input: Omit<Parameters<typeof scheduleCiRuntimeRefresh>[0], 'drain'>) => ReturnType<typeof scheduleCiRuntimeRefresh>
  lastRefresh: typeof lastCiRuntimeRefresh
  /** Paths the current protected runtime configuration references. */
  currentRuntimePaths(stateDirectory: string): Promise<string[]>
  now(): Date
}

/** One CI runtime preparation at a time on this build computer; Main follows it with `status`. */
export class CiRuntimeWorker {
  private state: CiRuntimeWorkerState | undefined
  private preparation: Promise<void> | undefined
  private preparationPending = false
  private restoring: Promise<CiRuntimeWorkerState> | undefined
  private draining = false
  /** `lifetime` is the Worker's, not a request's: preparation outlives the call that started it. */
  constructor(private readonly stateDirectory: string, private readonly ports: CiRuntimeWorkerPorts,
    private readonly lifetime: AbortSignal) {
  }

  async handle(raw: unknown): Promise<CiRuntimeWorkerState> {
    const request = CiRuntimeRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const managedSetup = await readCiManagedSetup(this.stateDirectory)
      const installedStorage = managedSetup?.state === 'failed' ? null : await readCiInstalledStorage(this.stateDirectory)
      return { ...await this.status(), installedStorage, ...(managedSetup ? { managedSetup } : {}) }
    }
    if (request.operation === 'refresh' && !this.ports.refresh) {
      throw new DomainError('CI_RUNTIME_RETIRED',
        'This computer uses Host CI. Start a Host CI run instead of refreshing the legacy CI runtime.', 409)
    }
    const managedSetup = await readCiManagedSetup(this.stateDirectory)
    if (managedSetup && managedSetup.state !== 'ready') {
      throw new DomainError('CI_RUNTIME_SETUP_REQUIRED', managedSetup.message ?? 'Managed CI storage is unavailable.', 409)
    }
    this.lifetime.throwIfAborted()
    if (request.operation === 'prepare') return this.prepare(request)
    return this.refresh(request)
  }

  private async status(): Promise<CiRuntimeWorkerState> {
    if (this.state) return this.state
    return this.restoring ??= this.restore()
  }

  private async restore(): Promise<CiRuntimeWorkerState> {
    const saved = await readCiRuntimeState(this.stateDirectory)
    const last = await this.ports.lastRefresh(this.stateDirectory)
    // The refresh result supersedes preparation saved before the service restarted.
    const refreshed = saved && last?.operationId === saved.operationId && last?.commit === saved.commit
      && (saved.state === 'prepared' || saved.state === 'refreshing')
    if (saved && !refreshed) {
      this.state = saved
      return saved
    }
    const restored = this.set({ ...saved,
      operationId: last?.operationId ?? null, state: last && !last.ok ? 'failed' : 'idle',
      commit: last?.commit ?? null, stage: last ? 'refresh' : null,
      prepared: null, message: last && !last.ok ? `The runtime refresh failed: ${last.log}` : null })
    if (last) await writeCiRuntimeState(this.stateDirectory, restored)
    return restored
  }

  private async prepare(request: Extract<CiRuntimeRequest, { operation: 'prepare' }>) {
    if (this.draining) throw new DomainError('WORKER_RUNTIME_DRAINING',
      'This computer is waiting for CI preparation to finish before updating its runtime.', 409)
    const current = await this.status()
    if (this.draining) throw new DomainError('WORKER_RUNTIME_DRAINING',
      'This computer is waiting for CI preparation to finish before updating its runtime.', 409)
    const latest = this.state ?? current
    if (this.preparationPending || latest.state === 'preparing' || latest.state === 'refreshing') {
      if (latest.operationId === request.operationId && latest.commit === request.commit) return latest
      throw new DomainError('CI_RUNTIME_BUSY', 'This computer is already preparing its CI runtime for another commit.', 409)
    }
    if (latest.state === 'prepared' && latest.operationId === request.operationId
      && latest.commit === request.commit) return latest
    const state = this.set({ operationId: request.operationId, state: 'preparing', commit: request.commit,
      stage: 'fetch-source', prepared: null, message: null, preparationLimits: ciPreparationLimits() })
    this.preparationPending = true
    this.preparation = (async () => {
      const repository = await ensureCommit(this.ports.git, request.repository, request.commit, this.lifetime).catch(error => {
        this.lifetime.throwIfAborted()
        throw error
      })
      this.lifetime.throwIfAborted()
      const installer = join(await this.ports.managedRuntimeRoot(), 'installer')
      const keepPaths = await this.ports.currentRuntimePaths(this.stateDirectory)
      this.lifetime.throwIfAborted()
      const prepared = await this.ports.prepare({ repository, commit: request.commit,
        installer, review: request.review, keepImages: request.keepImages, keepPaths,
        signal: this.lifetime,
        onCacheStatus: cache => {
          if (this.state?.operationId === request.operationId) this.set({ ...this.state, cache })
        },
        log: stage => {
          this.lifetime.throwIfAborted()
          if (this.state?.commit === request.commit) this.set({ ...this.state, stage })
        } })
      this.lifetime.throwIfAborted()
      const completed = this.set({ operationId: request.operationId, state: 'prepared', commit: request.commit,
        stage: null, prepared: PreparedCiRuntimeSchema.parse(prepared), message: null,
        ...(prepared.cache ? { cache: prepared.cache } : {}),
        preparationLimits: state.preparationLimits! })
      await writeCiRuntimeState(this.stateDirectory, completed)
    })().catch(async error => {
      const failed = this.set({ operationId: request.operationId, state: 'failed', commit: request.commit,
        stage: this.state?.stage ?? null, prepared: null,
        ...(this.state?.cache ? { cache: this.state.cache } : {}),
        preparationLimits: state.preparationLimits!,
        message: (error instanceof Error ? error.message : String(error)).slice(-2000) })
      await writeCiRuntimeState(this.stateDirectory, failed)
    }).finally(() => {
      this.preparationPending = false
    })
    void this.preparation.catch(error => {
      componentLogger('jobs').error({ err: error, operationId: request.operationId }, 'CI preparation state could not be saved')
    })
    return state
  }

  async close(): Promise<void> {
    await this.preparation
  }

  async beginDrain(): Promise<void> {
    this.draining = true
    await this.preparation
  }

  resumeAdmissions() { this.draining = false }

  isUpdateIdle() { return !this.preparationPending }

  private async refresh(request: Extract<CiRuntimeRequest, { operation: 'refresh' }>) {
    if (this.state?.state === 'refreshing' && this.state.operationId === request.operationId
      && this.state.commit === request.commit) return this.state
    const prepared = this.state?.state === 'prepared' ? this.state.prepared : null
    if (!prepared || prepared.commit !== request.commit || this.state?.operationId !== request.operationId) {
      throw new DomainError('CI_RUNTIME_NOT_PREPARED', 'Prepare this commit on the computer before refreshing its runtime.', 409)
    }
    const state = this.set({ ...this.state!, state: 'refreshing', stage: 'draining' })
    try {
      await this.ports.refresh!({ operationId: request.operationId, stateDirectory: this.stateDirectory,
        prepared, root: request.root, manifest: request.manifest, resources: request.resources })
      return this.set({ ...state, stage: 'restart' })
    } catch (error) {
      this.set({ ...state, state: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(-2000) })
      throw error
    }
  }

  private set(value: Omit<CiRuntimeWorkerState, 'updatedAt'>) {
    this.state = CiRuntimeWorkerStateSchema.parse({ ...value, updatedAt: this.ports.now().toISOString() })
    return this.state
  }
}
