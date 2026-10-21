import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { availableParallelism, freemem, homedir, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, matchesGlob } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { compactIntegrationCoverage, expandIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { CiIntegrationCoverageSchema, CiWatchdogFailureSchema, CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, integrationPartition,
  CiSelectionSchema, validCiSelection,
  CI_HOST_START_PROTOCOL_VERSION,
  type CiDurations, type CiHostReply, type CiHostRequest, type CiHostRun, type CiSuite, type CiPart, type CiPartition, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { underDeadline } from '../processDeadline.js'
import { ciRepositoryCapabilities } from './repository.js'
import { allowedCiResources, gateIntegrationShards, hostCiCapacity } from './capacity.js'
import { fallbackOnMissing, logIgnoredError } from '../diagnostics/ignoredError.js'
import { componentLogger } from '../diagnostics/logger.js'
import { pnpmInstall, shellQuote } from './warmSetup.js'
import { ciLogPage } from './logPage.js'
import { readCiReport } from './reports.js'
import { withHostCiRunLock } from './runnerLock.js'
import { readCiUnitStates, type CiUnitState } from './unitStates.js'
import { sweepCiRunDirectories } from './directoryRetention.js'
import { sweepHostCiCache } from './cacheCleanup.js'

const log = componentLogger('jobs')
const REPORT_COLLECTION_WINDOW_MS = 5 * 60_000
const CI_UNIT_RUNTIME_SECONDS = 3 * 60 * 60

type Command = { code: number; stdout: string; stderr: string; /** The command was killed for exceeding its timeout, so its exit code says nothing about the command's subject. */ timedOut?: boolean }
export interface HostCiPorts {
  run(file: string, args: readonly string[], options?: {
    cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal | undefined
    lockFd?: number | undefined
  }): Promise<Command>
  now(): Date
  cpus: number
  memoryBytes: number
  availableMemoryBytes?(): number
}

/** The CircleCI CLI otherwise spawns a telemetry process for every call, and CI polling calls it constantly. */
function withoutCliTelemetry(file: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return file === 'circleci' ? { ...environment, CIRCLECI_CLI_TELEMETRY_OPTOUT: '1' } : environment
}

export function systemHostCiPorts(environment: NodeJS.ProcessEnv = process.env): HostCiPorts {
  return {
    run: (file, args, options = {}) => {
      const env = withoutCliTelemetry(file, options.env ?? environment)
      if (options.signal || options.lockFd !== undefined) return runPreparationCommand(file, args, { ...options, env })
      return new Promise<Command>(resolve => {
        execFile(file, [...args], { cwd: options.cwd, env, timeout: options.timeoutMs ?? 600_000,
          maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
          resolve({ code, stdout, stderr, ...(error && (error as { killed?: boolean }).killed ? { timedOut: true } : {}) })
        })
      })
    },
    now: () => new Date(),
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
    availableMemoryBytes: () => {
      if (process.platform !== 'linux') return freemem()
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
      return available === undefined ? freemem() : Number(available) * 1024
    },
  }
}

/** Cancellation kills the process group and resolves only after the child and its pipes close. */
function runPreparationCommand(file: string, args: readonly string[], options: {
  cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal | undefined
  lockFd?: number | undefined
}): Promise<Command> {
  return new Promise(resolve => {
    if (options.signal?.aborted) return resolve({ code: 1, stdout: '', stderr: 'CI preparation canceled.' })
    // The detached supervisor retains both the deadline and repository guard after API exit.
    const [supervisor, supervised] = underDeadline(options.timeoutMs ?? 600_000, file, args)
    const child = spawn(supervisor, supervised, {
      cwd: options.cwd, env: options.env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe',
        ...(options.lockFd !== undefined ? [options.lockFd] : [])] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          log.warn({ err: error }, 'CI preparation process could not be stopped')
        }
      }
    }
    const stop = () => {
      signalGroup('SIGTERM')
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), 250)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs ?? 600_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
    const collect = (text: string, chunk: string) => {
      const output = text + chunk
      if (output.length <= 16 * 1024 * 1024) return output
      failure = new Error('CI preparation command output exceeded its buffer limit.')
      stop()
      return text
    }
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout = collect(stdout, chunk) })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = collect(stderr, chunk) })
    child.once('error', error => { failure = error })
    child.once('close', code => {
      clearTimeout(timer)
      if (killTimer) {
        signalGroup('SIGKILL')
        clearTimeout(killTimer)
      }
      options.signal?.removeEventListener('abort', stop)
      const supervisorTimedOut = code === 124 || code === 137 && !options.signal?.aborted
      resolve({ code: failure ? 1 : code ?? 1, stdout, stderr: failure?.message ?? stderr,
        ...(timedOut || supervisorTimedOut ? { timedOut: true } : {}) })
    })
  })
}

async function removeStaleGitLocks(directory: string): Promise<void> {
  const lockNames = new Set(['shallow.lock', 'index.lock', 'HEAD.lock', 'config.lock',
    'packed-refs.lock', 'FETCH_HEAD.lock', 'ORIG_HEAD.lock'])
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name === 'refs') {
      await removeStaleRefLocks(path)
    } else if (entry.isFile() && lockNames.has(entry.name)) {
      await rm(path)
    }
  }
}

async function removeStaleRefLocks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await removeStaleRefLocks(path)
    } else if (entry.isFile() && entry.name.endsWith('.lock')) {
      await rm(path)
    }
  }
}

async function waitForRepositoryTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  signal.throwIfAborted()
  let onAbort!: () => void
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([previous, canceled])
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

interface RunMeta {
  runId: string; repository: string; commit: string; suite: CiSuite; partition: CiPartition | null
  startedAt: string; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; cleaned: boolean; durations?: CiDurations
  scope?: CiScope; files?: string[]; part?: CiPart; defaultBranch?: string; baseCommit?: string; deriveFiles?: boolean
  integrationCoverage?: Extract<CiHostRequest, { operation: 'start' }>['integrationCoverage']
  selection?: CiHostRun['selection']
  resources?: { cpuCount: number; memoryBytes: number; memoryBudget?: number }
  /** The persistent checkout this run holds; absent when it uses a fresh checkout in its run directory. */
  slot?: number
  expectedDurationMs?: number
  isolatedDatabase?: boolean
  warmup?: boolean
  gate?: boolean; integrationShards?: number
  serviceUnit?: string
  cancellationRequested?: boolean
  testResultsExpected?: boolean
  notice?: string
}

type StartRequest = { runId: string; repository: string; commit: string; suite: CiSuite
  part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined;
  scope?: CiScope | undefined; files?: string[] | undefined; defaultBranch?: string | undefined;
  expectedDurationMs?: number | undefined; baseCommit?: string | undefined; gate?: boolean | undefined;
  integrationShards?: number | undefined; buildAllowancePercent?: number | undefined; notice?: string | undefined;
  integrationCoverage?: Extract<CiHostRequest, { operation: 'start' }>['integrationCoverage'];
  warmup?: boolean | undefined }

const unitName = (runId: string) => `foreman-ci-${runId}`
const serviceUnit = (meta: RunMeta) => meta.serviceUnit ?? `${unitName(meta.runId)}.service`
const unitStateKey = (meta: RunMeta) => `${meta.runId}:${meta.state}:${meta.startedAt}:${serviceUnit(meta)}`
// GitHub CLI's own credential helper: a computer that is logged in to gh fetches without any app setup.
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

export function hostCiDirectory() {
  return join(homedir(), '.local/share/foreman-code/ci-host')
}

/** Runs CI suites directly on this computer, like a self-hosted runner. Each run is a transient
 * systemd user service, so it outlives a Worker restart, and its CPU and memory stay below the host reserve. */
export class HostCiRunner {
  private readonly preparing = new Map<string, Promise<void>>()
  private readonly starts = new Map<string, Promise<CiHostRun>>()
  private readonly preparationAborts = new Map<string, AbortController>()
  private readonly reading = new Map<string, number>()
  private startQueue = Promise.resolve()
  private pendingRealStarts = 0
  private startingRun: CiHostRun | null = null
  private readonly repositoryLock = new AsyncLocalStorage<number>()
  private readonly repositoryQueues = new Map<string, Promise<void>>()
  private githubChecked: { at: number; ready: boolean; reason: string | null } | undefined
  private readonly toolsChecked = new Map<string, number>()
  /** Status polls list every retained run; settled, cleaned runs are reused until their metadata file changes. */
  private readonly settledRuns = new Map<string, { version: string; run: CiHostRun }>()
  private draining = false
  // Background eviction checks live runs because a start can arrive during the filesystem scan.
  private readonly activeRunRepositories = new Map<string, string>()
  private cacheRevision = 0
  private sweptCacheRevision = -1
  private cacheSweepAt = -Infinity
  private cacheSweepPending: Promise<void> | undefined
  private startingRepository: string | undefined
  private readonly watchdog = fileURLToPath(new URL(import.meta.url.endsWith('.mjs')
    ? '../artifacts/verification/ci-watchdog.mjs' : '../../../../../scripts/ci-watchdog.mjs', import.meta.url))

