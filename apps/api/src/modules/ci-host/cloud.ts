import { updateOperationalFailure } from '../diagnostics/operationalFailures.js'
import { failedReadObservation, successfulReadObservation } from '../diagnostics/readObservation.js'
import type { ReadObservation } from '@foreman-code/contracts'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { compactIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { homedir, hostname, userInfo } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type pg from 'pg'
import { CiIntegrationCoverageSchema, CiSelectionSchema, CiWatchdogFailureSchema, CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, WorkspaceSchema,
  integrationPartition, requiresUserSystemd,
  type CiCoverageSelection, type CiDurations, type CiHostReply, type CiHostRequest, type CiHostRun, type CiPartition, type CiMirrorRepair } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { deepenUntilConnected, ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import type { HostCiComputer } from './service.js'
import type { CiMirrorInput } from './serviceTypes.js'
import { CLOUD_LOG_LIMIT, CLOUD_START_TIMEOUT_MS, CIRCLE_EMPTY_PIPELINE_RECHECK_MS, CircleCiProvider, GitHubActionsProvider, cloudCiId, validateProviderParameters,
  type CloudDispatchInput, type CloudProvider, type CloudRun, type CloudStatus } from './cloudProviders.js'
import { runsOnCircleCi } from './parts.js'
import { pruneMirrorBranches, type ActiveCiRuns } from './mirrorBranches.js'
import { pushMirror } from './mirrorPush.js'
import { CircleCiAccounts } from './circleCiAccounts.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { readCloudRun, saveCloudRun } from './cloudJournal.js'
import { ciLogPage } from './logPage.js'
import { sanitizeCiText } from './text.js'
import { withProviderPoll } from './providerPoll.js'
import { sweepCiRunDirectories } from './directoryRetention.js'
import { readFleetIdentityInventory } from './fleetIdentityInventory.js'
import type { CircleAccountContext, CircleAccountRegistry } from './circleAccounts.js'
import { CircleStandby } from './circleStandby.js'
import { unresolvedCloudAttemptIds } from './cloudAttempts.js'

const MAX_DISPATCH_ATTEMPTS = 3
const GITHUB_INPUT_LIMIT_BYTES = 65_535
/** A running run asks its service at most this often; reads in between answer from the kept state and log. */
const POLL_MS = 4_000
const FINISH_POLL_MS = 2_000
const FINISH_WINDOW_MS = 3_000
const COLLECTION_RECOVERY_MS = 10 * 60_000
/** A read waits this long for the provider's final log; a slower download carries on in the background. */
const FINAL_LOG_WAIT_MS = 10_000
const MAX_BACKOFF_MS = 10 * 60_000
const MIN_STALL_MS = 15 * 60_000
const EXPECTED_DURATION_MULTIPLIER = 3
/** Status reads are cheap and must cover a full provider fleet without serial polling waves. */
const POLL_CONCURRENCY = 24
const PRUNE_INTERVAL_MS = 5 * 60_000
const log = componentLogger('jobs')

function collectionPending(run: CloudRun): boolean {
  return Boolean(run.collection && !run.collection.unavailableAt
    && (!run.collection.log || !run.collection.artifacts))
}

function cancellationPending(run: CloudRun): boolean {
  return Boolean(run.cancellation && !run.cancellation.completedAt)
}

function neverSubmitted(run: CloudRun): boolean {
  return Boolean(run.dispatch?.notSent && !run.dispatch.uncertain
    && !run.providerRunId && !run.dispatchHistory?.length)
}

export type { CloudRun }
type Mirrors = (workspaceId: string) => Promise<string | null>
/** Pushes to one mirror, across both services, run one at a time: concurrent force-pushes of the mirror's main fail
 * the remote's old-value check ("incorrect old value provided"), and concurrent fetches race on its local ref. */
const mirrorPushes = new Map<string, Promise<unknown>>()
const mirrorOperations = new Map<string, Promise<unknown>>()

async function serializeMirror<T>(mirror: string, work: () => Promise<T>): Promise<T> {
  const previous = mirrorOperations.get(mirror) ?? Promise.resolve()
  const operation = previous.then(work, work)
  mirrorOperations.set(mirror, operation)
  try {
    return await operation
  } finally {
    if (mirrorOperations.get(mirror) === operation) mirrorOperations.delete(mirror)
  }
}

/** The snapshot Main last pushed as each mirror's main. Main is the mirrors' only writer of main, so the next publication
 * builds on it instead of fetching it back from GitHub. */
const pushedMains = new Map<string, string>()
const pendingPublications = new Map<string, Promise<void>>()
const cloudOperations = new Map<string, Promise<unknown>>()
/** Final provider log downloads by run; null once a download has failed. */
const finalLogs = new Map<string, Promise<string | null>>()
const publishingBranches = new Map<string, Set<string>>()
interface Publication {
  git: (args: string[], env?: Record<string, string>) => Promise<string>
  guard: (commit: string) => Promise<void>
  branch: string
  snapshot: string
  workflowRef: string
  mirrorPublication: NonNullable<CiHostRun['mirrorPublication']>
  workflows: string[]
  defaultBranch?: string
  baseCommit?: string
}
interface MirrorMaintenance {
  at: number
  cleanup: Promise<void> | undefined
  keep: Set<string>
  pendingFinishedRuns: Set<string>
}
const mirrorPublications = new Map<string, Map<string, Promise<Publication>>>()
const mirrorMaintenance = new Map<string, MirrorMaintenance>()

/** The public mirror belonging to this workspace, if any. */
export function workspaceMirrors(pool: pg.Pool): Mirrors {
  return async workspaceId => {
    const row = (await pool.query<{ record: unknown }>(`select record from workspaces
      where id=$1 and archived_at is null`, [workspaceId])).rows[0]
    const mirror = row ? WorkspaceSchema.parse(row.record).ciMirror : undefined
    return mirror ? `${mirror.owner}/${mirror.name}` : null
  }
}

/** Every active workspace's public mirror. */
export function workspaceMirrorList(pool: pg.Pool): () => Promise<string[]> {
  return async () => {
    const rows = (await pool.query<{ record: unknown }>(`select record from workspaces
      where archived_at is null and record ? 'ciMirror'`)).rows
    return rows.flatMap(row => {
      const mirror = WorkspaceSchema.parse(row.record).ciMirror
      return mirror ? [`${mirror.owner}/${mirror.name}`] : []
    })
  }
}

/** GitHub owners of the further CircleCI orgs that hold unfinished runs. */
export function runningCircleCiOwners(pool: pg.Pool, mainId?: string): () => Promise<{ owner: string; circleAccountId: string }[]> {
  return async () => (await pool.query<{ owner: string; circle_account_id: string }>(`select distinct
    coalesce(record#>>'{computer,hostRef,account}',split_part(record->>'ciMirror','/',1)) as owner,
    coalesce(record#>>'{computer,hostRef,circleAccountId}','default') as circle_account_id
    from ci_runs where (state in ('queued','starting','running') or record->>'collection' = 'pending'
      or record->>'executorCleanupPending'='true')
      and record#>>'{computer,hostRef,provider}'='circleci'
      and ($1::text is null or record#>>'{computer,hostRef,mainId}'=$1)`, [mainId ?? null])).rows
    .filter(row => row.owner).map(row => ({ owner: row.owner, circleAccountId: row.circle_account_id }))
}

/** Main owns ticket completion even when the last attempt ran on a different provider. */
export async function activeCiRuns(pool: pg.Pool): Promise<ActiveCiRuns> {
  const readAt = Date.now()
  const rows = (await pool.query<{ id: string; retry_id: string | null }>(
    "select id,coalesce(record->>'executionRunId',record#>>'{setupRetry,runId}') as retry_id from ci_runs where state in ('queued','starting','running') or record->>'executorCleanupPending'='true'")).rows
  return { ids: new Set(rows.flatMap(row => row.retry_id ? [row.id, row.retry_id] : [row.id])), readAt }
}

/** A cloud CI service on a workspace's public mirror as CI computers: one slot per concurrent job. A run pushes the
 * commit's files to the mirror as one commit without history, starts the provider's run of them, and reads the
 * result, log and measured durations back. */
export class CloudCi {
  private standby: CircleStandby | undefined
  private activeRuns: (() => Promise<ActiveCiRuns>) | undefined
  private checked: { at: number; ready: boolean } | undefined
  private readinessProbe: Promise<boolean> | undefined
  private readinessObserved: ReadObservation | undefined
  get readinessObservation(): ReadObservation | undefined {
    return this.readinessObserved && { ...this.readinessObserved }
  }
  private reconciling: Promise<void> | undefined
  private readonly polled = new Map<string, number>()
  private reconcileCursor = 0
  private backoff = { until: 0, ms: 0, generation: 0 }
  private following = 0
  private readonly waiting: { run: CloudRun; resume: () => void }[] = []
  private readonly reading = new Map<string, number>()
  private stopped = false

  constructor(private readonly mainId: string, readonly provider: CloudProvider, private readonly mirrors: Mirrors,
    private readonly root = join(homedir(), '.local/share/foreman-code/ci-cloud', cloudCiId(provider)),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly git: GitWorktreePorts = systemGitWorktreePorts(),
    private readonly identity = { home: homedir(), user: userInfo().username, host: hostname() }) {}

  setCircleStandby(standby: CircleStandby) { this.standby = standby }

  /** API shutdown: work it interrupts (for example through the closed database pool) is not a ticket outcome. */
  stop() { this.stopped = true }

  invalidateReadiness() { this.checked = undefined }

  async schedulingReading(mirrorName?: string) {
    if (this.provider.id !== 'circleci' || !this.provider.account || !this.standby) return undefined
    return this.standby.reading(this.provider.account.owner, this.provider.circleAccountId, mirrorName)
  }

  private async requireNewStart(mirrorName: string, request?: { runId: string; retryUnsent?: true }) {
    if (this.provider.recoveryOnly || this.provider.account?.registered === false) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', 'This CircleCI executor only finishes previously assigned jobs.', 409)
    }
    const reading = await this.schedulingReading(mirrorName)
    if (reading && reading.schedulingRole !== 'active' && !reading.creditProbeAvailable && !request?.retryUnsent) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', reading.schedulingReason, 409)
    }
    if (reading && request && !await this.standby!.admitStart(this.provider.account!.owner,
      this.provider.circleAccountId ?? 'default', mirrorName, request.runId, request)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', 'CircleCI recovery probe is already pending or cooling down.', 409)
    }
  }

  async publishMirror(input: CiMirrorInput): Promise<void> {
    const mirror = this.accountMirror(input.mirror)
    if (!mirror) return
    const branch = input.baseCommit ? `ci/${input.commit}-${input.baseCommit}` : `ci/${input.commit}`
    const reservations = publishingBranches.get(mirror) ?? new Set<string>()
    const reservation = `${randomUUID()}\n${branch}`
    reservations.add(reservation)
    publishingBranches.set(mirror, reservations)
    const maintenance = mirrorMaintenance.get(this.mirrorKey(input.repository, mirror))
    if (maintenance?.cleanup) {
      maintenance.keep.add(branch)
      maintenance.keep.add(`ci-default/${input.commit}`)
    }
    try {
      await this.publish(input.repository, mirror, input.commit,
        input.defaultBranch, input.baseCommit, input.durations ?? {}, false, input.integrationCoverage)
    } finally {
      reservations.delete(reservation)
      if (!reservations.size) publishingBranches.delete(mirror)
    }
  }

  /** This org's copy of a workspace mirror: the same repository name under the org's GitHub owner; null when the org
   * has no CircleCI project of that name. */
  private accountMirror(mirror: string): string | null {
    const account = this.provider.account
    if (!account) return mirror
    const name = mirror.slice(mirror.indexOf('/') + 1)
    return account.mirrorNames.has(name) ? `${account.owner}/${name}` : null
  }

  setActiveRunLookup(lookup: () => Promise<ActiveCiRuns>) {
    this.activeRuns = lookup
  }

  /** Waits for background sweeps before their repository can be removed. Call after ticket operations finish. */
  async waitForMirrorCleanup(repository: string, mirror: string) {
    await this.reconciling
    const key = this.mirrorKey(repository, this.accountMirror(mirror) ?? mirror)
    await Promise.all([...pendingPublications].filter(([id]) => id.startsWith(`${this.root}\n`))
      .map(([, task]) => task))
    let cleanup = mirrorMaintenance.get(key)?.cleanup
    while (cleanup) {
      await cleanup
      // A completed sweep can schedule another pass for tickets canceled during that sweep.
      cleanup = mirrorMaintenance.get(key)?.cleanup
    }
  }

  computers(priority = 30): HostCiComputer[] {
    if (this.provider.recoveryOnly) return []
    // An org without a copy of any workspace mirror only finishes the runs it already has.
    if (this.provider.account && !this.provider.account.mirrorNames.size) return []
    const account = this.provider.account?.owner
    const circleAccountId = this.provider.circleAccountId
    return Array.from({ length: this.provider.slots }, (_, slot) => ({ key: `${this.mainId}:cloud:${cloudCiId(this.provider)}:${slot}`,
      hostRef: { kind: 'cloud' as const, mainId: this.mainId, provider: this.provider.id, ...(account ? { account } : {}), slot,
        ...(circleAccountId && circleAccountId !== 'default' ? { circleAccountId } : {}) },
      label: `${this.provider.label} ${slot + 1}`, priority, userSystemd: this.provider.userSystemd }))
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const removedRunIds = request.cleanupRunIds ? await sweepCiRunDirectories({
        root: this.root, runIds: request.cleanupRunIds,
        isInUse: async runId => this.reading.has(runId) || pendingPublications.has(`${this.root}\n${runId}`)
          || unresolvedCloudAttemptIds(await this.read(runId)).length > 0,
        withRun: (runId, work) => this.serializeRun(runId, work),
      }) : undefined
      for (const runId of removedRunIds ?? []) this.polled.delete(runId)
      // Recovery of an old ticket must not delay readiness for every slot of this provider.
      void this.reconcile().catch(error => {
        log.warn({ operation: 'recover cloud CI tickets', err: error, provider: this.provider.id }, 'Cloud CI recovery sweep failed')
      })
      const ready = await this.ready()
      const transport = this.provider.transport
      const reason = this.readinessObserved?.status === 'unavailable' ? this.readinessObserved.lastError : this.provider.loginHint
      const reasons = ready ? [] : [reason]
      if (transport?.source === 'cli') {
        reasons.push(`CLI transport: ${transport.reason} (fallback count ${transport.fallbackCount}).`)
      }
      return CiHostReplySchema.parse({ operation: 'status', ready, reasons,
        cpuCount: this.provider.cpus, memoryBytes: this.provider.memoryBytes, cleanupSupported: true,
        userSystemd: this.provider.userSystemd, runs: [],
        ...(removedRunIds ? { removedRunIds } : {}) })
    }
    if (request.operation === 'read' && (this.reading.has(request.runId)
      || pendingPublications.has(`${this.root}\n${request.runId}`))) {
      // Publication and provider work answer reads from the journal while they continue in the background.
      return this.withRead(request.runId, async () => this.answer(request, await this.read(request.runId)))
    }
    return this.serializeRun(request.runId, () => this.handleRun(request))
  }

  private async serializeRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const key = `${this.root}\n${runId}`
    const previous = cloudOperations.get(key) ?? Promise.resolve()
    const operation = previous.then(work, work)
    cloudOperations.set(key, operation)
    try {
      return await operation
    } finally {
      if (cloudOperations.get(key) === operation) cloudOperations.delete(key)
    }
  }

  private async handleRun(request: Exclude<CiHostRequest, { operation: 'status' }>) {
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') {
      let run = await this.read(request.runId)
      if (['queued', 'starting', 'running'].includes(run.state)) {
        run = await this.save({ ...run, message: 'Cancellation requested; waiting for the provider to stop.',
          cancellation: { ...run.cancellation ?? { at: this.ports.now().toISOString(), canceledIds: [] }, requeue: false } })
      }
      let canceled = run
      if (cancellationPending(run) && run.mirrorPublication?.state !== 'pending') {
        canceled = await this.cancelAttempts(run)
      } else if (unresolvedCloudAttemptIds(run).length) {
        canceled = (await this.reconcileAcceptedAttempts(run)).run
      }
      if (!['queued', 'starting', 'running'].includes(canceled.state)) this.schedulePrune(canceled, canceled.runId)
      return CiHostReplySchema.parse({ operation: 'cancel', run: this.view(canceled, 0) })
    }
    return this.withRead(request.runId, async () => this.answer(request, await this.refresh(request.runId, request.reassign)))
  }

  private async withRead<T>(runId: string, read: () => Promise<T>): Promise<T> {
    this.reading.set(runId, (this.reading.get(runId) ?? 0) + 1)
    try { return await read() }
    finally {
      const remaining = this.reading.get(runId)! - 1
      if (remaining) this.reading.set(runId, remaining)
      else this.reading.delete(runId)
    }
  }

  private async answer(request: Extract<CiHostRequest, { operation: 'read' }>, run: CloudRun) {
    const page = await this.logPage(run.runId, request.afterOffset, request.maxBytes).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const retainedOutput = run.collection?.log || (run.live?.bytes ?? 0) > 0
      const awaitingOutput = ['queued', 'starting', 'running', 'canceled'].includes(run.state)
        || run.collection?.log === false
        // A run that failed before dispatch never had a provider log.
        || !run.providerRunId
      if (retainedOutput || !awaitingOutput) {
        throw new DomainError('CI_LOG_UNAVAILABLE', 'The retained CI log is missing.', 503, undefined, { cause: error })
      }
      return { text: '', nextOffset: request.afterOffset, logBytes: 0 }
    })
    if (!['starting', 'running', 'queued'].includes(run.state)) this.schedulePrune(run, run.runId)
    const view = this.view(run, page.logBytes)
    if (request.testResults && view.collection === 'complete' && !run.testResults) view.collection = 'unsupported'
    return CiHostReplySchema.parse({ operation: 'read', run: view,
      text: sanitizeCiText(page.text), nextOffset: page.nextOffset,
      ...(request.durations && run.durations ? { durations: run.durations } : {}),
      ...(request.integrationCoverage && run.integrationCoverage ? { integrationCoverage: run.integrationCoverage } : {}),
      ...(request.testResults && run.testResults ? { testResults: run.testResults } : {}) })
  }

  private async logPage(runId: string, afterOffset: number, maxBytes: number) {
    const handle = await open(this.path(runId, 'log'), 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(maxBytes, Math.max(0, size - afterOffset))
      if (!length) return { text: '', nextOffset: afterOffset, logBytes: size }
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, afterOffset)
      const page = ciLogPage(buffer.subarray(0, bytesRead), 0, maxBytes)
      return { text: page.text, nextOffset: afterOffset + page.nextOffset, logBytes: size }
    } finally {
      await handle.close()
    }
  }

  /** Main's login for the service works; checked at most once a minute, by one probe shared between callers.
   * A probe that fails to run keeps the last good answer and is retried on the next call. */
  ready(): Promise<boolean> {
    if (this.checked && Date.now() - this.checked.at < 60_000) return Promise.resolve(this.checked.ready)
    this.readinessProbe ??= this.probeReadiness().finally(() => { this.readinessProbe = undefined })
    return this.readinessProbe
  }

  /** Selection uses the cached observation while the shared, bounded login probe refreshes it. */
  readinessSnapshot(): boolean {
    void this.ready().catch(error => {
      logIgnoredError('jobs', 'refresh CI provider readiness', error, { provider: this.provider.id })
    })
    return this.checked?.ready ?? false
  }

  private async probeReadiness() {
    let ready: boolean
    try { ready = await this.provider.ready() }
    catch (error) {
      logIgnoredError('jobs', 'check CI provider readiness', error, { provider: this.provider.id })
      this.readinessObserved = failedReadObservation(this.readinessObserved, error,
        `${this.provider.label} readiness check failed`)
      return this.checked?.ready ?? false
    }
    this.checked = { at: Date.now(), ready }
    this.readinessObserved = successfulReadObservation()
    return ready
  }

  private path(runId: string, name: 'meta.json' | 'log') { return join(this.root, 'runs', runId, name) }

  private async read(runId: string): Promise<CloudRun> {
    return this.checkAccount(await readCloudRun(this.path(runId, 'meta.json')))
  }

  private checkAccount(run: CloudRun): CloudRun {
    if (this.provider.id === 'circleci' && (run.circleAccountId ?? 'default') !== (this.provider.circleAccountId ?? 'default')) {
      throw new DomainError('CI_CLOUD_ACCOUNT_MISMATCH', 'This saved CI run belongs to a different CircleCI login.', 409)
    }
    return run
  }

  private async save(run: CloudRun) {
    const transport = this.provider.transport ?? run.transport
    const saved = await saveCloudRun(this.path(run.runId, 'meta.json'), { ...run, ...(transport ? { transport } : {}),
      ...(this.provider.id === 'circleci' ? { circleAccountId: this.provider.circleAccountId ?? 'default' } : {}) })
    if (this.provider.id === 'circleci' && this.standby && !['starting', 'running'].includes(saved.state)
      && !cancellationPending(saved) && !unresolvedCloudAttemptIds(saved).length && !saved.dispatch?.uncertain) {
      await this.standby.finishCreditProbe(this.provider.account?.owner ?? saved.mirror.split('/')[0]!,
        this.provider.circleAccountId ?? 'default', saved.runId)
    }
    return saved
  }

  private view(run: CloudRun, logBytes: number): CiHostRun {
    let step: string | null = run.part ?? run.suite
    if (run.state === 'running' && run.live?.step) step = run.live.step
    if (run.state === 'running' && run.providerQueuedAt) step = 'queued'
    if (run.state === 'starting') step = run.mirrorPublication?.state === 'pending' ? 'publish mirror' : 'dispatch'
    if (run.state === 'queued') step = null
    let collection: CiHostRun['collection']
    if (run.state === 'failed' && !run.dispatch?.attempts && !run.providerRunId) collection = 'unsupported'
    else if (run.collection?.unavailableAt) collection = 'unsupported'
    else if (run.collection) collection = run.collection.log && run.collection.artifacts ? 'complete' : 'pending'
    const transport = this.provider.transport ?? run.transport
    const message = transport?.source === 'cli'
      ? [`CLI transport: ${transport.reason} (fallback count ${transport.fallbackCount}).`, run.message]
        .filter(Boolean).join(' ').slice(0, 2000) : run.message
    return { runId: run.runId, state: run.state, step,
      ...(this.provider.id === 'circleci' ? { executorCleanupPending: unresolvedCloudAttemptIds(run).length > 0 } : {}),
      ...(run.selection ? { selection: run.selection } : {}),
      ...(transport ? { transport } : {}),
      exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, logBytes, message: message === null ? null : sanitizeCiText(message),
      ...(run.provenance ? { provenance: run.provenance } : {}),
      ...(run.mirrorPublication ? { mirrorPublication: run.mirrorPublication } : {}),
      ...(run.testsStarted !== undefined ? { testsStarted: run.testsStarted } : {}),
      ...(collection ? { collection } : {}) }
  }

  private async start(request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiHostRun> {
    const existing = await this.read(request.runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
      throw error
    })
    if (existing) {
      if (existing.publicationRequest && existing.state === 'starting') this.publishInBackground(existing)
      return this.view(existing, 0)
    }
    if (!this.provider.userSystemd.supported && request.suite === 'integration'
      && (request.partition?.hostIndexes?.includes(request.partition.index)
      || !request.partition && request.files?.some(requiresUserSystemd))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${this.provider.label} cannot run user-systemd files: ${this.provider.userSystemd.reason ?? 'user systemd is unavailable'}.`, 409)
    }
    let mirror = request.ciMirror ?? null
    if (request.ciMirror === undefined && request.workspaceId) mirror = await this.mirrors(request.workspaceId)
    if (mirror && !this.accountMirror(mirror)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `${this.provider.label} has no copy of the CI mirror ${mirror}.`, 409)
    }
    if (mirror) mirror = this.accountMirror(mirror)
    if (mirror) await this.requireNewStart(mirror.slice(mirror.indexOf('/') + 1))
    // CircleCI's machine image has no podman, which the Worker unit tests (unit-other) use.
    if (this.provider.id === 'circleci' && !runsOnCircleCi(request)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `${this.provider.label} cannot run the Worker unit tests (no podman).`, 409)
    }
    if (!mirror || !await this.ready()) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `This workspace has no CI mirror, or Main is not logged in to ${this.provider.label}.`, 409)
    }
    const startedAt = this.ports.now().toISOString()
    const pending = await this.save({ runId: request.runId, repository: request.repository, mirror,
      commit: request.commit, suite: request.suite, startedAt, state: 'starting', providerRunId: null,
      finishedAt: null, exitCode: null, message: 'Publishing the checked CI mirror snapshot.',
      dispatch: { attempts: 0, at: startedAt, uncertain: false, notSent: true },
      publicationRequest: request, mirrorPublication: { state: 'pending', startedAt, finishedAt: null } })
    if (request.deferMirror) {
      this.publishInBackground(pending)
      return this.view(pending, 0)
    }
    try {
      return await this.publishAndStart(request, mirror)
    } catch (error) {
      await this.recordStartFailure(request.runId, error)
      throw error
    }
  }

  private async recordStartFailure(runId: string, error: unknown,
    request?: Extract<CiHostRequest, { operation: 'start' }>) {
    const latest = await this.read(runId)
    if (latest.state !== 'starting') return
    if (this.stopped && request && !latest.dispatch?.attempts && !latest.providerRunId && !latest.dispatchHistory?.length) {
      // Our own shutdown interrupted publication before any submission; the next API process publishes it again.
      await this.save({ ...latest, publicationRequest: request, message: 'Publishing the checked CI mirror snapshot.',
        mirrorPublication: { ...latest.mirrorPublication!, state: 'pending', finishedAt: null } })
      return
    }
    if (latest.dispatch?.attempts || latest.providerRunId || latest.dispatchHistory?.length) {
      const message = latest.dispatch?.notSent && !latest.dispatch.uncertain
        ? 'Cloud submission was not sent; start admission will be retried.'
        : 'Cloud dispatch reply was not confirmed; ownership retained.'
      await this.save({ ...latest, message })
      return
    }
    const unavailable = error instanceof DomainError && error.code === 'CI_CLOUD_UNAVAILABLE'
    const message = sanitizeCiText(error instanceof Error ? error.message : String(error)).slice(0, 2000)
    const failed: CloudRun = { ...latest, state: unavailable ? 'queued' : 'failed',
      finishedAt: unavailable ? null : this.ports.now().toISOString(), message,
      ...(error instanceof DomainError && error.code === 'CI_CLOUD_FAILED' ? { testsStarted: false } : {}),
      mirrorPublication: { ...latest.mirrorPublication!, state: 'failed', finishedAt: this.ports.now().toISOString() } }
    delete failed.publicationRequest
    await this.save(failed)
  }

  private publishInBackground(run: CloudRun) {
    const key = `${this.root}\n${run.runId}`
    if (pendingPublications.has(key) || this.stopped) return
    const request = run.publicationRequest!
    const task = this.publishAndStart(request, run.mirror).then(() => undefined).catch(async error => {
      log.warn({ err: error, runId: run.runId }, 'CI mirror publication failed')
      await this.serializeRun(run.runId, () => this.recordStartFailure(run.runId, error, request))
    }).catch(error => {
      log.error({ err: error, runId: run.runId }, 'CI mirror failure could not be recorded; recovery will retry')
    }).finally(() => {
      pendingPublications.delete(key)
    })
    pendingPublications.set(key, task)
  }

  private async publishAndStart(request: Extract<CiHostRequest, { operation: 'start' }>, mirror: string) {
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    const branchName = deriveFiles && request.baseCommit ? `ci/${request.commit}-${request.baseCommit}`
      : `ci/${request.commit}`
    const reservations = publishingBranches.get(mirror) ?? new Set<string>()
    // Keep each start separately: releasing one partition must not release a concurrent one.
    const reservation = `${request.runId}\n${branchName}`
    reservations.add(reservation)
    const executionReservation = `${request.runId}\nci/${request.commit}-${request.runId}`
    if (this.provider.id === 'circleci') reservations.add(executionReservation)
    publishingBranches.set(mirror, reservations)
    const maintenance = mirrorMaintenance.get(this.mirrorKey(request.repository, mirror))
    if (maintenance?.cleanup) {
      maintenance.keep.add(branchName)
      if (this.provider.id === 'circleci') maintenance.keep.add(`ci/${request.commit}-${request.runId}`)
      maintenance.keep.add(`ci-default/${request.commit}`)
    }
    try {
      const publication = await this.publish(request.repository, mirror, request.commit,
        deriveFiles && !request.baseCommit ? request.defaultBranch ?? 'main' : undefined,
        deriveFiles ? request.baseCommit : undefined, request.durations ?? {}, request.partition !== undefined,
        request.integrationCoverage)
      if (request.deferMirror) {
        return await this.serializeRun(request.runId, async () => {
          const latest = await this.read(request.runId)
          const completed = { ...latest, mirrorPublication: publication.mirrorPublication }
          delete completed.publicationRequest
          await this.save(completed)
          if (latest.cancellation) return this.view(await this.cancelAttempts(completed), 0)
          if (latest.state !== 'starting') return this.view(completed, 0)
          return this.startPublished(request, mirror, publication)
        })
      }
      return await this.startPublished(request, mirror, publication)
    } finally {
      reservations.delete(reservation)
      reservations.delete(executionReservation)
      if (!reservations.size) publishingBranches.delete(mirror)
    }
  }

  private async startPublished(request: Extract<CiHostRequest, { operation: 'start' }>,
    mirror: string, publication: Publication): Promise<CiHostRun> {
    const { git, branch, snapshot, workflowRef, defaultBranch, baseCommit, mirrorPublication } = publication
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    this.schedulePrune({ repository: request.repository, mirror })
    const selectOnRunner = deriveFiles && (defaultBranch !== undefined || baseCommit !== undefined)
    const message = deriveFiles && !selectOnRunner
      ? 'Running full suite: ' + (request.baseCommit
        ? 'baseCommit is unavailable or is not an ancestor of the resolved commit.'
        : 'No merge-base with the workspace default branch is available.') : null
    let slice = request.suite === 'integration' && !selectOnRunner
      && (request.gate || request.partition || !deriveFiles && scope === 'affected')
      ? await this.slice(git, snapshot, request.partition, request.durations ?? {}, request.files) : ''
    if ((!request.files || scope !== 'affected') && request.partition && request.part) {
      slice = `${request.partition.index + 1}/${request.partition.count}`
    }
    const files = scope === 'affected' && request.files !== undefined && request.suite !== 'integration'
      ? await this.selectedIndexes(git, snapshot, request.files) : undefined
    // The snapshot carries learned timings even when a provider parameter cannot hold them.
    const limit = this.provider.parameterLimit ?? Number.POSITIVE_INFINITY
    let partition = selectOnRunner && request.partition ? JSON.stringify(request.partition) : undefined
    if (slice.length > limit && request.suite === 'integration' && request.partition
      && (scope === 'full' || message !== null) && request.files === undefined) {
      slice = ''
      partition = JSON.stringify(request.partition)
    }
    const durations = selectOnRunner && request.durations ? JSON.stringify(request.durations) : undefined
    const input: CloudDispatchInput = { mirror, branch, workflowRef, workflowCommit: snapshot, runId: request.runId, suite: request.part ?? request.suite, slice,
      expectedDurationMs: request.expectedDurationMs ?? 0,
      ...(request.gate ? { gate: true } : {}),
      scope: message ? 'full' : scope, ...(files !== undefined ? { files } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(partition ? { partition } : {}),
      ...(durations && durations.length <= limit ? { durations } : {}) }
    // Complete timings are in the snapshot; omit the duplicate when JSON escaping exceeds GitHub's input budget.
    if (this.provider.id === 'github' && Buffer.byteLength(JSON.stringify(input)) > GITHUB_INPUT_LIMIT_BYTES) {
      delete input.durations
    }
    if (this.provider.id === 'circleci') {
      input.workflowRef = `ci/${request.commit}-${request.runId}`
      if ([input.slice, input.files, input.partition].some(value => value && value.length > limit)) {
        input.workflowCommit = await this.dispatchSnapshot(publication, input)
      }
      await pushMirror(git, ['push', '--quiet', `https://github.com/${mirror}.git`,
        `${input.workflowCommit}:refs/heads/${input.workflowRef}`], { mirror, commit: request.commit })
    }
    validateProviderParameters(this.provider, input)
    await this.requireNewStart(mirror.slice(mirror.indexOf('/') + 1))
    let run = await this.save({ mirrorBranch: branch, runId: request.runId, repository: request.repository, mirror, commit: request.commit,
      suite: request.suite, ...(request.part ? { part: request.part } : {}), startedAt: this.ports.now().toISOString(), providerRunId: null, state: 'starting',
      scope, ...(request.files !== undefined ? { files: request.files } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      provenance: { sourceCommit: request.commit, workflowCommit: input.workflowCommit!, workflowRef: input.workflowRef! },
      finishedAt: null, exitCode: null, message,
      mirrorPublication: { ...mirrorPublication, snapshotCommit: input.workflowCommit! },
      dispatch: { input, attempts: 0, at: this.ports.now().toISOString(), uncertain: false, notSent: true } })
    run = await this.trigger(run, input)
    if (run.providerRunId) {
      try {
        if (await this.provider.find(run)) run = await this.save({ ...run, state: 'running', workflowStarted: true })
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CI_CLOUD_PIPELINE_FAILED') {
          run = await this.failProviderPipeline(run, error)
        } else if (error instanceof DomainError
          && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE'].includes(error.code)) {
          run = await this.reconcileLookupFailure(run, error)
        } else {
          // The trigger was accepted, so a lookup failure must not dispatch the ticket to another computer.
          log.warn({ err: error, runId: run.runId }, 'Cloud CI workflow lookup failed; dispatch remains pending')
        }
      }
    }
    return this.view(run, 0)
  }

  private async dispatchSnapshot(publication: Publication, input: CloudDispatchInput) {
    const { git, snapshot } = publication
    const data = canonicalJson({ commit: snapshot, slice: input.slice,
      files: input.files ?? '', partition: input.partition ?? '' })
    const hash = createHash('sha256').update(data).digest('hex')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(this.root, 'dispatch-'))
    try {
      const path = join(directory, 'inputs.json')
      await writeFile(path, data, { mode: 0o600 })
      const blob = await git(['hash-object', '-w', path])
      const env = { GIT_INDEX_FILE: join(directory, 'index') }
      await git(['read-tree', snapshot], env)
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},ci-dispatch-inputs.json`], env)
      const tree = await git(['write-tree'], env)
      const date = await git(['show', '-s', '--format=%cI', snapshot])
      const identity = { GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid', GIT_COMMITTER_DATE: date }
      const commit = await git(['commit-tree', tree, '-p', snapshot, '-m', 'CI dispatch inputs'], identity)
      await publication.guard(commit)
      input.slice = ''
      delete input.files
      input.partition = `sha256:${hash}`
      return commit
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async trigger(run: CloudRun, input: CloudDispatchInput) {
    let pending = await this.save({ ...run, state: 'starting', providerRunId: null,
      dispatch: { input, attempts: (run.dispatch?.attempts ?? 0) + 1, at: this.ports.now().toISOString(),
        uncertain: false, notSent: true } })
    if (this.provider.id === 'circleci') {
      const failed = await readCloudRun(this.configErrorPath(pending)).catch(error => {
        if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
        throw error
      })
      if (failed) return this.failPipeline(pending, { message: this.checkAccount(failed).message! })
    }
    try {
      pending = await this.save({ ...pending, dispatch: { ...pending.dispatch!, uncertain: true, notSent: false } })
      // Check policy after the final journal write, immediately before contacting the provider.
      const firstDispatch = !run.providerRunId && ((run.dispatch?.attempts ?? 0) === 0 || run.dispatch?.notSent)
        && !run.dispatch?.uncertain
      if (firstDispatch || this.provider.id === 'circleci' && this.standby) {
        const retryUnsent = (run.dispatch?.attempts ?? 0) > 0
          && run.dispatch?.notSent === true && run.dispatch.uncertain === false
        await this.requireNewStart(input.mirror.slice(input.mirror.indexOf('/') + 1), {
          runId: pending.runId, ...(retryUnsent ? { retryUnsent: true as const } : {}),
        })
      }
    } catch (error) {
      pending = await this.save({ ...pending, dispatch: { ...pending.dispatch!, uncertain: false, notSent: true } })
      if (!(error instanceof DomainError && error.code === 'CI_CLOUD_UNAVAILABLE')) throw error
      return this.failPipeline(pending, { message: error.message })
    }
    let providerRunId: string | null
    try {
      providerRunId = await this.provider.dispatch(input)
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      const throttled = error.code === 'CI_CLOUD_RATE_LIMITED'
      const notSent = error.code === 'CI_CLOUD_DISPATCH_NOT_SENT' || throttled && error.details?.notSent === true
      if (!notSent) throw error
      const rejected = await this.save({ ...pending, message: sanitizeCiText(error.message),
        dispatch: { ...pending.dispatch!, uncertain: false, notSent: true } })
      if (throttled) this.pausePolling(run.runId)
      return rejected
    }
    return this.save({ ...pending, providerRunId, dispatch: { ...pending.dispatch!, uncertain: false }, dispatchHistory: [...pending.dispatchHistory ?? [],
      { at: pending.dispatch!.at, providerRunId }] })
  }

  private configErrorPath(run: CloudRun) {
    const key = createHash('sha256').update(canonicalJson({ mirror: run.mirror, commit: run.commit })).digest('hex')
    return join(this.root, 'config-errors', `${key}.json`)
  }

  private async failProviderPipeline(run: CloudRun, error: DomainError): Promise<CloudRun> {
    if (error.details?.creditRefused === true && this.standby) {
      const owner = this.provider.account?.owner ?? run.mirror.split('/')[0]!
      await this.standby.recordCreditRefusal(owner, this.provider.circleAccountId, run.runId)
    }
    return this.failPipeline(run, { message: error.message, configError: error.details?.configError === true })
  }

  private async failPipeline(run: CloudRun, failure: { message: string; configError?: boolean }): Promise<CloudRun> {
    if (this.provider.id === 'circleci' && run.providerRunId) {
      run = await this.recordTerminatedAttempt(run, run.providerRunId,
        { done: true, conclusion: 'failure', finishedAt: this.ports.now().toISOString() })
    }
    const failed: CloudRun = { ...run, state: 'failed', exitCode: 1, finishedAt: this.ports.now().toISOString(),
      message: sanitizeCiText(failure.message), testsStarted: false, collection: { log: true, artifacts: true } }
    delete failed.reconciliation
    // A rejected pipeline has no job logs or artifacts; keep the provider error as its final log.
    await writeFile(this.path(run.runId, 'log'), `${failed.message}\n`, { flag: 'a', mode: 0o600 })
    if (failure.configError) await saveCloudRun(this.configErrorPath(failed), failed)
    return this.save(failed)
  }

  private async adoptSubmission(run: CloudRun): Promise<CloudRun> {
    if (this.provider.id === 'github' && run.dispatch?.uncertain) {
      const providerRunId = run.providerRunId ?? await this.provider.find(run)
      if (!providerRunId) return run
      const history = [...run.dispatchHistory ?? []]
      if (!history.some(attempt => attempt.providerRunId === providerRunId)) {
        history.push({ at: run.dispatch.at, providerRunId })
      }
      return this.save({ ...run, providerRunId, dispatch: { ...run.dispatch, uncertain: false },
        dispatchHistory: history })
    }
    if (this.provider.id !== 'circleci' || run.providerRunId || !run.dispatch?.attempts
      || run.dispatch.uncertain === false) return run
    const discovered = await this.provider.discover!(run)
    const known = new Set(run.dispatchHistory?.map(attempt => attempt.providerRunId))
    const matches = discovered.filter(id => !known.has(id))
    if (matches.length > 1) {
      throw new DomainError('CI_CLOUD_SUBMISSION_UNCERTAIN',
        'Multiple CircleCI pipelines match the pending submission; ownership retained.', 503)
    }
    if (!matches.length) return run
    const providerRunId = matches[0]!
    return this.save({ ...run, providerRunId, dispatch: { ...run.dispatch, uncertain: false },
      dispatchHistory: [...run.dispatchHistory ?? [], { at: run.dispatch.at, providerRunId }] })
  }

  private async recoverUnstarted(run: CloudRun) {
    if (run.dispatch?.uncertain) {
      return this.save({ ...run, message: 'Cloud submission is unconfirmed; discovering the pipeline before retrying.' })
    }
    const dispatchedAt = run.dispatch?.at ?? run.mirrorPublication?.finishedAt ?? run.startedAt
    if (this.ports.now().getTime() - Date.parse(dispatchedAt) < CLOUD_START_TIMEOUT_MS) return run
    // Request cancellation and verify the accepted pipeline before replacing it.
    if (run.providerRunId) {
      if (!run.dispatch?.cancelAccepted || run.emptyPipelineCancellations?.[run.providerRunId]) {
        let accepted: boolean
        try {
          const cancellation = await this.requestCancellation(run, run.providerRunId)
          run = cancellation.run
          accepted = cancellation.accepted
        } catch (error) {
          if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') throw error
          return this.reconcileLookupFailure(run, error)
        }
        if (accepted && run.dispatch) {
          run = await this.save({ ...run, dispatch: { ...run.dispatch, cancelAccepted: true } })
        }
      }
      const status = await this.provider.status(run)
      if (!status.done) {
        return this.save({ ...run,
          message: `${this.provider.label} cancellation is unconfirmed; waiting before retrying dispatch.` })
      }
      if (status.conclusion !== 'cancelled' && !status.notStarted) {
        return this.save({ ...run, state: 'running', workflowStarted: true })
      }
      run = await this.recordTerminatedAttempt(run, run.providerRunId!, status)
    }
    return this.retryUnstarted(run)
  }

  private async retryUnstarted(run: CloudRun) {
    const retryInput = run.dispatch && run.dispatch.attempts < MAX_DISPATCH_ATTEMPTS ? run.dispatch.input : undefined
    const message = `${this.provider.label} created no workflow within 75 seconds. `
      + (retryInput ? `Retrying dispatch (${run.dispatch!.attempts + 1}/${MAX_DISPATCH_ATTEMPTS}).`
        : 'Dispatch retries exhausted; queued for another computer.')
    await writeFile(this.path(run.runId, 'log'), sanitizeCiText(`${message}\n`), { flag: 'a', mode: 0o600 })
    const recovered = { ...run, message }
    delete recovered.reconciliation
    const next = await this.save(recovered)
    if (retryInput) return this.trigger(next, retryInput)
    return this.save({ ...next, state: 'queued', providerRunId: null, finishedAt: null, exitCode: null,
      cancellation: { at: this.ports.now().toISOString(), canceledIds: [] } })
  }

  private async requestCancellation(run: CloudRun, providerRunId: string) {
    const result = await this.provider.cancel({ ...run, providerRunId })
    const observations = { ...run.emptyPipelineCancellations }
    if (result && typeof result === 'object') {
      const now = this.ports.now()
      const since = observations[providerRunId] ?? now.toISOString()
      observations[providerRunId] = since
      run = await this.save({ ...run, emptyPipelineCancellations: observations })
      return { run, accepted: now.getTime() - Date.parse(since) >= CIRCLE_EMPTY_PIPELINE_RECHECK_MS }
    }
    if (observations[providerRunId]) {
      delete observations[providerRunId]
      run = await this.save({ ...run, emptyPipelineCancellations: observations })
    }
    return { run, accepted: result !== false }
  }

  private async reconcileAcceptedAttempts(run: CloudRun) {
    let pending = false
    for (const providerRunId of unresolvedCloudAttemptIds(run)) {
      try {
        const status = await this.provider.status({ ...run, providerRunId })
        if (status.done) {
          run = await this.recordTerminatedAttempt(run, providerRunId, status)
          continue
        }
        const cancellation = await this.requestCancellation(run, providerRunId)
        run = cancellation.run
        const stopped = await this.provider.status({ ...run, providerRunId })
        if (!stopped.done) pending = true
        else run = await this.recordTerminatedAttempt(run, providerRunId, stopped)
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'CI_CLOUD_PIPELINE_FAILED')) throw error
        log.warn({ err: error, runId: run.runId, providerRunId }, 'Previous cloud pipeline failed')
        const failure = { message: error.message, configError: error.details?.configError === true }
        run = { ...run, dispatchHistory: (run.dispatchHistory ?? []).map(attempt =>
          attempt.providerRunId === providerRunId ? { ...attempt, failure } : attempt) }
        run = await this.recordTerminatedAttempt(run, providerRunId,
          { done: true, conclusion: 'failure', finishedAt: this.ports.now().toISOString() })
      }
    }
    return { run, pending }
  }

  private async recordTerminatedAttempt(run: CloudRun, providerRunId: string, status: CloudStatus) {
    if (!status.done || status.terminationUnconfirmed || !run.dispatchHistory) return run
    const observations = { ...run.emptyPipelineCancellations }
    delete observations[providerRunId]
    return this.save({ ...run, emptyPipelineCancellations: observations,
      dispatchHistory: run.dispatchHistory.map(attempt => attempt.providerRunId === providerRunId
      ? { ...attempt, terminated: true as const } : attempt) })
  }

  private mirrorKey(repository: string, mirror: string) {
    return `${this.git.cloneDirectory(repository)}\n${mirror}`
  }

  private publications(repository: string, mirror: string) {
    const key = this.mirrorKey(repository, mirror)
    let publications = mirrorPublications.get(key)
    if (!publications) {
      publications = new Map<string, Promise<Publication>>()
      mirrorPublications.set(key, publications)
    }
    return publications
  }

  private schedulePrune(run: Pick<CloudRun, 'repository' | 'mirror'>, finishedRunId?: string) {
    const key = this.mirrorKey(run.repository, run.mirror)
    const maintenance: MirrorMaintenance = mirrorMaintenance.get(key)
      ?? { at: -Infinity, cleanup: undefined, keep: new Set<string>(), pendingFinishedRuns: new Set<string>() }
    mirrorMaintenance.set(key, maintenance)
    const now = this.ports.now().getTime()
    if (maintenance.cleanup) {
      if (finishedRunId) maintenance.pendingFinishedRuns.add(finishedRunId)
      return
    }
    if (now - maintenance.at < PRUNE_INTERVAL_MS) return
    const finishedRuns = new Set(maintenance.pendingFinishedRuns)
    if (finishedRunId) finishedRuns.add(finishedRunId)
    maintenance.pendingFinishedRuns.clear()
    maintenance.keep.clear()
    for (const reservation of publishingBranches.get(run.mirror) ?? []) {
      const branch = reservation.split('\n')[1]!
      maintenance.keep.add(branch)
      maintenance.keep.add(`ci-default/${branch.slice('ci/'.length).split('-')[0]}`)
    }
    const cleanup = this.prune(run, finishedRuns)
    maintenance.at = now
    maintenance.cleanup = cleanup
    void cleanup.then(() => {
      maintenance.cleanup = undefined
      if (maintenance.pendingFinishedRuns.size) {
        maintenance.at = -Infinity
        this.schedulePrune(run)
      }
    })
  }

  private async siblingRoots(): Promise<string[]> {
    const parent = dirname(this.root)
    const entries = await readdir(parent, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && /^(github|circleci)(?:[~@]|$)/.test(entry.name))
      .map(entry => join(parent, entry.name))
  }

  private async prune(run: Pick<CloudRun, 'repository' | 'mirror'>, finishedRuns: ReadonlySet<string>) {
    try {
      const clone = await ensureClone(this.git, run.repository, AbortSignal.timeout(120_000))
      let activeRuns = await this.activeRuns?.()
      if (activeRuns && finishedRuns.size) {
        const ids = new Set(activeRuns.ids)
        for (const runId of finishedRuns) ids.delete(runId)
        activeRuns = { ...activeRuns, ids }
      }
      const publications = this.publications(run.repository, run.mirror)
      const reserved = mirrorMaintenance.get(this.mirrorKey(run.repository, run.mirror))!.keep
      await pruneMirrorBranches({ mirror: run.mirror, activeRuns,
        roots: [this.root, ...await this.siblingRoots()],
        // Starts during this sweep stay protected even after their reservation becomes a persisted ticket.
        keep: () => reserved,
        withRemovalLock: remove => serializeMirror(run.mirror, remove),
        beforeRemove: branches => {
          const removed = new Set(branches)
          for (const key of publications.keys()) {
            const [commit, , baseCommit] = key.split('\n')
            const branch = baseCommit ? `ci/${commit}-${baseCommit}` : `ci/${commit}`
            if (removed.has(branch) || removed.has(`ci-default/${commit}`)) publications.delete(key)
          }
        },
        git: async args => {
          const result = await this.git.git(args, { cwd: clone, signal: AbortSignal.timeout(120_000) })
          if (result.code !== 0) throw new Error(`CI mirror branch cleanup failed: ${result.stderr.trim().slice(-500)}`)
          return result.stdout.trim()
        } })
    } catch (error) {
      log.warn({ operation: 'clean retained CI mirror branches', err: error, mirror: run.mirror }, 'CI mirror branch cleanup failed; next ticket read will retry')
    }
  }

  /** Puts the commit's files on the mirror once: every partition of a run starting together shares one push. A start
   * that splits its files on the runner (`exact`) needs a snapshot with exactly its learned durations; any other start
   * only orders its files by them, so it reuses whichever snapshot of the commit is already there. */
  private async publish(repository: string, mirror: string, commit: string, defaultBranch: string | undefined,
    baseCommit: string | undefined, durations: CiDurations, exact: boolean, coverage?: CiCoverageSelection) {
    return serializeMirror(mirror, () => this.publishLocked(repository, mirror, commit,
      defaultBranch, baseCommit, durations, exact, coverage))
  }

  private async publishLocked(repository: string, mirror: string, commit: string, defaultBranch: string | undefined,
    baseCommit: string | undefined, durations: CiDurations, exact: boolean, coverage?: CiCoverageSelection) {
    const coverageKey = coverage ? createHash('sha256').update(canonicalJson(coverage)).digest('hex') : ''
    const prefix = `${commit}\n${defaultBranch ?? ''}\n${baseCommit ?? ''}\n${coverageKey}\n`
    const key = `${prefix}${canonicalJson(durations)}`
    const publications = this.publications(repository, mirror)
    let published = publications.get(key)
      ?? (exact ? undefined : [...publications].find(([candidate]) => candidate.startsWith(prefix))?.[1])
    if (!published) {
      const queued = (mirrorPushes.get(mirror) ?? Promise.resolve()).catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
      const queuedAt = performance.now()
      const startedAt = this.ports.now().toISOString()
      // Only the mirror clone and its refs are shared; the commit's source fetch need not wait behind another push.
      const source = ensureCommit(this.git, repository, commit, AbortSignal.timeout(600_000))
      source.catch(() => { /* ignore: the push awaits the source and reports its failure */ })
      const pushed = queued.then(() => this.push(repository, mirror, commit, defaultBranch, baseCommit, durations,
        { queuedAt, startedAt, source }, coverage))
      published = pushed
      mirrorPushes.set(mirror, pushed)
      void pushed.catch(() => { /* ignore: the push failure is reported to the caller awaiting it; this only clears the queue entry */ }).then(() => { if (mirrorPushes.get(mirror) === pushed) mirrorPushes.delete(mirror) })
      publications.set(key, published)
      // A failed push is retried by the next start; a done one is kept for the run's later partitions.
      published.catch(() => { publications.delete(key) })
      if (publications.size > 50) publications.delete(publications.keys().next().value!)
    }
    const publication = await published
    const workflow = this.provider.id === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    if (!publication.workflows.includes(workflow)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `The CI mirror has no ${workflow} workflow for ${this.provider.label}. Use a build computer or configure the mirror.`, 409)
    }
    return publication
  }

  private async push(repository: string, mirror: string, commit: string, defaultBranch: string | undefined,
    baseCommit: string | undefined, durations: CiDurations, queued: { queuedAt: number; startedAt: string; source: Promise<string> },
    coverage?: CiCoverageSelection) {
    const startedAt = queued.startedAt
    const started = performance.now()
    const queueMs = started - queued.queuedAt
    const signal = AbortSignal.timeout(600_000)
    const clone = await queued.source
    const objects = await this.git.git(['rev-parse', '--git-path', 'objects'], { cwd: clone, signal })
    if (objects.code !== 0) throw new DomainError('CI_CLOUD_FAILED', 'Could not read source objects.', 502)
    const sourceMs = performance.now() - started
    const fetching = performance.now()
    // A separate persistent mirror clone negotiates against public refs only. Source objects are read locally.
    const mirrorClone = await ensureClone(this.git, mirror, signal)
    const sourceObjects = resolve(clone, objects.stdout.trim())
    // Snapshot objects reference source objects, so they live in a daily store beside the mirror clone, never in it:
    // the clone's refs then reach only objects it owns. Yesterday's store stays readable for late partitions.
    // Shared by every service publishing this mirror, so each can build on the main another one pushed.
    const store = join(dirname(this.root), 'snapshot-objects', ...mirror.split('/'))
    const day = (offset: number) => new Date(this.ports.now().getTime() - offset).toISOString().slice(0, 10)
    const snapshotObjects = join(store, day(0))
    await mkdir(snapshotObjects, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(store)) {
      if (entry !== day(0) && entry !== day(86_400_000)) await rm(join(store, entry), { recursive: true, force: true })
    }
    const run = async (args: string[], env: Record<string, string>) => {
      const result = await this.git.git(args, { cwd: mirrorClone, signal: AbortSignal.timeout(600_000), env })
      if (result.code !== 0) {
        // Git's own reason, without any credentials in a URL.
        const detail = result.stderr.replace(/\/\/[^/@\s]+@/g, '//').trim().slice(-500)
        throw new DomainError('CI_CLOUD_FAILED', `git ${args[0]} failed for the CI mirror.${detail ? ` ${detail}` : ''}`, 502)
      }
      return result.stdout.trim()
    }
    const git = (args: string[], env?: Record<string, string>) => run(args, { GIT_OBJECT_DIRECTORY: snapshotObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(mirrorClone, '.git', 'objects'), sourceObjects].join(delimiter), ...env })
    const base = 'refs/remotes/origin/main'
    // Fetch without source alternates: their shallow refs are not negotiation haves the mirror clone can walk.
    const fetch = () => run(['fetch', '--quiet', '--no-tags', 'origin', `+main:${base}`], {})
    let repair: CiMirrorRepair | undefined
    const mirrorKey = `${dirname(this.root)}\n${mirror}`
    let main = pushedMains.get(mirrorKey)
    if (main && (await this.git.git(['cat-file', '-e', `${main}^{commit}`], { cwd: mirrorClone, signal,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: [snapshotObjects, resolve(mirrorClone, '.git', 'objects')].join(delimiter) } })).code !== 0) {
      main = undefined
    }
    if (!main) await fetch().catch(async (error: unknown) => {
      if (!(error instanceof DomainError) || !/could not read|failed to traverse|did not send all necessary objects|bad object|corrupt/i
        .test(error.message)) throw error
      const repairing = performance.now()
      log.warn({ operation: 'repair CI mirror clone', err: error, mirror, commit, attempt: 1 },
        'CI mirror clone is unreadable; rebuilding it once')
      try {
        await rm(mirrorClone, { recursive: true, force: true })
        await ensureClone(this.git, mirror, signal)
        await fetch()
      } finally {
        const elapsedMs = performance.now() - repairing
        updateOperationalFailure('jobs', 'repair CI mirror clone', { elapsedMs })
        repair = { count: 1, reason: 'CI_MIRROR_CORRUPT', repository: mirror, sourceCommit: commit, elapsedMs }
      }
    })
    const reusedSnapshot = main ?? await git(['rev-parse', base])
    let fetchMs = performance.now() - fetching
    const workflow = this.provider.id === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    const workflows = ['.github/workflows/ci.yml', '.circleci/config.yml']
    const entries = (await git(['ls-tree', reusedSnapshot, '--', ...workflows])).split('\n')
      .filter(entry => /^100[0-7]{3} blob [a-f0-9]+\t/.test(entry))
    if (!entries.some(entry => entry.endsWith(`\t${workflow}`))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `The CI mirror has no ${workflow} workflow for ${this.provider.label}. Use a build computer or configure the mirror.`, 409)
    }
    const guarding = performance.now()
    await this.guard(clone, commit, signal)
    const initialGuardMs = performance.now() - guarding
    let guardMs = initialGuardMs
    const snapshotting = performance.now()
    let branchFetchMs = 0
    // A source without the mirror's provider workflows gets the mirror's copies.
    // Source commits are parsed only in their own (shallow) clone; the mirror clone sees their trees.
    const sourceRead = async (args: string[]) => {
      const result = await this.git.git(args, { cwd: clone, signal })
      if (result.code !== 0) throw new DomainError('CI_CLOUD_FAILED', `Could not read source ${args.at(-1)}.`, 502)
      return result.stdout.trim()
    }
    const treeOf = async (sourceCommit: string) => {
      const source = await sourceRead(['rev-parse', `${sourceCommit}^{tree}`])
      const sourceWorkflows = new Set((await git(['ls-tree', source, '--', ...workflows])).split('\n')
        .map(entry => entry.split('\t')[1]))
      const missing = entries.filter(entry => !sourceWorkflows.has(entry.split('\t')[1]))
      if (!missing.length && !Object.keys(durations).length && !coverage) return source
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.root, 'snapshot-'))
      try {
        const env = { GIT_INDEX_FILE: join(directory, 'index') }
        await git(['read-tree', source], env)
        for (const entry of missing) {
          const [mode, , blob, path] = entry.split(/\s+/)
          await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], env)
        }
        if (Object.keys(durations).length) {
          const path = join(directory, 'durations.json')
          await writeFile(path, canonicalJson(durations), { mode: 0o600 })
          const blob = await git(['hash-object', '-w', path])
          await git(['update-index', '--add', '--cacheinfo', `100644,${blob},scripts/ci-learned-durations.json`], env)
        }
        if (coverage) {
          const path = join(directory, 'coverage.json')
          await writeFile(path, canonicalJson(coverage), { mode: 0o600 })
          const blob = await git(['hash-object', '-w', path])
          await git(['update-index', '--add', '--cacheinfo', `100644,${blob},ci-integration-coverage.json`], env)
        }
        return await git(['write-tree'], env)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    // Partition starts share the published snapshot and its timing inputs.
    const date = await sourceRead(['show', '-s', '--format=%cI', commit])
    const author = { GIT_AUTHOR_NAME: mirror.split('/')[0]!, GIT_AUTHOR_EMAIL: `${mirror.split('/')[0]}@users.noreply.github.com`,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    const identity = { ...author, GIT_COMMITTER_NAME: author.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: author.GIT_AUTHOR_EMAIL }
    const snapshotOf = async (source: string, parent: string) => {
      const tree = await git(['rev-parse', await treeOf(source)])
      if (tree === await git(['rev-parse', `${parent}^{tree}`])) return git(['rev-parse', parent])
      return git(['commit-tree', tree, '-p', parent, '-m', `Snapshot ${source.slice(0, 12)}`], identity)
    }
    let parent = reusedSnapshot
    let comparison: { branch: string; commit: string } | undefined
    let runnerBaseCommit: string | undefined
    let head: string | undefined
    if (baseCommit) {
      const isAncestor = async () => (await this.git.git(['merge-base', '--is-ancestor', baseCommit, commit],
        { cwd: clone, signal })).code === 0
      if (await isAncestor() || await deepenUntilConnected(this.git, clone, [commit, baseCommit], isAncestor, signal)) {
        const checking = performance.now()
        await this.guard(clone, baseCommit, signal)
        guardMs += performance.now() - checking
        parent = await snapshotOf(baseCommit, reusedSnapshot)
        runnerBaseCommit = parent
      }
    } else if (defaultBranch) {
      const branchFetching = performance.now()
      const branchHead = await fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
      head = branchHead
      branchFetchMs = performance.now() - branchFetching
      fetchMs += branchFetchMs
      const findMergeBase = () => this.git.git(['merge-base', commit, branchHead], { cwd: clone, signal })
      let mergeBase = await findMergeBase()
      if (mergeBase.code !== 0) {
        await deepenUntilConnected(this.git, clone, [commit, branchHead], async () => (mergeBase = await findMergeBase()).code === 0, signal)
      }
      if (mergeBase.code === 0) {
        const sourceBase = mergeBase.stdout.trim()
        // Publish only checked trees; the source repository's private commit history stays private.
        const checking = performance.now()
        await this.guard(clone, sourceBase, signal)
        await this.guard(clone, head, signal)
        guardMs += performance.now() - checking
        parent = await snapshotOf(sourceBase, reusedSnapshot)
        if (commit !== head) runnerBaseCommit = parent
        comparison = { branch: `ci-default/${commit}`, commit: await snapshotOf(head, parent) }
      }
    }
    let snapshot: string
    if (commit === baseCommit && runnerBaseCommit) snapshot = runnerBaseCommit
    else if (commit === head && comparison) snapshot = comparison.commit
    else snapshot = await snapshotOf(commit, parent)
    const branch = baseCommit ? `ci/${commit}-${baseCommit}` : `ci/${commit}`
    const workflowRef = `ci-snapshot/${snapshot}`
    const snapshotMs = Math.max(0, performance.now() - snapshotting - (guardMs - initialGuardMs) - branchFetchMs)
    const pushing = performance.now()
    pushedMains.delete(mirrorKey)
    await pushMirror(git, ['push', '--quiet', '--force', `https://github.com/${mirror}.git`, `${snapshot}:refs/heads/${branch}`,
      `${snapshot}:refs/heads/main`, `${snapshot}:refs/heads/${workflowRef}`, ...(comparison ? [`${comparison.commit}:refs/heads/${comparison.branch}`] : [])],
    { mirror, commit })
    pushedMains.set(mirrorKey, snapshot)
    const timings = { queueMs, sourceMs, fetchMs, guardMs, snapshotMs, pushMs: performance.now() - pushing,
      totalMs: performance.now() - started + queueMs }
    const mirrorPublication: NonNullable<CiHostRun['mirrorPublication']> = {
      state: 'ready', startedAt, finishedAt: this.ports.now().toISOString(), snapshotCommit: snapshot,
      reusedSnapshot, timings,
      ...(repair ? { repair } : {}),
    }
    log.info({ commit, mirror, timings }, 'CI mirror snapshot published')
    return { git, guard: (commit: string) => this.guard(mirrorClone, commit, AbortSignal.timeout(600_000),
      { GIT_OBJECT_DIRECTORY: snapshotObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(mirrorClone, '.git', 'objects'), sourceObjects].join(delimiter) }),
      branch, snapshot, workflowRef, mirrorPublication, workflows: entries.map(entry => entry.split('\t')[1]!),
      ...(comparison ? { defaultBranch: comparison.branch } : {}),
      ...(runnerBaseCommit ? { baseCommit: runnerBaseCommit } : {}) }
  }

  /** The same duration-balanced slice a build computer would run, from the commit's files and CI database durations, as
   * indexes into the commit's sorted integration files (scripts/ci-files.mjs), so it fits a short CI parameter. */
  private async slice(git: (args: string[]) => Promise<string>, commit: string, partition: CiPartition | undefined,
    learned: CiDurations, selected?: string[]) {
    const files = (await git(['ls-tree', '--name-only', `${commit}:apps/api/test`])).split('\n')
      .filter(name => name.endsWith('.integration.test.ts')).map(name => `apps/api/test/${name}`).sort()
    if (selected?.some(file => !files.includes(file))) {
      throw new DomainError('CI_CLOUD_FAILED', 'Selected integration files are absent from the commit.', 409)
    }
    const candidates = selected ?? files
    const slice = new Set<string>(partition ? integrationPartition(candidates, learned, partition) : candidates)
    if (!this.provider.userSystemd.supported && [...slice].some(requiresUserSystemd)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${this.provider.label} cannot run user-systemd files: ${this.provider.userSystemd.reason ?? 'user systemd is unavailable'}.`, 409)
    }
    if (!slice.size) throw new DomainError('CI_CLOUD_FAILED', 'This partition has no integration files.', 409)
    return this.indexSpec(files, slice)
  }

  private async selectedIndexes(git: (args: string[]) => Promise<string>, commit: string, selected: string[]) {
    const files = (await git(['ls-tree', '-r', '--name-only', commit])).split('\n')
      .filter(file => file !== 'ci-dispatch-inputs.json').sort()
    if (selected.some(file => !files.includes(file))) {
      throw new DomainError('CI_CLOUD_FAILED', 'Selected files are absent from the commit.', 409)
    }
    return this.indexSpec(files, new Set(selected))
  }

  private indexSpec(files: string[], selected: Set<string>) {
    const indexes = files.flatMap((file, index) => selected.has(file) ? [index] : [])
    const ranges: Array<[number, number]> = []
    for (let start = 0; start < indexes.length;) {
      let end = start
      while (end + 1 < indexes.length && indexes[end + 1] === indexes[end]! + 1) end++
      ranges.push([indexes[start]!, indexes[end]!])
      start = end + 1
    }
    // Runners of older commits only know "s:", so it stays the form whenever it fits a short parameter.
    const plain = `s:${ranges.map(([first, last]) => first === last ? `${first}` : `${first}-${last}`).join(',')}`
    if (plain.length <= 400) return plain
    // "d:" lists each range as its base-36 gap from the previous range's end, plus ".<length - 1>" for runs
    // (decoded by selectByIndexes in scripts/ci-files.mjs).
    let next = 0
    return `d:${ranges.map(([first, last]) => {
      const gap = (first - next).toString(36)
      next = last + 1
      return last === first ? gap : `${gap}.${(last - first).toString(36)}`
    }).join(',')}`
  }

  /** Refuses to publish files that name this fleet: Main's home path and user, and every Tailscale computer's
   * name, address and tailnet domain. Only the commit's files are published, so only they are checked. */
  private async guard(clone: string, commit: string, signal: AbortSignal, env?: Record<string, string>) {
    const fixed = new Set<string>([this.identity.home]), words = new Set<string>([this.identity.user])
    const word = (value: string) => { const first = value.toLowerCase().split(/[^a-z0-9]/)[0] ?? ''; if (first.length >= 3) words.add(first) }
    word(this.identity.host)
    const parsed = await readFleetIdentityInventory(this.ports)
    for (const peer of [parsed.Self, ...Object.values(parsed.Peer ?? {})]) {
      for (const address of peer.TailscaleIPs) if (address.includes('.')) fixed.add(address)
      fixed.add(peer.HostName)
      word(peer.HostName)
    }
    if (parsed.MagicDNSSuffix) fixed.add(parsed.MagicDNSSuffix)
    for (const user of Object.values(parsed.User ?? {})) if (user.LoginName?.includes('@')) fixed.add(user.LoginName)
    const found: string[] = []
    for (const [mode, values] of [[['-F'], fixed], [['-w', '-F'], words]] as const) {
      const patterns = [...values].filter(value => value.length >= 3).flatMap(value => ['-e', value])
      if (!patterns.length) continue
      const result = await this.git.git(['grep', '-I', '-n', '-i', '--no-color', ...mode, ...patterns, commit, '--'],
        { cwd: clone, signal, ...(env ? { env } : {}) })
      if (result.code > 1) throw new DomainError('CI_CLOUD_FAILED', 'Main could not check the files for the CI mirror.', 502)
      found.push(...result.stdout.split('\n').filter(Boolean).map(line => line.split(':').slice(1, 3).join(':')))
    }
    if (found.length) {
      throw new DomainError('CI_MIRROR_PRIVATE_DATA', `Not published to the public CI mirror: ${found.slice(0, 10).join(', ')}`
        + `${found.length > 10 ? ` and ${found.length - 10} more` : ''} name this computer fleet (home path, user or computer `
        + 'name, Tailscale address or domain). Replace them with examples.', 409)
    }
  }

  private expectedEnd(run: CloudRun): number {
    const duration = run.dispatch?.input?.expectedDurationMs ?? 0
    if (duration <= 0) return Infinity
    return Date.parse(run.dispatch?.at ?? run.startedAt) + duration
  }

  /** Follows the provider's run at most every few seconds, pausing while the service's rate limit is spent. */
  private async refresh(runId: string, reassign = false): Promise<CloudRun> {
    const run = await this.read(runId)
    if (run.publicationRequest && run.state === 'starting') {
      this.publishInBackground(run)
      return run
    }
    const pendingCollection = collectionPending(run)
    const pendingCancellation = cancellationPending(run)
    const pendingAttempts = unresolvedCloudAttemptIds(run).length > 0
    if (!['starting', 'running'].includes(run.state) && !pendingCancellation && !pendingCollection && !pendingAttempts) return run
    const now = this.ports.now().getTime()
    if (run.reconciliation && now - Date.parse(run.reconciliation.at) < POLL_MS) return run
    if (pendingCollection && !pendingCancellation && !pendingAttempts && run.collection?.retry) {
      if (now - Date.parse(run.collection.retry.since) >= COLLECTION_RECOVERY_MS) return this.collect(run)
      if (now < Date.parse(run.collection.retry.nextAttemptAt)) return run
    }
    if (now < this.backoff.until) return run
    const nearFinish = !pendingAttempts && this.expectedEnd(run) - now <= FINISH_WINDOW_MS
    const interval = nearFinish ? FINISH_POLL_MS : POLL_MS
    if ((pendingCancellation || pendingCollection || pendingAttempts || run.state === 'running' && run.workflowStarted)
      && now - (this.polled.get(runId) ?? -Infinity) < interval) return run
    if (this.following >= POLL_CONCURRENCY) await new Promise<void>(resume => { this.waiting.push({ run, resume }) })
    else this.following++
    try {
      // A poll that waited for its slot skips the service if a rate limit was hit meanwhile.
      if (this.ports.now().getTime() < this.backoff.until) return run
      const generation = this.backoff.generation
      return await withProviderPoll(async () => {
        let next: CloudRun
        if (pendingCancellation) next = await this.cancelAttempts(run)
        else if (pendingCollection || !['starting', 'running'].includes(run.state)) {
          next = (await this.reconcileAcceptedAttempts(run)).run
          this.polled.set(runId, this.ports.now().getTime())
        }
        else next = await this.follow(run, reassign)
        if (next.reconciliation && next.state !== 'starting') {
          const recovered = { ...next,
            message: next.message === run.message ? next.reconciliation.previousMessage : next.message }
          delete recovered.reconciliation
          next = await this.save(recovered)
        }
        if (collectionPending(next)) next = await this.collect(next)
        if (this.backoff.generation === generation) this.backoff = { until: 0, ms: 0, generation }
        return next
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CI_CLOUD_PIPELINE_FAILED') {
        return this.failProviderPipeline(run, error)
      }
      if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') {
        this.pausePolling(runId)
        return this.read(runId)
      }
      const latest = await this.read(runId)
      const lookupFailed = error instanceof DomainError
        && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE'].includes(error.code)
      if (lookupFailed || latest.cancellation?.requeue) return this.reconcileLookupFailure(latest, error)
      throw error
    } finally {
      // The slot passes straight to the next waiting poll.
      this.waiting.sort((left, right) => this.expectedEnd(left.run) - this.expectedEnd(right.run))
      const next = this.waiting.shift()
      if (next) next.resume()
      else this.following--
    }
  }

  private pausePolling(runId: string) {
    const ms = Math.min(MAX_BACKOFF_MS, Math.max(30_000, this.backoff.ms * 2))
    this.backoff = { until: this.ports.now().getTime() + ms, ms, generation: this.backoff.generation + 1 }
    log.warn({ runId, provider: this.provider.id, backoffMs: ms }, 'Cloud CI rate limited; polling paused')
  }

  private async reconcileLookupFailure(run: CloudRun, error: unknown): Promise<CloudRun> {
    const now = this.ports.now()
    const since = run.reconciliation?.since ?? run.reconciliation?.at ?? now.toISOString()
    if (!cancellationPending(run) && ['starting', 'running'].includes(run.state)
      && now.getTime() - Date.parse(since) >= CLOUD_START_TIMEOUT_MS) {
      return this.requeueUnreadable(run, error)
    }
    const attempts = Math.min(MAX_DISPATCH_ATTEMPTS, (run.reconciliation?.attempts ?? 0) + 1)
    const message = `${this.provider.label} execution could not be reconciled: `
      + (error instanceof Error ? error.message : String(error)).slice(0, 500)
      + (cancellationPending(run) ? ' Cancellation could not be confirmed; ownership retained while status reads retry.'
        : ' Retrying lookup for up to 75 seconds before moving to another computer.')
    log.warn({ err: error, runId: run.runId, attempts }, 'Cloud CI execution needs reconciliation')
    return this.save({ ...run, message, reconciliation: { attempts, at: now.toISOString(), since,
      previousMessage: run.reconciliation ? run.reconciliation.previousMessage : run.message } })
  }

  private async requeueUnreadable(run: CloudRun, error: unknown): Promise<CloudRun> {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    const pending = await this.save({ ...run,
      message: sanitizeCiText(`${this.provider.label} execution stayed unreadable past the 75-second window: `
        + `${detail} Cancellation requested; ownership retained until termination is confirmed.`),
      cancellation: { at: this.ports.now().toISOString(), canceledIds: [], requeue: true } })
    try {
      return await this.cancelAttempts(pending)
    } catch (cancelError) {
      if (cancelError instanceof DomainError && cancelError.code === 'CI_CLOUD_RATE_LIMITED') this.pausePolling(run.runId)
      return this.reconcileLookupFailure(await this.read(run.runId), cancelError)
    }
  }

  /** Writes the steps the run has started, and new output of the running step, to its log. */
  private async progress(run: CloudRun, status: CloudStatus): Promise<CloudRun> {
    const live = run.live ?? { step: null, seen: [], bytes: 0 }
    const seen = new Set(live.seen)
    const chunks: Buffer[] = []
    let output = live.output, bytes = live.bytes, step = live.step
    for (const value of status.steps ?? []) {
      if (value.state === 'skipped') continue
      const name = value.name.split('\n')[0]!.trim().slice(0, 80) || value.key
      step = name
      if (!seen.has(value.key)) { seen.add(value.key); chunks.push(Buffer.from(`==> ${name}\n`)) }
      if (value.state === 'failed' && !seen.has(`${value.key}:failed`)) {
        seen.add(`${value.key}:failed`); chunks.push(Buffer.from(`==> ${name} failed\n`))
      }
      if (status.output?.key === value.key) {
        const text = Buffer.from(status.output.text)
        const written = output?.key === value.key ? output.bytes : 0
        if (text.length > written) chunks.push(text.subarray(written))
        output = { key: value.key, bytes: Math.max(written, text.length) }
      }
    }
    let chunk = Buffer.concat(chunks)
    // The provider's whole log is kept at the end, so the live copy stays within the same bound.
    chunk = chunk.subarray(0, Math.max(0, CLOUD_LOG_LIMIT - bytes))
    if (!chunk.length && step === live.step && output?.bytes === live.output?.bytes && seen.size === live.seen.length) return run
    const text = sanitizeCiText(chunk.toString('utf8'))
    if (text.length) await writeFile(this.path(run.runId, 'log'), text, { flag: 'a', mode: 0o600 })
    bytes += Buffer.byteLength(text)
    return this.save({ ...run, lastProgressAt: this.ports.now().toISOString(),
      live: { step, seen: [...seen], ...(output ? { output } : {}), bytes } })
  }

  private stalled(run: CloudRun): boolean {
    if (run.state !== 'running') return false
    const timeout = Math.max(MIN_STALL_MS,
      (run.dispatch?.input?.expectedDurationMs ?? 0) * EXPECTED_DURATION_MULTIPLIER)
    const lastProgress = Date.parse(run.lastProgressAt ?? run.dispatch?.at ?? run.startedAt)
    return this.ports.now().getTime() - lastProgress >= timeout
  }

  /** Reconcile overdue runs and retained terminal work in bounded batches. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileRuns().finally(() => { this.reconciling = undefined })
    return this.reconciling
  }

  private async reconcileRuns(): Promise<void> {
    const entries = await readdir(join(this.root, 'runs'), { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (let offset = 0; offset < Math.min(8, ids.length); offset++) {
      const runId = ids[(this.reconcileCursor + offset) % ids.length]!
      try {
        const run = await this.read(runId)
        if (run.publicationRequest && run.state === 'starting' || this.stalled(run)
          || run.reconciliation && ['starting', 'running'].includes(run.state)
          || cancellationPending(run) || collectionPending(run) || unresolvedCloudAttemptIds(run).length > 0) {
          await this.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
        }
      } catch (error) {
        log.warn({ err: error, runId }, 'Cloud CI recovery remains pending')
      }
    }
    this.reconcileCursor = ids.length ? (this.reconcileCursor + 8) % ids.length : 0
  }

  private async cancelAttempts(run: CloudRun): Promise<CloudRun> {
    if (!cancellationPending(run)) return run
    const canceled = new Set(run.cancellation!.canceledIds)
    const knownIds = new Set([run.providerRunId, ...run.dispatchHistory?.map(attempt => attempt.providerRunId) ?? []]
      .filter((id): id is string => Boolean(id)))
    const known = await this.cancelProviderAttempts(run, knownIds, canceled)
    run = known.run
    const unsent = neverSubmitted(run)
    const uncertainSubmission = run.dispatch?.uncertain === true
      || !run.providerRunId && (run.dispatch?.attempts ?? 0) > 0 && run.dispatch?.uncertain !== false
    const requiresDiscovery = this.provider.id === 'github' || uncertainSubmission
    const discovered = requiresDiscovery && !unsent
      ? await this.provider.discover!(run) : []
    const discoveryComplete = !run.dispatch?.attempts
      || this.ports.now().getTime() - Date.parse(run.cancellation!.at) >= CLOUD_START_TIMEOUT_MS
    // Complete execution-specific discovery also resolves a lost trigger reply when no pipeline was created.
    if (run.dispatch && uncertainSubmission && (discovered.length || discoveryComplete)) {
      run = { ...run, providerRunId: run.providerRunId ?? discovered[0] ?? null,
        dispatch: { ...run.dispatch, uncertain: false } }
    }
    run = await this.save(run)
    const additional = await this.cancelProviderAttempts(run, new Set(discovered.filter(id => !knownIds.has(id))), canceled)
    run = additional.run
    const ids = new Set([...knownIds, ...discovered])
    const absent = requiresDiscovery && ids.size === 0
    const stopped = discoveryComplete && !run.dispatch?.uncertain && known.stopped && additional.stopped
      && (ids.size > 0 || !run.dispatch?.attempts || unsent || absent)
    this.polled.set(run.runId, this.ports.now().getTime())
    const now = this.ports.now().toISOString()
    if (stopped && run.cancellation!.requeue) {
      const message = `${this.provider.label} cancellation confirmed; queued for another computer.`
      const requeued: CloudRun = { ...run, state: 'queued', providerRunId: null, finishedAt: null, exitCode: null, message,
        cancellation: { ...run.cancellation!, canceledIds: [...canceled], completedAt: now } }
      delete requeued.reconciliation
      delete requeued.providerQueuedAt
      delete requeued.queueCancelRequested
      await writeFile(this.path(run.runId, 'log'), `${message}\n`, { flag: 'a', mode: 0o600 })
      return this.save(requeued)
    }
    return this.save({ ...run,
      ...(stopped ? { state: run.state === 'queued' ? 'queued' : 'canceled',
        finishedAt: run.state === 'queued' ? null : now, message: 'Canceled.' } : {}),
      cancellation: { ...run.cancellation!, canceledIds: [...canceled], ...(stopped ? { completedAt: now } : {}) } })
  }

  private async cancelProviderAttempts(run: CloudRun, ids: Set<string>, canceled: Set<string>) {
    let stopped = true
    for (const providerRunId of ids) {
      if (!run.dispatchHistory?.some(attempt => attempt.providerRunId === providerRunId)) {
        run = await this.save({ ...run, dispatchHistory: [...run.dispatchHistory ?? [],
          { at: this.ports.now().toISOString(), providerRunId }] })
      }
      if (!canceled.has(providerRunId) || run.emptyPipelineCancellations?.[providerRunId]) {
        const cancellation = await this.requestCancellation(run, providerRunId)
        run = cancellation.run
        if (cancellation.accepted) canceled.add(providerRunId)
        else canceled.delete(providerRunId)
        run = await this.save({ ...run, cancellation: { ...run.cancellation!, canceledIds: [...canceled] } })
      }
      const status = await this.provider.status({ ...run, providerRunId })
      if (!canceled.has(providerRunId) || !status.done) stopped = false
      run = await this.recordTerminatedAttempt(run, providerRunId, status)
    }
    return { run, stopped }
  }

  private async collect(run: CloudRun): Promise<CloudRun> {
    const now = this.ports.now()
    const since = run.collection!.retry?.since ?? now.toISOString()
    if (now.getTime() - Date.parse(since) >= COLLECTION_RECOVERY_MS) {
      return this.save({ ...run, collection: { ...run.collection!, unavailableAt: now.toISOString() } })
    }
    if (run.collection!.retry && now.getTime() < Date.parse(run.collection!.retry.nextAttemptAt)) return run
    const attempts = (run.collection!.retry?.attempts ?? 0) + 1
    const delayMs = Math.min(60_000, POLL_MS * 2 ** Math.min(attempts - 1, 4))
    const collection = { ...run.collection! }
    try {
      if (!collection.artifacts) {
        try {
          const artifacts = await this.provider.artifacts(run, join(this.root, 'runs', run.runId, 'artifact'))
          if (artifacts.suiteLog !== undefined) {
            const contents = Buffer.from(artifacts.suiteLog).subarray(-CLOUD_LOG_LIMIT)
            await writeFile(this.path(run.runId, 'log'), contents, { mode: 0o600 })
            collection.log = true
          }
          const selection = CiSelectionSchema.safeParse(artifacts.selection)
          if (selection.success) run = { ...run, selection: selection.data }
          const coverage = CiIntegrationCoverageSchema.safeParse(artifacts.integrationCoverage)
          if (run.suite === 'integration' && run.scope === 'full' && coverage.success) {
            const compressed = gzipSync(JSON.stringify(compactIntegrationCoverage(coverage.data))).toString('base64')
            if (compressed.length <= 700_000) run = { ...run, integrationCoverage: compressed }
            else log.warn({ runId: run.runId }, 'Integration coverage exceeds the device report limit')
          }
          if (run.suite === 'integration' || run.suite === 'unit') {
            const durations = CiDurationsSchema.safeParse(artifacts.durations)
            if (durations.success && (run.suite === 'integration' || run.part === 'unit-api' || run.part === 'unit-web')) {
              run = { ...run, durations: durations.data }
            }
            const tests = CiTestResultsSchema.safeParse(artifacts.testResults)
            if (tests.success) run = { ...run, testResults: tests.data }
          }
          const watchdog = CiWatchdogFailureSchema.safeParse(artifacts.watchdogFailure)
          if (watchdog.success && run.state !== 'passed') {
            run = { ...run, message: watchdog.data.message,
              ...(watchdog.data.testsStarted !== undefined ? { testsStarted: watchdog.data.testsStarted } : {}) }
          }
          collection.artifacts = true
        } catch (error) {
          if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') throw error
          log.warn({ err: error, runId: run.runId }, 'Final CI artifacts remain pending')
        }
      }
      // The provider's log is only needed when the artifacts did not carry the suite log, and its download may be slow:
      // it continues in the background while this pass answers.
      if (!collection.log) {
        const text = await this.finalLog(run)
        if (text !== undefined) {
          let contents = Buffer.from(text).subarray(-CLOUD_LOG_LIMIT)
          if (run.live?.bytes) {
            const live = (await readFile(this.path(run.runId, 'log'))).subarray(0, run.live.bytes)
            contents = Buffer.concat([live, Buffer.from(`--- ${this.provider.label} log ---\n`), contents])
          }
          await writeFile(this.path(run.runId, 'log'), contents, { mode: 0o600 })
          collection.log = true
        }
      }
    } finally {
      this.polled.set(run.runId, this.ports.now().getTime())
      if (collection.log && collection.artifacts) delete collection.retry
      else collection.retry = { since, attempts,
        nextAttemptAt: new Date(this.ports.now().getTime() + delayMs).toISOString() }
      run = await this.save({ ...run, collection })
    }
    return run
  }

  /** The provider's final log, or undefined while its download is still running or after it failed. */
  private async finalLog(run: CloudRun): Promise<string | undefined> {
    const key = `${this.root}\n${run.runId}`
    let download = finalLogs.get(key)
    if (!download) {
      download = (async () => this.provider.log(run))().catch((error: unknown) => {
        if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') this.pausePolling(run.runId)
        else log.warn({ err: error, runId: run.runId }, 'Final CI log remains pending')
        return null
      })
      finalLogs.set(key, download)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = await Promise.race([download,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), FINAL_LOG_WAIT_MS) })])
    clearTimeout(timer)
    if (waited === undefined) return undefined
    finalLogs.delete(key)
    return waited ?? undefined
  }

  /** A workflow the provider holds in its own queue is not running. It keeps its place there until Main reports another
   * computer with a free slot; after the start window its cancellation is requested, and only once the provider confirms
   * the cancellation does the ticket go to that computer. A workflow that starts or finishes meanwhile is kept. */
  private async waitInProviderQueue(run: CloudRun, reassign: boolean): Promise<CloudRun> {
    const now = this.ports.now()
    const since = run.providerQueuedAt ?? now.toISOString()
    if (!run.providerQueuedAt) run = await this.save({ ...run, providerQueuedAt: since })
    if (!reassign || run.queueCancelRequested || now.getTime() - Date.parse(since) < CLOUD_START_TIMEOUT_MS) return run
    try {
      const cancellation = await this.requestCancellation(run, run.providerRunId!)
      run = cancellation.run
      if (!cancellation.accepted) return run
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') throw error
      return this.reconcileLookupFailure(run, error)
    }
    return this.save({ ...run, queueCancelRequested: true })
  }

  /** The provider confirmed the cancellation of a workflow it only queued: the ticket goes to another computer. */
  private async requeueCanceledQueue(run: CloudRun): Promise<CloudRun> {
    const message = `${this.provider.label} kept the workflow queued for 75 seconds without starting a job. `
      + 'Canceled; queued for another computer.'
    await writeFile(this.path(run.runId, 'log'), `${message}\n`, { flag: 'a', mode: 0o600 })
    const requeued: CloudRun = { ...run, state: 'queued', finishedAt: null, exitCode: null, message,
      providerRunId: null,
      cancellation: { at: this.ports.now().toISOString(), canceledIds: [run.providerRunId!], completedAt: this.ports.now().toISOString() } }
    delete requeued.providerQueuedAt
    delete requeued.queueCancelRequested
    delete requeued.reconciliation
    return this.save(requeued)
  }

  /** Follows the provider's run; once it finishes, keeps its log, measured durations and test results. */
  private async follow(run: CloudRun, reassign: boolean): Promise<CloudRun> {
    const runId = run.runId
    run = await this.adoptSubmission(run)
    if (neverSubmitted(run)) return this.recoverUnstarted(run)
    const previous = await this.reconcileAcceptedAttempts(run)
    run = previous.run
    if (previous.pending) {
      this.polled.set(runId, this.ports.now().getTime())
      return run
    }
    if (run.state === 'starting' && this.provider.id === 'circleci'
      && (run.dispatch?.cancelAccepted || run.emptyPipelineCancellations?.[run.providerRunId!])) {
      return this.recoverUnstarted(run)
    }
    if (run.state === 'starting' || !run.providerRunId || !run.workflowStarted && this.provider.id === 'circleci') {
      const providerRunId = await this.provider.find(run)
      if (!providerRunId) {
        return this.recoverUnstarted(run)
      }
      run = await this.save({ ...run, providerRunId, state: 'running', workflowStarted: true })
    } else if (this.provider.id === 'github' && (run.dispatch?.attempts ?? 0) > 1) {
      // A delayed workflow from an earlier dispatch can appear after its replacement.
      await this.provider.find(run)
    }
    const status = await this.provider.status(run)
    if (status.executionStarted && this.provider.id === 'circleci' && this.standby) {
      await this.standby.recordCreditAcceptance(this.provider.account?.owner ?? run.mirror.split('/')[0]!,
        this.provider.circleAccountId ?? 'default', runId)
    }
    this.polled.set(runId, this.ports.now().getTime())
    if (!status.done && status.queued) return this.waitInProviderQueue(run, reassign)
    if (run.providerQueuedAt) {
      run = { ...run }
      delete run.providerQueuedAt
      run = await this.save(run)
    }
    run = await this.progress(run, status)
    if (!status.done) return run
    if (this.provider.id === 'circleci') run = await this.recordTerminatedAttempt(run, run.providerRunId!, status)
    this.polled.delete(runId)
    if (run.queueCancelRequested) {
      if (status.conclusion === 'cancelled') return this.requeueCanceledQueue(run)
      // The workflow finished before the cancellation took effect: its result is collected, not rerun.
      run = { ...run }
      delete run.queueCancelRequested
    }
    const passed = status.conclusion === 'success'
    const failedSetup = status.conclusion === 'failure'
      && !status.steps?.some(step => step.name === 'Suite' && step.state !== 'skipped')
      ? status.steps?.find(step => step.state === 'failed') : undefined
    let state: CloudRun['state'] = 'failed'
    if (passed) state = 'passed'
    else if (status.conclusion === 'cancelled') state = 'canceled'
    const failure = failedSetup ? `${this.provider.label}: setup failed at ${failedSetup.name}.`
      : `${this.provider.label}: ${status.conclusion}.`
    const message = passed ? run.message : [run.message, status.message ?? failure].filter(Boolean).join(' ')
    const terminal = await this.save({ ...run, state,
      exitCode: passed ? 0 : 1, finishedAt: status.finishedAt, collection: { log: false, artifacts: false },
      ...(failedSetup || status.notStarted ? { testsStarted: false } : {}),
      message })
    return terminal
  }
}

/** GitHub Actions and CircleCI on the same public mirror. */
export function cloudCis(mainId: string, mirrors: Mirrors,
  options: { ports?: HostCiPorts; activeRuns?: () => Promise<ActiveCiRuns>;
    primaryContext?: CircleAccountContext; explicitCircleOrgs?: boolean } = {}): CloudCi[] {
  const ports = options.ports ?? systemHostCiPorts()
  const context = options.primaryContext
  const primary = new CircleCiProvider(context?.ports ?? ports, context ? { http: context.http } : {})
  primary.recoveryOnly = options.explicitCircleOrgs ?? false
  return [new GitHubActionsProvider(ports), primary].map(provider => cloudCi(mainId, provider, mirrors, options))
}

/** Appends a CircleCI service to `clouds` for each further CircleCI org discovery finds; the caller refreshes it. */
export function circleCiOrgs(clouds: CloudCi[], mainId: string, mirrors: Mirrors, mirrorList: () => Promise<string[]>,
  options: { ports?: HostCiPorts; activeRuns?: () => Promise<ActiveCiRuns>; runningOwners?: () => Promise<string[]>;
    runningOrganizations?: () => Promise<{ owner: string; circleAccountId: string }[]>;
    registry?: CircleAccountRegistry; context?: (id: string) => Promise<CircleAccountContext>;
    standby?: CircleStandby; explicitPrimary?: boolean } = {})
  : CircleCiAccounts {
  const ports = options.ports ?? systemHostCiPorts()
  return new CircleCiAccounts(ports, mirrorList,
    async account => {
      const context = await options.context?.(account.circleAccountId ?? 'default')
      const provider = new CircleCiProvider(context?.ports ?? ports, context ? { http: context.http } : {}, account)
      const cloud = cloudCi(mainId, provider, mirrors, options)
      if (options.standby) cloud.setCircleStandby(options.standby)
      clouds.push(cloud)
    }, { runningOwners: options.runningOwners, runningOrganizations: options.runningOrganizations,
      registry: options.registry, context: options.context, explicitPrimary: options.explicitPrimary })
}

function cloudCi(mainId: string, provider: CloudProvider, mirrors: Mirrors,
  options: { activeRuns?: () => Promise<ActiveCiRuns> }) {
  const cloud = new CloudCi(mainId, provider, mirrors)
  if (options.activeRuns) cloud.setActiveRunLookup(options.activeRuns)
  return cloud
}