  constructor(private readonly root = hostCiDirectory(),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly startupSmokePending: () => boolean | Promise<boolean> = () => false) {
    if (!existsSync(this.watchdog)) throw new Error(`CI watchdog is missing: ${this.watchdog}`)
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      if (!request.cleanupRunIds) return this.status(request.buildAllowancePercent)
      const removedRunIds = await this.removeRunDirectories(request.cleanupRunIds)
      return CiHostReplySchema.parse({ ...await this.status(request.buildAllowancePercent), removedRunIds })
    }
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') return CiHostReplySchema.parse({ operation: 'cancel', run: await this.cancel(request.runId) })
    this.reading.set(request.runId, (this.reading.get(request.runId) ?? 0) + 1)
    try { return await this.readRun(request) }
    finally {
      const remaining = this.reading.get(request.runId)! - 1
      if (remaining) this.reading.set(request.runId, remaining)
      else this.reading.delete(request.runId)
    }
  }

  private async readRun(request: Extract<CiHostRequest, { operation: 'read' }>) {
    const run = await this.refresh(request.runId)
    return this.readContents(request, run)
  }

  private async readContents(request: Extract<CiHostRequest, { operation: 'read' }>, run: CiHostRun) {
    const path = join(this.runDirectory(request.runId), 'log')
    let text = '', nextOffset = request.afterOffset
    if (existsSync(path)) {
      const handle = await open(path, 'r')
      try {
        run = { ...run, logBytes: (await handle.stat()).size }
        const buffer = Buffer.alloc(request.maxBytes)
        const { bytesRead } = await handle.read(buffer, 0, request.maxBytes, request.afterOffset)
        const page = ciLogPage(buffer.subarray(0, bytesRead), 0, request.maxBytes)
        text = sanitizeCiText(page.text)
        nextOffset = request.afterOffset + page.nextOffset
      } finally { await handle.close() }
    } else if (run.exitCode !== null || run.logBytes > 0 || run.step && run.step !== 'dispatch') {
      throw new DomainError('CI_LOG_UNAVAILABLE', 'The retained CI log is missing.', 503)
    }
    // A finished test run reports the file durations and test results it measured, so Main can learn and show them.
    const finished = !['starting', 'running'].includes(run.state)
    const reportPath = (name: string) => join(this.runDirectory(request.runId), name)
    const measured = request.durations && finished
      ? await readCiReport(reportPath('measured-durations.json'), CiDurationsSchema) : null
    const tests = request.testResults && finished
      ? await readCiReport(reportPath('test-results.json'), CiTestResultsSchema) : null
    const coverage = request.integrationCoverage && finished
      ? await readCiReport(reportPath('integration-coverage.json'), CiIntegrationCoverageSchema) : null
    const compressed = coverage?.state === 'complete'
      ? gzipSync(JSON.stringify(compactIntegrationCoverage(coverage.data))).toString('base64') : undefined
    if (tests) {
      const meta = await this.readMeta(request.runId).catch(error => {
        if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN' && run.state === 'canceled') return null
        throw error
      })
      const expected = meta?.testResultsExpected && (run.state === 'passed' || run.step === (meta.part ?? meta.suite))
      let collection: CiHostRun['collection'] = tests.state === 'complete' ? 'complete' : 'unsupported'
      if (tests.state === 'pending' || tests.state === 'absent' && expected || measured?.state === 'pending') {
        collection = 'pending'
      }
      const expired = run.finishedAt !== null
        && this.ports.now().getTime() - Date.parse(run.finishedAt) >= REPORT_COLLECTION_WINDOW_MS
      // After the window, a report this run should have written is a failed collection, not absent reporting.
      if (collection === 'pending' && expired) collection = expected ? 'failed' : 'unsupported'
      run.collection = collection
    }
    return CiHostReplySchema.parse({ operation: 'read', run, text, nextOffset,
      ...(measured?.state === 'complete' ? { durations: measured.data } : {}),
      ...(compressed && compressed.length <= 700_000 ? { integrationCoverage: compressed } : {}),
      ...(tests?.state === 'complete' ? { testResults: tests.data } : {}) })
  }

  async beginDrain(): Promise<void> {
    this.draining = true
    await this.startQueue
    await Promise.allSettled(this.starts.values())
    await Promise.all(this.preparing.values())
    await this.cacheSweepPending
  }

  resumeAdmissions() { this.draining = false }

  isUpdateIdle() { return this.preparing.size === 0 && this.starts.size === 0 }

  private runDirectory(runId: string) { return join(this.root, 'runs', runId) }

  private async removeRunDirectories(runIds: string[]) {
    const removed = await sweepCiRunDirectories({ root: this.root, runIds,
      isInUse: runId => this.reading.has(runId) || this.preparing.has(runId) || this.starts.has(runId),
      withRun: async (runId, work) => {
        await this.refresh(runId)
        return withHostCiRunLock(this.runDirectory(runId), work, { nonBlocking: true })
      } })
    for (const runId of removed) this.settledRuns.delete(runId)
    return removed
  }

  /** A persistent checkout keeps its installed dependencies between the parts that hold its slot in turn. */
  private slotSource(repository: string, slot: number) {
    return join(this.root, 'slots', ...repository.split('/'), String(slot), 'src')
  }

  private async readMeta(runId: string): Promise<RunMeta> {
    try {
      const directory = this.runDirectory(runId)
      const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as RunMeta
      const state = meta.state === 'starting' && existsSync(join(directory, 'service-started')) ? 'running' : meta.state
      // Cancellation survives concurrent launch metadata writes and Worker restarts.
      return { ...meta, state, cancellationRequested: existsSync(join(directory, 'cancel-requested')) }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('CI_RUN_UNKNOWN', 'This computer has no such CI run.', 404, undefined, { cause: error })
      }
      throw error
    }
  }

  private async writeMeta(meta: RunMeta) {
    const path = join(this.runDirectory(meta.runId), 'meta.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      // Busy checks must see a complete record while launch updates the run state.
      await writeFile(temporary, serializeCiJson(meta), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async github(): Promise<{ ready: boolean; reason: string | null }> {
    if (this.githubChecked?.ready && Date.now() - this.githubChecked.at < 300_000) return this.githubChecked
    const result = await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { env: this.environment, timeoutMs: 15_000 })
    const ready = result.code === 0
    this.githubChecked = { at: Date.now(), ready,
      reason: ready ? null : 'Log in to GitHub on this computer (gh auth login, or computer_github_login_start).' }
    return this.githubChecked
  }

  private async toolAvailable(tool: string): Promise<boolean> {
    const checkedAt = this.toolsChecked.get(tool)
    if (checkedAt !== undefined && Date.now() - checkedAt < 300_000) return true
    this.toolsChecked.delete(tool)
    const result = await this.ports.run(tool, ['--version'], { env: this.environment, timeoutMs: 15_000 })
    if (result.code !== 0) return false
    this.toolsChecked.set(tool, Date.now())
    return true
  }

  private invalidateReadiness() {
    this.githubChecked = undefined
    this.toolsChecked.clear()
  }

  async status(buildAllowancePercent = 100): Promise<CiHostReply> {
    const startingRun = this.startingRun
    const github = await this.github()
    const reasons = github.reason ? [github.reason] : []
    if (await this.startupSmokePending()) reasons.push('Worker update CI smoke is pending; this computer is reserved for validation.')
    if (this.draining) reasons.push('Worker runtime update is draining CI preparation.')
    for (const tool of ['git', 'corepack']) {
      if (!await this.toolAvailable(tool)) {
        reasons.push(`${tool} is not installed for the Worker.`)
      }
    }
    const runs = []
    const directory = join(this.root, 'runs')
    const names = existsSync(directory) ? (await readdir(directory)).sort() : []
    const unitStates = await this.retainedUnitStates(names)
    for (const runId of names) {
      const run = await this.refreshRetained(runId, unitStates)
      if (run) runs.push(run)
    }
    for (const run of runs) {
      if (run.warmup && !['starting', 'running', 'queued'].includes(run.state)) {
        await this.removeRunDirectories([run.runId])
      }
    }
    const active: RunMeta[] = []
    for (const run of runs) {
      if (run && !run.warmup && ['starting', 'running'].includes(run.state)) active.push(await this.readMeta(run.runId))
    }
    // Repository preparation precedes metadata; status must still acknowledge the accepted start.
    const pendingStart = startingRun && !startingRun.warmup && !runs.some(run => run?.runId === startingRun.runId)
    if (pendingStart) runs.push(startingRun)
    this.cleanCaches()
    const availableMemoryBytes = this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes
    const resources = allowedCiResources({ cpuCount: this.ports.cpus,
      memoryBytes: this.ports.memoryBytes, availableMemoryBytes }, buildAllowancePercent)
    const capacity = this.capacity(active, { availableMemoryBytes, buildAllowancePercent })
    const activeRuns = runs.filter(run => run && !run.warmup && ['starting', 'running'].includes(run.state))
    const finishedRuns = runs.filter(run => run && !run.warmup && !['starting', 'running'].includes(run.state))
    return CiHostReplySchema.parse({ operation: 'status', ready: !reasons.length, reasons,
      startProtocolVersion: CI_HOST_START_PROTOCOL_VERSION, cleanupSupported: true, prewarmSupported: true,
      ...resources, buildAllowancePercent,
      slotsUsed: capacity.slotsUsed + Number(Boolean(pendingStart)), slotsTotal: capacity.slotsTotal,
      runs: [...activeRuns, ...finishedRuns.slice(-Math.max(0, 50 - activeRuns.length))].slice(0, 50)
        .map(run => ({ ...run, selection: undefined })) })
  }

  private trackCacheWriter(runId: string, repository?: string) {
    if (this.activeRunRepositories.get(runId) === repository) return
    if (repository === undefined) this.activeRunRepositories.delete(runId)
    else this.activeRunRepositories.set(runId, repository)
    this.cacheRevision++
  }

  private cleanCaches() {
    if (this.cacheSweepPending) return
    const activeRepositories = () => {
      const repositories = new Set(this.activeRunRepositories.values())
      if (this.startingRepository) repositories.add(this.startingRepository)
      return repositories
    }
    this.cacheSweepPending = (async () => {
      const now = this.ports.now().getTime()
      // At most one walk per 5 minutes, and only after a writer transition; external changes wait for the hourly scan.
      const revision = this.cacheRevision, elapsed = now - this.cacheSweepAt
      if (revision !== this.sweptCacheRevision && elapsed >= 5 * 60_000 || elapsed >= 60 * 60_000) {
        await sweepHostCiCache(this.root, { activeRepositories })
        this.cacheSweepAt = now
        this.sweptCacheRevision = revision
      }
      if (!this.activeRunRepositories.size && !this.startingRun && !this.preparing.size) {
        await rm(join(this.root, 'vitest-cache'), { recursive: true, force: true })
      }
    })().catch(error => {
      log.warn({ err: error }, 'CI cache cleanup failed; next status will retry')
    }).finally(() => { this.cacheSweepPending = undefined })
  }

  private capacity(active: RunMeta[], options: { availableMemoryBytes?: number; buildAllowancePercent?: number } = {}) {
    const resources = allowedCiResources({ cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes,
      availableMemoryBytes: options.availableMemoryBytes ?? this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes },
      options.buildAllowancePercent)
    return hostCiCapacity(resources,
      active.map(run => run.resources ?? { cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes }))
  }

  private async active(): Promise<RunMeta[]> {
    const directory = join(this.root, 'runs')
    if (!existsSync(directory)) return []
    const active = []
    const names = await readdir(directory)
    const unitStates = await this.retainedUnitStates(names)
    for (const runId of names) {
      const run = await this.refreshRetained(runId, unitStates)
      if (run && !run.warmup && ['starting', 'running'].includes(run.state)) active.push(await this.readMeta(runId))
    }
    return active
  }

  /** A damaged terminal record must not abort status for the rest of the computer; a live run keeps its slot. */
  private async refreshRetained(runId: string, unitStates?: ReadonlyMap<string, CiUnitState>): Promise<CiHostRun | null> {
    try {
      return await this.refresh(runId, unitStates)
    } catch (error) {
      const meta = await this.readMeta(runId).catch((metaError: unknown) => {
        log.warn({ err: metaError, runId }, 'The CI run metadata is unreadable')
        return null
      })
      if (meta && ['starting', 'running'].includes(meta.state)) {
        log.warn({ err: error, runId }, 'A live CI run could not be fully read; keeping its slot reserved')
        return { runId, ...(meta.warmup ? { warmup: true } : {}),
          state: meta.state, step: null, exitCode: meta.exitCode, startedAt: meta.startedAt,
          finishedAt: meta.finishedAt, logBytes: 0, message: this.runMessage(meta) }
      }
      log.warn({ err: error, runId }, 'Skipping an incomplete or damaged CI run record')
      return null
    }
  }

  private start(request: StartRequest) {
    const existing = this.starts.get(request.runId)
    if (existing) return existing
    if (!request.warmup) this.pendingRealStarts++
    this.preparationAborts.set(request.runId, new AbortController())
    const pending = this.startRun(request).catch(error => {
      this.invalidateReadiness()
      throw error
    }).finally(() => {
      this.starts.delete(request.runId)
      if (!this.preparing.has(request.runId)) this.preparationAborts.delete(request.runId)
      if (!request.warmup) this.pendingRealStarts--
    })
    this.starts.set(request.runId, pending)
    return pending
  }

  private async startRun(request: StartRequest) {
    if (await this.startupSmokePending()) throw new DomainError('CI_HOST_BUSY',
      'Worker update CI smoke is pending; this computer is reserved for validation.', 409)
    if (this.draining) throw new DomainError('WORKER_RUNTIME_DRAINING',
      'This computer is waiting for CI preparation to finish before updating its runtime.', 409)
    // Keep the busy check and initial persistence together, including same-run retries.
    const previous = this.startQueue
    let release!: () => void
    this.startQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    let reserved: RunMeta | CiHostRun
    try {
      this.startingRepository = request.repository
      if (!request.warmup) await this.stopWarmups()
      reserved = request.warmup
        ? await this.existingWarmup(request) ?? await this.reserveRun(request)
        : await this.reserveRun(request)
    } finally {
      this.startingRun = null
      this.startingRepository = undefined
      release()
    }
    return 'repository' in reserved ? this.prepareRun(request, reserved) : reserved
  }

  private warmupBusy(request: StartRequest): CiHostRun {
    return { runId: request.runId, warmup: true, state: 'queued', step: null, exitCode: null,
      startedAt: this.ports.now().toISOString(), finishedAt: null, logBytes: 0, message: 'Real CI has priority.' }
  }

  private async existingWarmup(request: StartRequest): Promise<CiHostRun | undefined> {
    if (this.pendingRealStarts || (await this.active()).length) return this.warmupBusy(request)
    const directory = join(this.root, 'runs')
    for (const runId of existsSync(directory) ? await readdir(directory) : []) {
      const run = await this.refreshRetained(runId)
      if (!run?.warmup) continue
      const meta = await this.readMeta(runId)
      if (meta.repository === request.repository && meta.commit === request.commit
        && ['passed', 'failed'].includes(run.state)) return run
      if (['starting', 'running'].includes(run.state)) {
        return meta.repository === request.repository && meta.commit === request.commit ? run : this.warmupBusy(request)
      }
    }
  }

  private async stopWarmups() {
    const directory = join(this.root, 'runs')
    for (const runId of existsSync(directory) ? await readdir(directory) : []) {
      const run = await this.refreshRetained(runId)
      if (!run?.warmup || !['starting', 'running'].includes(run.state)) continue
      await this.cancel(runId)
      await this.starts.get(runId)
      const stopped = await this.cancel(runId)
      if (['starting', 'running'].includes(stopped.state)) {
        throw new DomainError('CI_HOST_BUSY', 'Waiting for background CI preparation to stop.', 409)
      }
    }
  }

  private async reserveRun(request: StartRequest): Promise<RunMeta | CiHostRun> {
    const directory = this.runDirectory(request.runId)
    if (existsSync(join(directory, 'meta.json'))) {
      const existing = await this.refresh(request.runId)
      if (existing.state !== 'queued') return existing
    }
    if (existsSync(join(directory, 'cancel-requested'))) return this.canceledBeforeStart(request.runId)
    this.startingRun = { runId: request.runId, state: 'starting', step: 'dispatch',
      ...(request.warmup ? { warmup: true } : {}),
      startedAt: this.ports.now().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null }
    const active = await this.active()
    if (active.some(run => run.gate) || request.gate && active.length) {
      throw new DomainError('CI_HOST_BUSY', 'A gate requires exclusive use of this build computer.', 409)
    }
    const allowance = { buildAllowancePercent: request.buildAllowancePercent ?? 100 }
    const capacity = this.capacity(active, allowance)
    if (capacity.slotsUsed >= capacity.slotsTotal) {
      throw new DomainError('CI_HOST_BUSY',
        `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); waiting for CPU or memory capacity.`, 409)
    }
    const github = await this.github()
    if (!github.ready) throw new DomainError('COMPUTER_GITHUB_REQUIRED', github.reason!, 409)
    const startedAt = this.ports.now().toISOString()
    // Concurrent parts never share a checkout: take the lowest slot no active run of this repository holds.
    const held = new Set(active.filter(run => run.repository === request.repository).map(run => run.slot))
    let slot = 0
    while (held.has(slot)) slot++
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const meta: RunMeta = { runId: request.runId, repository: request.repository, commit: request.commit,
      suite: request.suite, partition: request.partition ?? null, startedAt, slot,
      ...(request.warmup ? { warmup: true } : {}),
      state: 'starting', finishedAt: null, exitCode: null, message: null, cleaned: false,
      resources: { cpuCount: capacity.cpuCount, memoryBytes: capacity.memoryBytes, memoryBudget: capacity.memoryBudget },
      ...(request.expectedDurationMs !== undefined ? { expectedDurationMs: request.expectedDurationMs } : {}),
      ...(request.gate ? { gate: true, integrationShards: Math.min(request.integrationShards!,
        gateIntegrationShards(capacity.cpuCount, capacity.memoryBytes)) } : {}),
      ...(request.part ? { part: request.part } : {}),
      scope: request.scope ?? 'affected', ...(request.files !== undefined ? { files: request.files } : {}),
      deriveFiles: (request.scope ?? 'affected') === 'affected' && request.files === undefined,
      ...(request.defaultBranch ? { defaultBranch: request.defaultBranch } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      ...(request.integrationCoverage ? { integrationCoverage: request.integrationCoverage } : {}),
      selection: { scope: request.scope ?? 'affected', files: request.files ?? [],
        reason: request.files ? 'Caller supplied the affected files.' : 'Full scope requested.' },
      ...(request.notice ? { notice: request.notice } : {}),
      ...(request.durations ? { durations: request.durations } : {}) }
    return (await withHostCiRunLock(directory, async () => {
      if (existsSync(join(directory, 'meta.json')) && (await this.readMeta(request.runId)).state !== 'queued') {
        return this.refresh(request.runId)
      }
      await this.writeMeta(meta)
      this.trackCacheWriter(meta.runId, meta.repository)
      return meta
    }))!
  }

  private async prepareRun(request: StartRequest, meta: RunMeta) {
    const directory = this.runDirectory(meta.runId)
    const signal = this.preparationAborts.get(meta.runId)?.signal
    const allowance = { buildAllowancePercent: request.buildAllowancePercent ?? 100 }
    const ready = await withHostCiRunLock(directory, async () => {
      try {
        if (!await this.cancelPreparation(meta.runId)) {
          await this.withRepository(request.repository, () => this.prepareRepository(request, signal), { signal })
        }
        if (await this.cancelPreparation(meta.runId)) return false
        const databaseSuite = ['unit', 'integration'].includes(request.suite)
        const isolatedDatabase = databaseSuite && await this.supportsDatabaseIsolation(request)
        const active = (await this.active()).filter(run => run.runId !== request.runId)
        let capacity = this.capacity(active, allowance)
        const resources = allowedCiResources({ cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes,
          availableMemoryBytes: this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes }, allowance.buildAllowancePercent)
        if (request.gate || databaseSuite && !isolatedDatabase) {
          capacity = { ...capacity, slotsUsed: active.length, slotsTotal: 1, cpuCount: resources.cpuCount,
            memoryBytes: Math.max(1, Math.min(capacity.memoryBudget, resources.availableMemoryBytes)) }
        }
        if (capacity.slotsUsed >= capacity.slotsTotal) {
          throw new DomainError('CI_HOST_BUSY',
            `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); this commit needs exclusive database capacity.`, 409)
        }
        meta.resources = { cpuCount: capacity.cpuCount, memoryBytes: capacity.memoryBytes, memoryBudget: capacity.memoryBudget }
        if (meta.warmup) {
          meta.resources = { cpuCount: 1, memoryBytes: Math.min(2 ** 31, capacity.memoryBytes) }
        }
        meta.isolatedDatabase = isolatedDatabase
        if (request.gate) {
          meta.integrationShards = Math.min(request.integrationShards!,
            gateIntegrationShards(capacity.cpuCount, capacity.memoryBytes))
        }
        if (await this.cancelPreparation(meta.runId)) return false
        await this.writeMeta(meta)
        return true
      } catch (error) {
        const current = await this.readMeta(meta.runId)
        if (!current.cancellationRequested && error instanceof DomainError && error.code === 'CI_HOST_BUSY') {
          if (current.warmup) {
            await rm(directory, { recursive: true, force: true })
          } else {
            await this.writeMeta({ ...current, state: 'queued', finishedAt: null, exitCode: null,
              message: error.message })
          }
          this.trackCacheWriter(meta.runId)
          throw error
        }
        await this.finish(meta.runId, current.cancellationRequested ? 'canceled' : 'failed', null,
          error instanceof Error ? error.message : String(error))
        if (current.cancellationRequested) return false
        throw error
      }
    })
    if (!ready) return this.refresh(meta.runId)
    const preparing = this.launch(meta).catch(async error => {
      this.invalidateReadiness()
      try {
        const current = await this.readMeta(meta.runId)
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
        if (current.serviceUnit) {
          // A command failure can occur after native entry; status must reconcile the persisted unit first.
          await this.writeMeta({ ...current, message })
        } else {
          await this.finish(meta.runId, current.cancellationRequested ? 'canceled' : 'failed', null, message)
        }
      } catch (recordError) {
        log.error({ err: recordError, error, runId: meta.runId, operation: 'record CI launch failure' },
          'Could not record a background CI launch failure')
      }
    }).finally(() => {
      this.preparing.delete(meta.runId)
      this.preparationAborts.delete(meta.runId)
    })
    this.preparing.set(meta.runId, preparing)
    return this.refresh(request.runId)
  }

  private runGit(args: readonly string[], options?: Parameters<HostCiPorts['run']>[2]) {
    return this.ports.run('git', args, { ...options, lockFd: this.repositoryLock.getStore() })
  }

  private async git(args: readonly string[], cwd?: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const result = await this.runGit([...gitAuth, ...args], { ...(cwd ? { cwd } : {}),
      env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' }, signal })
    signal?.throwIfAborted()
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().split('\n').at(-1) ?? ''}`)
    return result.stdout
  }

  /** Fetch the commit with this computer's GitHub login and start the suite in a private checkout. */
  private launch(meta: RunMeta) {
    return withHostCiRunLock(this.runDirectory(meta.runId), () => this.launchRun(meta))
  }

  private async withRepository<T>(repository: string, work: () => Promise<T>,
    options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}) {
    if (options.nonBlocking && this.repositoryQueues.has(repository)) return undefined
    const previous = this.repositoryQueues.get(repository) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    // A canceled waiter can leave early, but later work must still wait for its predecessors.
    const pending = previous.then(() => turn).finally(() => {
      if (this.repositoryQueues.get(repository) === pending) this.repositoryQueues.delete(repository)
    })
    this.repositoryQueues.set(repository, pending)
    try {
      await waitForRepositoryTurn(previous, options.signal)
      const clone = join(this.root, 'git', ...repository.split('/'))
      await mkdir(clone, { recursive: true, mode: 0o700 })
      return await withHostCiRunLock(clone, async guard => {
        // Git inherits this guard, so recovery waits for writers that survive a Main restart.
        const gitDirectory = join(clone, '.git')
        if (existsSync(gitDirectory)) await removeStaleGitLocks(gitDirectory)
        return this.repositoryLock.run(guard.fd, work)
      }, options)
    } finally {
      release()
    }
  }

  private async launchRun(meta: RunMeta) {
    const signal = this.preparationAborts.get(meta.runId)?.signal
    const source = await this.withRepository(meta.repository, async () => {
      const current = await this.readMeta(meta.runId)
      if (current.state !== 'starting' || current.cancellationRequested) return
      const source = await this.checkout(meta, signal)
      await this.selectFiles(meta, source, signal)
      return source
    }, { signal })
    if (!source) return
    signal?.throwIfAborted()
    const script = await this.script(meta, source)
    await writeFile(join(this.runDirectory(meta.runId), 'run.sh'), script, { mode: 0o700 })
    const stoppedScript = join(this.runDirectory(meta.runId), 'stopped.sh')
    await writeFile(stoppedScript, this.stoppedScript(meta), { mode: 0o700 })
    const current = await this.readMeta(meta.runId)
    if (current.state !== 'starting' || current.cancellationRequested) return
    const serviceUnit = `${unitName(meta.runId)}.service`
    await this.writeMeta({ ...meta, ...current, serviceUnit,
      ...(meta.scope ? { scope: meta.scope } : {}), ...(meta.files ? { files: meta.files } : {}),
      ...(meta.selection ? { selection: meta.selection } : {}),
      ...(meta.testResultsExpected !== undefined ? { testResultsExpected: meta.testResultsExpected } : {}),
      message: meta.message })
    const resources = this.suiteResources(meta)
    const environment = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => this.environment[key] ? [`--setenv=${key}=${this.environment[key]}`] : [])
    const started = await this.ports.run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(meta.runId)}`,
      `--property=MemoryMax=${resources.memoryBytes}`, `--property=CPUQuota=${resources.cpuCount * 100}%`,
      `--property=RuntimeMaxSec=${CI_UNIT_RUNTIME_SECONDS}`, `--property=TimeoutStopSec=${meta.warmup ? 2 : 30}`,
      ...(meta.warmup ? ['--property=Nice=19', '--property=CPUWeight=1', '--property=IOWeight=1',
        '--property=IOSchedulingClass=idle'] : []),
      '--property=KillMode=control-group',
      `--property=ExecStopPost=/bin/bash ${JSON.stringify(stoppedScript).replaceAll('%', '%%')}`,
      '--property=UMask=0022', `--working-directory=${source}`, ...environment, '/bin/bash', join(this.runDirectory(meta.runId), 'run.sh')],
    { env: this.environment, timeoutMs: 30_000, signal })
    if (started.code !== 0) throw new Error(`The CI unit could not start: ${started.stderr.trim().slice(0, 500)}`)
    const launched = await this.readMeta(meta.runId)
    if (launched.state === 'starting' || launched.state === 'running') {
      await this.writeMeta({ ...launched, state: 'running' })
    }
  }

  private async prepareRepository(request: Pick<StartRequest, 'repository' | 'commit' | 'scope' | 'files'>,
    signal?: AbortSignal) {
    signal?.throwIfAborted()
    const clone = join(this.root, 'git', ...request.repository.split('/'))
    if (!existsSync(join(clone, '.git'))) {
      await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
      await mkdir(clone, { recursive: true, mode: 0o700 })
      try {
        await this.git(['init', '--quiet', clone], clone, signal)
        await this.git(['remote', 'add', 'origin', `https://github.com/${request.repository}.git`], clone, signal)
      } catch (error) {
        // Keep the directory inode stable while other runners wait for its repository lock.
        await rm(join(clone, '.git'), { recursive: true, force: true })
        throw error
      }
    }
    const history = (request.scope ?? 'affected') === 'affected' && request.files === undefined
    // A canceled fetch can leave the commit object without its tree or files; only a readable snapshot is present.
    const missing = (await this.runGit(['rev-list', '--quiet', '--objects', '--no-walk', request.commit],
      { cwd: clone, env: this.environment, signal })).code !== 0
    // A complete clone that already holds the commit has its history: parts of one commit fetch it once.
    const shallow = history && (await this.git(['rev-parse', '--is-shallow-repository'], clone, signal)).trim() === 'true'
    if (missing || shallow) {
      let depth = ['--depth=1']
      if (history) depth = shallow ? ['--unshallow'] : []
      await this.git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', request.commit], clone, signal)
    }
  }

  private async supportsDatabaseIsolation(request: Pick<StartRequest, 'repository' | 'commit'>) {
    const clone = join(this.root, 'git', ...request.repository.split('/'))
    const manifest = await this.runGit(['show', `${request.commit}:package.json`],
      { cwd: clone, env: this.environment })
    if (manifest.code !== 0) return false
    const parsed = JSON.parse(manifest.stdout) as { foremanCi?: { hostSlots?: number } }
    return parsed.foremanCi?.hostSlots === 1
  }

  /** Resets the run's slot checkout to its commit, or falls back to a fresh checkout in the run directory. */
  private async checkout(meta: RunMeta, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const clone = join(this.root, 'git', ...meta.repository.split('/'))
    if (meta.slot !== undefined) {
      const source = this.slotSource(meta.repository, meta.slot)
      try {
        if (existsSync(join(source, '.git'))) {
          await this.git(['checkout', '--quiet', '--force', '--detach', meta.commit], source, signal)
        } else {
          await rm(source, { recursive: true, force: true })
          await mkdir(join(source, '..'), { recursive: true, mode: 0o700 })
          await this.git(['worktree', 'prune'], clone, signal)
          await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone, signal)
        }
        // Only installed dependencies survive: untracked files, caches and build outputs of earlier commits
        // (including outputs of sources this commit deleted) must not leak into this part.
        await this.git(['clean', '-ffdxq', '-e', 'node_modules'], source, signal)
        return source
      } catch (error) {
        signal?.throwIfAborted()
        const reason = error instanceof Error ? error.message : String(error)
        await appendFile(join(this.runDirectory(meta.runId), 'log'),
          `[ci-checkout] persistent checkout unusable (${reason.slice(0, 500)}); using a fresh checkout\n`, { mode: 0o600 })
        // The next part on this slot starts from a new checkout instead of failing the same way.
        await rm(join(source, '..'), { recursive: true, force: true })
        await this.git(['worktree', 'prune'], clone, signal)
        delete meta.slot
        const current = await this.readMeta(meta.runId)
        delete current.slot
        await this.writeMeta(current)
      }
    }
    const source = join(this.runDirectory(meta.runId), 'src')
    await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone, signal)
    return source
  }

  private suiteResources(meta: RunMeta) {
    const resources = meta.resources!
    if (!meta.isolatedDatabase) return resources
    const database = this.databaseResources(meta)
    return { cpuCount: resources.cpuCount - database.cpuCount,
      memoryBytes: Math.max(1, resources.memoryBytes - database.memoryBytes) }
  }

  private databaseResources(meta: RunMeta) {
    const resources = meta.resources!
    const half = { cpuCount: resources.cpuCount / 2, memoryBytes: Math.floor(resources.memoryBytes / 2) }
    if (meta.suite !== 'integration') {
      return { cpuCount: Math.min(1, half.cpuCount), memoryBytes: Math.min(2 ** 30, half.memoryBytes) }
    }
    // Every integration shard migrates and queries its own databases on this one server: one CPU
    // per four shards and 256 MiB each keep setup fast; a fixed single CPU made files time out.
    const shards = Math.max(1, Math.min(meta.integrationShards ?? Infinity, Math.floor(resources.cpuCount)))
    return { cpuCount: Math.min(Math.max(1, Math.ceil(shards / 4)), half.cpuCount),
      memoryBytes: Math.min(Math.max(2 ** 30, shards * 2 ** 28), half.memoryBytes) }
  }

  private async selectFiles(meta: RunMeta, source: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (meta.scope !== 'affected' || meta.files !== undefined) return
    const full = (reason: string) => {
      meta.scope = 'full'
      meta.message = `Running full suite: ${reason}`
      meta.selection = { scope: 'full', files: [], reason }
    }
    const selector = join(source, 'scripts/ci-affected.mjs')
    if (!existsSync(selector)) return full('The repository has no affected selector.')
    let baseCommit = meta.baseCommit
    if (baseCommit) {
      const available = await this.runGit(['cat-file', '-e', `${baseCommit}^{commit}`],
        { cwd: source, env: this.environment, signal })
      signal?.throwIfAborted()
      if (available.code !== 0) {
        const fetched = await this.runGit(['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', baseCommit],
          { cwd: source, env: this.environment, signal })
        signal?.throwIfAborted()
        if (fetched.code !== 0) return full('baseCommit is unavailable or is not an ancestor of the resolved commit.')
      }
      const ancestor = await this.runGit(['merge-base', '--is-ancestor', baseCommit, meta.commit],
        { cwd: source, env: this.environment, signal })
      signal?.throwIfAborted()
      if (ancestor.code !== 0) return full('baseCommit is unavailable or is not an ancestor of the resolved commit.')
    } else {
      const branch = meta.defaultBranch ?? 'main'
      const ref = `refs/remotes/origin/${branch}`
      await this.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`], source, signal)
      if ((await this.git(['rev-parse', ref], source, signal)).trim() === meta.commit) {
        return full('The commit is the workspace default branch head.')
      }
      const base = await this.runGit(['merge-base', meta.commit, ref], { cwd: source, env: this.environment, signal })
      signal?.throwIfAborted()
      if (base.code !== 0) return full('No merge-base with the workspace default branch is available.')
      baseCommit = base.stdout.trim()
    }
    const changed = (await this.git(['diff', '--name-only', '--no-renames', '-z', baseCommit, meta.commit], source, signal))
      .split('\0').filter(Boolean)
    const selection = await this.repositorySelection(meta, source, selector, changed, signal)
    if (selection.scope === 'full') return full(selection.reason)
    const files = await this.partFiles(meta, source, selection.files)
    meta.files = files
    meta.selection = { ...selection, files,
      ...(selection.staticFallbackFiles ? { staticFallbackFiles: selection.staticFallbackFiles.filter(file => files.includes(file)) } : {}) }
    meta.message = files.length ? `Selected ${files.length} affected files for ${meta.part ?? meta.suite}: ${selection.reason}`
      : 'No affected files for this suite part.'
  }

  private async repositorySelection(meta: RunMeta, source: string, selector: string, changed: string[],
    signal?: AbortSignal) {
    signal?.throwIfAborted()
    const coveragePath = join(this.runDirectory(meta.runId), 'coverage-selection.json')
    const coverage = meta.integrationCoverage
    const coverageMap = coverage?.map ? expandIntegrationCoverage(JSON.parse(gunzipSync(
      Buffer.from(coverage.map, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString())) : undefined
    await writeFile(coveragePath, JSON.stringify(coverage ? { ...coverage, map: undefined, coverageMap } : null))
    // selectAffectedFiles also supports repositories whose snapshot helper assumes origin/main.
    const code = [
      "import { execFileSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      'const [selector, suite, commit, changed, coveragePath] = process.argv.slice(1)',
      "const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'))",
      'const coverageMap = coverage?.coverageMap',
      'const { selectAffectedFiles } = await import(pathToFileURL(selector).href)',
      "const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { encoding: 'utf8' })",
      "  .split('\\0').filter(Boolean)",
      'const sources = new Map(paths.map(file => [file, /\\.(?:[cm]?[jt]sx?|json|css)$/.test(file)',
      "  ? readFileSync(join(process.cwd(), file), 'utf8') : '']))",
      "const manifest = sources.get('packages/contracts/package.json')",
      'console.log(JSON.stringify(selectAffectedFiles({ suite, changedFiles:',
      '  [...new Set([...JSON.parse(changed), ...coverage?.changedFiles ?? []])], sources, coverageMap, coverageReason: coverage?.reason,',
      '  exports: manifest ? JSON.parse(manifest).exports : {} })))',
    ].join('\n')
    const result = await this.ports.run('node', ['--input-type=module', '-e', code, selector,
      meta.suite, meta.commit, JSON.stringify(changed), coveragePath], { cwd: source, env: this.environment, signal })
    signal?.throwIfAborted()
    if (result.code !== 0) throw new Error(`Affected selection failed: ${result.stderr.trim().slice(0, 500)}`)
    const selection = CiSelectionSchema.parse(JSON.parse(result.stdout))
    const { scope, files } = selection
    if (!validCiSelection({ suite: meta.suite, scope, files })) throw new Error('The repository returned invalid affected files.')
    return selection
  }

  private async partFiles(meta: RunMeta, source: string, selected: string[]) {
    const part = meta.part
    if (!part) return selected
    const heavyPath = join(source, 'apps/web/heavy-tests.json')
    const heavy = existsSync(heavyPath) ? (JSON.parse(await readFile(heavyPath, 'utf8')) as { files: string[] }).files : []
    let files = selected.filter(file => {
      if (part.endsWith('-api')) return file.startsWith('apps/api/')
      if (part.endsWith('-other')) {
        return !file.startsWith('apps/api/') && (meta.suite !== 'unit' || !file.startsWith('apps/web/'))
      }
      const isHeavy = heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern))
      return file.startsWith('apps/web/') && (part === 'unit-web-heavy' ? isHeavy : !isHeavy)
    })
    if (meta.partition) {
      files = integrationPartition(files, meta.durations ?? {}, meta.partition)
    }
    return files
  }

  private async script(meta: RunMeta, source: string) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}
    const capabilities = ciRepositoryCapabilities(['scripts/ci-suite.sh', 'scripts/ci-files.mjs',
      'scripts/ci-affected-run.mjs'].filter(file => existsSync(join(source, file))))
    const pm = this.packageManager(source)
    const suiteScript: Record<CiSuite, string | null> = { install: null, typecheck: 'typecheck', lint: 'lint',
      unit: 'test', build: 'build', integration: 'test:integration' }
    let name: string | null = null
    if (capabilities.parts) name = suiteScript[meta.suite]
    else if (meta.suite !== 'install') name = meta.suite
    if (!meta.part && name && !scripts[name]) throw new Error(`The repository has no "${name}" script for the ${meta.suite} suite.`)
    if (meta.part && !capabilities.parts) throw new Error('The repository does not support CI suite parts.')
    if (meta.partition && !meta.part && !capabilities.integrationPartitions) {
      throw new Error('The repository does not support integration partitions.')
    }
    let command = ''
    if (meta.part) command = this.partCommand(meta, quote)
    else if (name) command = capabilities.parts ? `${pm} ${name}` : `${pm} run ${name}`
    const supportsSelection = meta.suite === 'integration' ? capabilities.integrationPartitions : capabilities.affected
    const affected = meta.scope === 'affected' && supportsSelection
    if (affected && meta.suite !== 'integration') {
      const selectedPath = join(this.runDirectory(meta.runId), 'selected-files.json')
      await writeFile(selectedPath, JSON.stringify(meta.files ?? []), { mode: 0o600 })
      command = meta.files?.length ? `node scripts/ci-affected-run.mjs ${meta.suite} --files-from ${quote(selectedPath)}` : 'true'
    }
    if (meta.suite === 'typecheck' && command !== 'true'
      && existsSync(join(source, 'scripts/ci-typecheck-cache.mjs'))) {
      command = `node scripts/ci-typecheck-cache.mjs -- bash -c ${quote(command)}`
    }
    const apiUnit = meta.suite === 'unit' && (meta.part === 'unit-api'
      || (affected && meta.files?.some(file => file.startsWith('apps/api/'))))
    const prerequisiteSuite = apiUnit ? 'unit-api' : meta.part ?? meta.suite
    const run = this.runDirectory(meta.runId)
    const resources = this.suiteResources(meta)
    const workers = Math.max(1, Math.min(resources.cpuCount, Math.floor(resources.memoryBytes / 2 ** 30)))
    const heapMb = Math.max(256, Math.min(6144, Math.floor(resources.memoryBytes / 2 / 2 ** 20)))
    const database = capabilities.parts && meta.isolatedDatabase === true
    const databaseResources = this.databaseResources(meta)
    const cache = join(this.root, 'cache', ...meta.repository.split('/'))
    const prerequisites = command !== '' && command !== 'true' && capabilities.parts
    const contracts = (prerequisites || meta.warmup) && existsSync(join(source, 'scripts/ci-contracts.mjs'))
    let install: string[] = []
    if (existsSync(join(source, 'pnpm-lock.yaml'))) {
      install = await pnpmInstall(source, cache, join(run, 'watchdog-message.json'), { offlineOnly: meta.warmup === true })
    } else if (!meta.warmup) {
      install = [`${pm} install || finish $?`]
    }
    let integrationEnvironment = ''
    if (meta.suite === 'integration' && capabilities.integrationPartitions) {
      const durations = meta.durations ?? {}
      await writeFile(join(run, 'expected-durations.json'), JSON.stringify(durations), { mode: 0o600 })
      // The repository's integration runner uses them for per-file hang deadlines and reports what it measured.
      integrationEnvironment = ` FOREMAN_CODE_INTEGRATION_DURATIONS=${quote(join(run, 'expected-durations.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT=${quote(join(run, 'measured-durations.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT=${quote(join(run, 'test-results.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_COVERAGE=${meta.scope === 'full' ? 1 : 0}`
        + ` FOREMAN_CODE_INTEGRATION_COVERAGE_OUTPUT=${quote(join(run, 'integration-coverage.json'))}`
      if (meta.partition || affected || meta.gate) {
        const tests = join(source, 'apps/api/test')
        const files = existsSync(tests) ? (await readdir(tests)).filter(file => file.endsWith('.integration.test.ts'))
          .map(file => `apps/api/test/${file}`).sort() : []
        const selected = affected || meta.gate ? meta.files ?? [] : files
        if (selected.some(file => !files.includes(file))) throw new Error('Selected integration files are absent from the commit.')
        const slice = meta.partition ? integrationPartition(selected, durations, meta.partition) : selected
        if (!slice.length && meta.partition && meta.scope !== 'affected' && !meta.deriveFiles) {
          throw new Error('This partition has no integration files.')
        }
        if (!slice.length && meta.scope === 'affected') meta.message = 'No affected files for this suite part.'
        command = slice.length ? `${command} --files ${slice.map(quote).join(' ')}` : 'true'
      }
    }
    meta.testResultsExpected = command !== 'true' && (meta.suite === 'unit' && capabilities.parts
      || meta.suite === 'integration' && capabilities.integrationPartitions)
    const sourceWatchdog = join(source, 'scripts/ci-watchdog.mjs')
    const watchdog = existsSync(sourceWatchdog) ? sourceWatchdog
      : this.watchdog
    const watchedCommand = `CI_EXPECTED_DURATION_MS=${meta.expectedDurationMs ?? 0}`
        + ` CI_WATCHDOG_DIRECTORY=${quote(run)} CI_WATCHDOG_MESSAGE_FILE=${quote(join(run, 'watchdog-message.json'))}`
        // Only test suites report per-test progress; typecheck, lint and build can stay silent for minutes.
        + (['unit', 'integration'].includes(meta.suite) ? ` node ${quote(watchdog)} --` : '') + ` bash -c ${quote(command)}`
    return ['#!/bin/bash', 'set -o pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
      `export TMPDIR=${quote(join(run, 'tmp'))} FOREMAN_CODE_CI_DATABASE_STATE=${quote(join(run, 'tmp'))} CI=true NODE_OPTIONS=--max-old-space-size=${heapMb}`
        + ` FOREMAN_CODE_CI_CONTRACTS_CACHE=${quote(join(cache, 'contracts'))}`
        + ` FOREMAN_CODE_CI_TYPECHECK_CACHE=${quote(join(source, '..', 'typecheck-cache'))}`
        + ` FOREMAN_CODE_CI_CPU_COUNT=${Math.max(1, Math.floor(resources.cpuCount))}`
        + ` FOREMAN_CODE_CI_MEMORY_BYTES=${resources.memoryBytes}`
        + ` FOREMAN_CODE_VERIFICATION_UNIT_WORKERS=${workers}`
        + (meta.gate ? ` FOREMAN_CODE_CI_INTEGRATION_SHARDS=${meta.integrationShards}` : '')
        // The repository's suite hook writes structured test results here; integration has its own setting.
        + (capabilities.parts ? ` CI_HOST_RUNNER=1 FOREMAN_CODE_CI_DEDICATED=1`
          + (meta.suite === 'integration' ? '' : ` TEST_RESULTS_OUTPUT=${quote(join(run, 'test-results.json'))}`)
          + ` FOREMAN_CODE_VITEST_CACHE=${quote(join(source, '..', 'vitest-cache'))}` : '') + integrationEnvironment,
      ...(database ? [`export FOREMAN_CODE_CI_HOST_RUN_ID=${quote(meta.runId)}`
        + ` FOREMAN_CODE_CI_DATABASE_CPUS=${databaseResources.cpuCount}`
        + ` FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES=${databaseResources.memoryBytes}`] : []),
      'mkdir -p "$TMPDIR"',
      `finish() { local code="$1";`
        + ' if [ -n "${preparation_pid:-}" ]; then wait "$preparation_pid" || true; fi;'
        + (database ? ` ${pm} db:down || { [ "$code" != 0 ] || code=1; }; trap - EXIT;` : '')
        + ` echo "$code" > ${quote(join(run, 'exit.tmp'))};`
        + ` mv -- ${quote(join(run, 'exit.tmp'))} ${quote(join(run, 'exit'))}; exit "$code"; }`,
      ...(database ? [`trap '${pm} db:down' EXIT`] : []),
      `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
      ...(meta.notice ? [`echo ${quote(meta.notice)}`] : []),
      ...(meta.message ? [`echo ${quote(meta.message)}`] : []),
      `mkdir -p ${quote(cache)} || finish $?`,
      `exec {cache_usage}<${quote(cache)}`,
      'flock -s "$cache_usage" || finish $?',
      'step install',
      ...install,
      // pnpm script commands can reinstall dependencies, so preparation must wait for installation.
      ...(prerequisites ? [`SUITE=${quote(prerequisiteSuite)} bash scripts/ci-suite.sh prepare`
        + ` >${quote(join(run, 'preparation.log'))} 2>&1 & preparation_pid=$!`] : []),
      ...(contracts ? ['step contracts', 'corepack pnpm --filter @foreman-code/contracts build || finish $?'] : []),
      ...(prerequisites ? ['step prepare', 'wait "$preparation_pid"; preparation_code=$?',
        `cat ${quote(join(run, 'preparation.log'))}`, '[ "$preparation_code" = 0 ] || finish "$preparation_code"'] : []),
      `echo "[ci-setup] setup completed in $(( $(date +%s%3N) - ${Date.parse(meta.startedAt)} )) ms"`,
      ...(command ? [`step ${meta.part ?? meta.suite}`,
        ...(database ? ['if [ -f "$TMPDIR/test-database-url" ]; then',
          '  export FOREMAN_CODE_CI_TEST_ADMIN_URL="$(cat "$TMPDIR/test-database-url")"', 'fi'] : []),
        `${watchedCommand} || finish $?`] : []),
      'finish 0', ''].join('\n')
  }

  private stoppedScript(meta: RunMeta): string {
    const run = this.runDirectory(meta.runId)
    const message = `CI_UNIT_DEADLINE_EXCEEDED: CI setup, execution or cleanup exceeded ${CI_UNIT_RUNTIME_SECONDS} seconds.`
    return ['#!/bin/bash', '[ "${SERVICE_RESULT:-}" = timeout ] || exit 0',
      `printf '%s\\n' ${shellQuote(message)} >> ${shellQuote(join(run, 'log'))}`,
      `printf '%s\\n' ${shellQuote(JSON.stringify({ message }))} > ${shellQuote(join(run, 'watchdog-message.json'))}`,
      `echo 124 > ${shellQuote(join(run, 'exit.tmp'))}`,
      `mv -- ${shellQuote(join(run, 'exit.tmp'))} ${shellQuote(join(run, 'exit'))}`, ''].join('\n')
  }

  private packageManager(source: string): string {
    if (existsSync(join(source, 'pnpm-lock.yaml'))) return 'corepack pnpm'
    if (existsSync(join(source, 'package-lock.json')) || existsSync(join(source, 'npm-shrinkwrap.json'))) return 'npm'
    if (existsSync(join(source, 'yarn.lock'))) return 'corepack yarn'
    return 'npm'
  }

  private partCommand(meta: RunMeta, quote: (value: string) => string): string {
    const output = join(this.runDirectory(meta.runId), 'measured-durations.json')
    const slice = meta.partition ? `${meta.partition.index + 1}/${meta.partition.count}` : ''
    // The runner already chose the scope; the hook must not derive its own selection.
    return `SUITE=${quote(meta.part!)} SCOPE=full SLICE=${quote(slice)} DURATIONS_OUTPUT=${quote(output)} bash scripts/ci-suite.sh`
  }

  private async finish(runId: string, state: CiHostRun['state'], exitCode: number | null, message: string | null) {
    const meta = await this.readMeta(runId)
    if (!['queued', 'starting', 'running'].includes(meta.state)) return
    const outcome = meta.cancellationRequested ? 'canceled' : state
    if (outcome === 'failed' || outcome === 'lost') this.invalidateReadiness()
    await this.writeMeta({ ...meta, state: outcome, exitCode, message, finishedAt: this.ports.now().toISOString() })
  }

  private async cleanDatabase(meta: RunMeta) {
    const directory = this.runDirectory(meta.runId)
    const source = meta.slot === undefined ? join(directory, 'src') : this.slotSource(meta.repository, meta.slot)
    const script = join(source, 'scripts/test-db.mjs')
    if (!existsSync(script) || meta.isolatedDatabase !== true) return
    const result = await this.ports.run('node', [script, 'down'], {
      cwd: source,
      env: { ...this.environment, FOREMAN_CODE_CI_HOST_RUN_ID: meta.runId,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '', TMPDIR: join(directory, 'tmp') },
    })
    if (result.code !== 0) throw new Error(`CI database cleanup failed: ${result.stderr.trim().slice(0, 500)}`)
  }

  private async retainedUnitStates(runIds: string[]): Promise<Map<string, CiUnitState>> {
    const pending: RunMeta[] = []
    for (const runId of runIds) {
      if (this.settledRuns.has(runId)) continue
      let meta: RunMeta
      try {
        meta = await this.readMeta(runId)
      } catch {
        // ignore: refreshRetained reports damaged records while preserving healthy runs.
        continue
      }
      if (['starting', 'running'].includes(meta.state) && !meta.cancellationRequested
        && !this.preparing.has(runId) && !this.starts.has(runId)
        && !existsSync(join(this.runDirectory(runId), 'exit'))) pending.push(meta)
    }
    const states = await readCiUnitStates(this.ports, pending.map(serviceUnit), this.environment)
    return new Map(pending.map(meta => [unitStateKey(meta), states.get(serviceUnit(meta))!]))
  }

  private async unitState(meta: RunMeta, states?: ReadonlyMap<string, CiUnitState>): Promise<CiUnitState> {
    const unit = serviceUnit(meta)
    // Launch may update metadata while the batched manager query is in flight.
    const cached = states?.get(unitStateKey(meta))
    if (cached !== undefined) return cached
    return (await readCiUnitStates(this.ports, [unit], this.environment)).get(unit)!
  }

  private async finishFromExit(meta: RunMeta): Promise<boolean> {
    const exit = await readFile(join(this.runDirectory(meta.runId), 'exit'), 'utf8')
      .catch(fallbackOnMissing(null))
    if (exit === null) return false
    if (exit.trim() === '') throw new DomainError('CI_EXIT_STATUS_INVALID', 'The CI exit status is empty.', 503)
    const code = Number(exit.trim())
    const watchdog = await readFile(join(this.runDirectory(meta.runId), 'watchdog-message.json'), 'utf8')
      .catch(fallbackOnMissing(null))
    let state: CiHostRun['state'] = code === 0 ? 'passed' : 'failed'
    if (meta.cancellationRequested) state = 'canceled'
    await this.finish(meta.runId, state,
      Number.isInteger(code) ? code : 1,
      watchdog ? CiWatchdogFailureSchema.parse(JSON.parse(watchdog)).message : meta.message)
    if (meta.cancellationRequested) await this.cleanDatabase(meta)
    return true
  }

  private async reconcile(meta: RunMeta, preparing: boolean, unitStates?: ReadonlyMap<string, CiUnitState>): Promise<void> {
    if (!['starting', 'running'].includes(meta.state) || preparing) return
    if (await this.finishFromExit(meta)) return
    if (meta.cancellationRequested) {
      const stop = await this.ports.run('systemctl', ['--user', 'stop',
        meta.serviceUnit ?? `${unitName(meta.runId)}.service`], { env: this.environment })
      if (stop.code !== 0) await this.writeMeta({ ...meta,
        message: 'Cancellation requested; the CI unit has not confirmed it stopped.' })
    }
    const state = await this.unitState(meta, meta.cancellationRequested ? undefined : unitStates)
    if (state === 'stopped') {
      // The unit can publish its exit status while the systemd query is in flight.
      if (await this.finishFromExit(meta)) return
      await this.cleanDatabase(meta)
      await this.finish(meta.runId, meta.cancellationRequested ? 'canceled' : 'lost', null,
        meta.cancellationRequested ? 'Canceled.' : 'The CI unit ended without an exit status.')
    } else if (state === 'active' && meta.state === 'starting') {
      const current = await this.readMeta(meta.runId)
      if (current.state === 'starting') await this.writeMeta({ ...current, state: 'running' })
    }
  }

  /** Reads the current state of a run, settling it once its unit has exited, and frees its worktree. */
  async refresh(runId: string, unitStates?: ReadonlyMap<string, CiUnitState>): Promise<CiHostRun> {
    const metaVersion = async () => {
      const info = await stat(join(this.runDirectory(runId), 'meta.json'))
      return info && `${info.ino}:${info.size}:${info.mtimeMs}`
    }
    const cached = this.settledRuns.get(runId)
    if (cached && cached.version === await metaVersion()) return cached.run
    // Launch can finish while the metadata read is awaiting I/O.
    const preparing = this.preparing.has(runId) || this.starts.has(runId)
    let meta = await this.readMeta(runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN'
        && existsSync(join(this.runDirectory(runId), 'cancel-requested'))) return null
      throw error
    })
    if (!meta) return this.canceledBeforeStart(runId)
    const directory = this.runDirectory(runId)
    // Status polls read every run; settled runs need no reconciliation lock.
    const settled = !['queued', 'starting', 'running'].includes(meta.state)
    if (settled) this.trackCacheWriter(runId)
    else this.trackCacheWriter(runId, meta.repository)
    // Local preparation owns reconciliation until it releases the run directory.
    const reconciled = settled || !preparing && await withHostCiRunLock(directory, async () => {
      await this.reconcile(await this.readMeta(runId), preparing, unitStates)
      return true
    }, { nonBlocking: true })
    if (!settled) meta = await this.readMeta(runId)
    if (!reconciled && meta.state === 'starting' && meta.serviceUnit && await this.unitState(meta, unitStates) === 'active') {
      // Launch holds the metadata lock while systemd can already expose an active service.
      await writeFile(join(directory, 'service-started'), '', { mode: 0o600 })
      meta = await this.readMeta(runId)
    }
    if (!['starting', 'running'].includes(meta.state)) this.trackCacheWriter(runId)
    if (!['queued', 'starting', 'running'].includes(meta.state) && !preparing && !this.preparing.has(runId)) {
      if (meta.cleaned) await rm(join(directory, 'vitest-cache'), { recursive: true, force: true })
      else meta = await withHostCiRunLock(directory, () => this.cleanSettledRun(runId), { nonBlocking: true }) ?? meta
    }
    const log = await stat(join(directory, 'log')).catch(fallbackOnMissing(null))
    const step = (await readFile(join(directory, 'step'), 'utf8').catch(fallbackOnMissing(''))).trim()
      || (meta.state === 'starting' && this.starts.has(runId) ? 'dispatch' : null)
    if (log === null && (meta.exitCode !== null || step && step !== 'dispatch')) {
      throw new DomainError('CI_LOG_UNAVAILABLE', 'The retained CI log is missing.', 503)
    }
    if (meta.exitCode === 0 && !step) {
      logIgnoredError('jobs', 'read completed CI progress',
        Object.assign(new Error('The completed CI step record is missing.'), { code: 'ENOENT' }), { runId })
    }
    const run = { runId, ...(meta.warmup ? { warmup: true } : {}),
      ...(meta.selection ? { selection: meta.selection } : {}),
      state: meta.state, step, exitCode: meta.exitCode, startedAt: meta.startedAt,
      finishedAt: meta.finishedAt, logBytes: log?.size ?? 0,
      message: this.runMessage(meta) }
    const version = settled && meta.cleaned && !preparing ? await metaVersion() : null
    if (version) this.settledRuns.set(runId, { version, run })
    else this.settledRuns.delete(runId)
    return run
  }

  private async cleanSettledRun(runId: string): Promise<RunMeta> {
    const meta = await this.readMeta(runId)
    if (['queued', 'starting', 'running'].includes(meta.state) || this.preparing.has(runId) || this.starts.has(runId)) {
      return meta
    }
    const directory = this.runDirectory(runId)
    if (!meta.cleaned) {
      const clone = join(this.root, 'git', ...meta.repository.split('/'))
      if (existsSync(join(directory, 'src'))) {
        const standalone = (await stat(join(directory, 'src/.git')).catch(fallbackOnMissing(null)))?.isDirectory()
        const removed = await this.withRepository(meta.repository, async () => {
          if (!standalone) {
            await this.runGit(['worktree', 'remove', '--force', join(directory, 'src')],
              { cwd: clone, env: this.environment })
          }
          await rm(join(directory, 'src'), { recursive: true, force: true })
          await this.runGit(['worktree', 'prune'], { cwd: clone, env: this.environment })
          return true
        }, { nonBlocking: true })
        if (!removed) return meta
      }
      await rm(join(directory, 'tmp'), { recursive: true, force: true })
    }
    // Older cleaned records can still hold the per-run test cache.
    await rm(join(directory, 'vitest-cache'), { recursive: true, force: true })
    if (meta.cleaned) return meta
    const cleaned = { ...meta, cleaned: true }
    await this.writeMeta(cleaned)
    return cleaned
  }

  private runMessage(meta: RunMeta): string | null {
    if (meta.cancellationRequested && ['starting', 'running'].includes(meta.state)) {
      return 'Cancellation requested; waiting for preparation and the CI unit to stop.'
    }
    return meta.message === null ? null : sanitizeCiText(meta.message)
  }

  private async cancelPreparation(runId: string) {
    const meta = await this.readMeta(runId)
    if (!meta.cancellationRequested) return false
    await this.finish(runId, 'canceled', null, 'Canceled before execution.')
    return true
  }

  private async canceledBeforeStart(runId: string): Promise<CiHostRun> {
    if (this.startingRun?.runId === runId) {
      return { ...this.startingRun, message: 'Cancellation requested; waiting for preparation to stop.' }
    }
    const requested = await stat(join(this.runDirectory(runId), 'cancel-requested'))
    return { runId, state: 'canceled', step: null, exitCode: null,
      startedAt: requested.mtime.toISOString(), finishedAt: requested.mtime.toISOString(),
      logBytes: 0, message: 'Canceled before execution.' }
  }

  async cancel(runId: string): Promise<CiHostRun> {
    const meta = await this.readMeta(runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
      throw error
    })
    if (!meta || ['queued', 'starting', 'running'].includes(meta.state)) {
      const directory = this.runDirectory(runId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        await writeFile(join(directory, 'cancel-requested'), '', { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // The first marker keeps the cancellation timestamp stable on retries.
      }
      this.preparationAborts.get(runId)?.abort(new Error('CI preparation canceled.'))
      if (!meta) return this.refresh(runId)
      if (meta.state === 'queued') {
        await withHostCiRunLock(directory, () => this.finish(runId, 'canceled', null, 'Canceled before execution.'))
      }
      await this.preparing.get(runId)
    }
    return this.refresh(runId)
  }
}
