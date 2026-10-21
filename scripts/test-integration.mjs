import { diagnosticWarning } from './diagnostic-warning.mjs'
import { exclusiveIntegrationFiles, integrationCpuCost,
  requirements } from '../packages/contracts/src/integrationScheduling.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { integrationEnvironmentCapabilities, partitionIntegrationCapabilities } from './integration-capabilities.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, freemem } from 'node:os'
import { delimiter, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanupTestResources, createTestDatabase, createTestRoot, dropTestDatabase, recoverAbandonedTestRoots,
  removeTestRoot, requireTestServerUrl,
  resetTestDatabase, settleTestResources, testAdminPool, testEnvironment } from './test-resources.mjs'
import { createTestDatabaseTemplate, dropTestDatabaseTemplate } from './test-database-template.mjs'
import { ciTemplateCacheDirectory } from './ci-postgres-cache.mjs'
import { readIntegrationStartup } from './integration-startup.mjs'
import { integrationPhaseForwarder } from './integration-phase.mjs'
import { testFixtureCacheRoot } from './test-fixture-cache.mjs'
import { sweepRestartUnits } from './test-restart-units.mjs'
import { adaptiveDeadlineMs, groupUsed, integrationProcessLimits, integrationProcessProgress, stopGroup,
  superviseIntegrationProcess } from './integration-process.mjs'
import { boundedLog, emptyCounts, junitReport, logArchive, mergedVitestReport, positiveInteger,
  readVitestReport, privateDirectory, writeReport } from './verification-reports.mjs'
import { scheduleQueue } from './dense-scheduler.mjs'
import { reusableIntegrationFile, startSlotServer, stopSlotServer, stopStrayProcesses } from './integration-slot-process.mjs'
import { writeCiTestResults } from './ci-test-results.mjs'
import { readProfiles, startProcessMetrics, writeProfiles } from './dense-resources.mjs'
import { integrationCoverageReport } from './integration-coverage.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const startupFile = 'apps/api/test/dev-startup.integration.test.ts'

export function partitionIntegrationFiles(files) {
  return {
    exclusive: exclusiveIntegrationFiles.filter(file => files.includes(file)),
    parallel: files.filter(file => !exclusiveIntegrationFiles.includes(file)),
  }
}

export function isIntegrationTestPath(file) {
  if (!file.startsWith('apps/api/test/') || !file.endsWith('.integration.test.ts')) return false
  return posix.normalize(file) === file && file.split('/').every((part) => part && part !== '.' && part !== '..')
}

export function isRegularIntegrationFile(base, file) {
  if (!isIntegrationTestPath(file)) return false
  try {
    let path = base
    for (const part of file.split('/')) {
      path = join(path, part)
      if (lstatSync(path).isSymbolicLink()) return false
    }
    return lstatSync(path).isFile()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

export function discoverFiles() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/api/test'], { cwd: root })
  if (result.status !== 0) throw new Error('Could not discover tracked integration files')
  const files = result.stdout.toString('utf8').split('\0').filter((file) => isRegularIntegrationFile(root, file)).sort()
  if (!files.length || !files.includes(startupFile)) throw new Error('Integration file discovery is incomplete')
  return files
}

export function selectFiles(files, startAt) {
  if (!startAt) return files
  if (!files.includes(startAt)) throw new Error(`Unknown --start-at integration file: ${startAt}`)
  return files.slice(files.indexOf(startAt))
}

export function selectExactFiles(files, requested) {
  if (!requested.length) throw new Error('--files requires at least one integration file')
  const known = new Set(files)
  for (const file of requested) {
    if (!known.has(file)) throw new Error(`Unknown --files integration file: ${file}`)
  }
  return [...new Set(requested)].sort()
}

export function failedFilesFromLog(output, files) {
  const known = new Set(files)
  const failed = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[integration\] (?:FAIL|HUNG) (.*) \(slot \d+, exit /.exec(line)
    if (!match) continue
    if (!known.has(match[1])) throw new Error(`Unknown failed integration file: ${match[1]}`)
    failed.add(match[1])
  }
  if (!failed.size) throw new Error('The integration log contains no failed files')
  return [...failed].sort()
}

export function integrationLogPath(base, file) {
  if (!isIntegrationTestPath(file)) throw new Error(`Invalid integration log path: ${file}`)
  return join(base, `${file.slice('apps/api/test/'.length)}.log`)
}

/** Failing case names from a Vitest log, so failures can be acted on while the run continues. */
export function failedCasesFromLog(output) {
  const names = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map((line) => /^\s*FAIL\s+\S+\s+>\s+(.+)$/.exec(line)?.[1].trim()).filter(Boolean)
  return [...new Set(names)]
}

/** Where a hung file stopped: its last finished case and its last output line, when the log has them. */
export function hungContext(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[integration]'))
  const lastCase = lines.findLast((line) => /^[✓✔×✗↓]\s+\S.* > /.test(line))
  return { lastCase: lastCase?.replace(/^\S+\s+/, '').replace(/\s+\d+ms$/, '').slice(0, 500) ?? null,
    lastOutput: lines.at(-1)?.slice(0, 500) ?? null }
}

/** Fixed per-file overhead: milliseconds from the file's launch until its test module was collected. */
export function startupText(phases) {
  const collected = phases.find((phase) => phase.phase === 'module-collected')
  return collected ? `; startup ${collected.elapsedMs} ms` : ''
}

export function parseVitestCases(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  const line = lines.findLast((item) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(item))
  if (!line) return null
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)/g)) {
    counts[match[2] === 'todo' || match[2] === 'pending' ? 'skipped' : match[2]] += Number(match[1])
  }
  const total = Number(line.match(/\((\d+)\)\s*$/)[1])
  return counts.passed + counts.failed + counts.skipped === total ? { ...counts, total } : null
}

export function failForSkippedCases(summary, startAt) {
  return !startAt && Boolean(summary?.skipped)
}

/** Host gates already carry their shard allocation; cloud gates can pass an explicit marker. */
export function integrationGate(environment) {
  return environment.FOREMAN_CODE_CI_GATE === '1'
    || environment.FOREMAN_CODE_CI_INTEGRATION_SHARDS !== undefined
}

export function autoRetestFiles(failedFiles, { interrupted }) {
  return interrupted ? [] : [...new Set(failedFiles)].sort()
}

export function integrationVitestArguments(file, testNamePattern, json) {
  return ['run', file.replace('apps/api/', ''), '--no-file-parallelism', '--maxWorkers=1',
    '--maxConcurrency=1', '--reporter=verbose', ...(json ? ['--reporter=json', `--outputFile.json=${json}`] : []),
    `--reporter=${join(root, 'scripts', 'integration-startup-reporter.mjs')}`,
    '--fsModuleCache',
    ...(testNamePattern ? ['--testNamePattern', testNamePattern] : [])]
}

export function vitestCommand(environment, file, testNamePattern, json) {
  const api = join(root, 'apps', 'api')
  // Preserve package binaries on PATH without pnpm's per-file startup cost.
  const path = [join(api, 'node_modules', '.bin'), join(root, 'node_modules', '.bin'), environment.PATH]
    .filter(Boolean).join(delimiter)
  return {
    command: join(api, 'node_modules', '.bin', 'vitest'),
    args: integrationVitestArguments(file, testNamePattern, json),
    cwd: api,
    env: { ...environment, PATH: path },
  }
}

export function orderByDuration(files, durations) {
  const duration = (file) => Number.isFinite(durations[file]) && durations[file] >= 0 ? durations[file] : Infinity
  return [...files].sort((a, b) => duration(b) - duration(a))
}

/** Main supplies expectations from the CI database; unmeasured files use the scheduler's fallback. */
export function integrationDurationsPath(environment) {
  const snapshot = join(root, 'scripts/ci-learned-durations.json')
  return readProductEnvironment(environment, 'INTEGRATION_DURATIONS') || (existsSync(snapshot) ? snapshot : null)
}

/** Wall time of each file that passed on its first attempt; failed and hung files say nothing about their usual time. */
export function measuredDurations(firstPass) {
  return Object.fromEntries(firstPass.filter((record) => record.code === 0 && record.complete
    && Number.isFinite(record.elapsedMs) && record.elapsedMs > 0).map((record) => [record.file, record.elapsedMs]))
}

export function readDurations(path) {
  if (!path) return {}
  try {
    const durations = JSON.parse(readFileSync(path, 'utf8'))
    return durations && typeof durations === 'object' && !Array.isArray(durations) ? durations : {}
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}
    console.error(`[integration] could not read file durations: ${error.message}`)
    return {}
  }
}

export function mergeDurations(previous, recorded, files) {
  const known = new Set(files)
  return Object.fromEntries(Object.entries({ ...previous, ...recorded })
    .filter(([file, ms]) => known.has(file) && Number.isFinite(ms) && ms >= 0))
}

export function writeDurations(path, durations) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(durations, null, 1)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function fullRunExitCode(failed, interrupted) {
  return interrupted === 'SIGINT' ? 130 : interrupted ? 143 : failed ? 1 : 0
}

export function finalizeIntegrationResult({ report, results = [], selectedFiles, reportDirectory,
  interrupted, diagnostic, cleanupError, error }) {
  const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : cleanupError
  const runnerMessage = error instanceof Error ? error.message : error
  if (cleanupMessage) report.cleanupError = cleanupMessage
  if (runnerMessage || cleanupMessage) {
    report.error = runnerMessage ?? cleanupMessage
    report.completeness = 'partial'
    report.outcome = interrupted ? 'cancelled' : 'incomplete'
  }
  const gateResults = results.filter((result) => !selectedFiles.includes(result.id))
  const failed = report.files.some((file) => file.code !== 0 || !file.complete)
    || gateResults.some((result) => result.status !== 'PASSED')
    || report.disallowedSkipped || report.publicationError || runnerMessage || cleanupMessage
    || (!diagnostic && report.outcome !== 'passed')
  return { code: fullRunExitCode(failed, interrupted), results, gateResults, selectedFiles,
    reportDirectory, report, ...(cleanupMessage ? { cleanupError: cleanupMessage } : {}),
    ...(report.error ? { error: report.error } : {}) }
}

function recordFileAttempt(reports, file, details) {
  const existing = reports.find((record) => record.file === file)
  if (existing) Object.assign(existing, details)
  else reports.push({ file, ...details })
}

export function integrationReport(selected, firstPass, retests, { startedAt, finishedAt, interrupted,
  diagnostic, processStopped, environment }) {
  const totals = emptyCounts()
  const files = selected.map((file) => {
    const result = firstPass.find((record) => record.file === file)
    if (!result) return { file, code: null, complete: false, reason: 'not executed' }
    if (result.report) for (const name of Object.keys(totals)) totals[name] += result.report.totals[name]
    const { report, ...details } = result
    const retest = retests.find((record) => record.file === file)
    let status = result.status
    if (!status && result.code !== null) {
      status = result.code === 0 ? 'PASSED' : 'FAILED'
      if (result.code !== 0 && retest?.code === 0 && retest.complete) status = 'FLAKY'
    }
    return { ...details, ...(status ? { status } : {}), totals: report?.totals ?? emptyCounts() }
  })
  const hungFiles = files.filter((file) => file.status === 'HUNG').map((file) => file.file)
  const completedPortions = files.filter((file) => file.complete).length
  const firstPassFailed = files.filter((file) => file.code !== null && file.code !== 0).length
  const complete = completedPortions === selected.length && !diagnostic && processStopped
  let outcome = complete ? 'passed' : 'incomplete'
  if (complete && (firstPassFailed || totals.failed || totals.skipped)) outcome = 'failed'
  if (interrupted) outcome = 'cancelled'
  return { schemaVersion: 1, suite: 'integration', startedAt, finishedAt, totals, environment,
    expectedPortions: selected.length, completedPortions, firstPassFailed, hungFiles,
    disallowedSkipped: diagnostic ? 0 : totals.skipped,
    completeness: complete ? 'complete' : 'partial', outcome, files,
    retests: retests.map(({ report, ...result }) => ({ ...result, totals: report?.totals ?? emptyCounts() })) }
}

export function integrationShardLimit(value, maximum = 64) {
  const limit = value === undefined ? Math.min(12, maximum) : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Integration shards must be an integer from 1 to ${maximum}`)
  }
  return limit
}

/** A request above what this computer can hold right now runs at the measured limit instead of failing. */
function requestedShards(value, maximum) {
  const requested = Number(value)
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('Integration shards must be a positive integer')
  return Math.min(requested, maximum)
}

export function reservedIntegrationShards(environment, maximum = 12) {
  if (!environment.FOREMAN_CODE_VERIFICATION_ROOT) {
    return requestedShards(readProductEnvironment(environment, 'INTEGRATION_SHARDS') ?? String(maximum), maximum)
  }
  if (!environment.FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS
    || !environment.FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS) {
    throw new Error('Integration Jobs require reserved and qualified shard limits')
  }
  const reserved = integrationShardLimit(environment.FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS)
  const qualified = integrationShardLimit(environment.FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS)
  const requested = requestedShards(readProductEnvironment(environment, 'INTEGRATION_SHARDS')
    ?? String(Math.min(reserved, maximum)), maximum)
  if (requested > reserved || requested > qualified) {
    throw new Error('Integration shards exceed the accepted reservation or suite qualification')
  }
  return requested
}

function availableIntegrationMemory() {
  let available = freemem()
  if (process.platform === 'linux') {
    try {
      const kilobytes = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
      if (kilobytes !== undefined) available = Number(kilobytes) * 1024
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error
    }
  }
  if (process.constrainedMemory() > 0) available = Math.min(available, process.availableMemory())
  return available
}

export async function readIntegrationResources(admin, host = {
  cpuCount: availableParallelism(), availableMemoryBytes: availableIntegrationMemory(),
}) {
  try {
    const { rows } = await admin.query(`select
      current_setting('max_connections')::integer as "maxConnections",
      (current_setting('superuser_reserved_connections')::integer
        + coalesce(current_setting('reserved_connections', true), '0')::integer) as "reservedConnections",
      (select count(*)::integer from pg_stat_activity where backend_type = 'client backend') as "activeConnections"`)
    const capacity = rows[0]
    if (!capacity || !Number.isSafeInteger(capacity.maxConnections) || capacity.maxConnections < 1
      || !Number.isSafeInteger(capacity.reservedConnections) || capacity.reservedConnections < 0
      || !Number.isSafeInteger(capacity.activeConnections) || capacity.activeConnections < 0) {
      throw new Error('PostgreSQL capacity discovery returned invalid limits.')
    }
    return { ...host, ...capacity }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? ` (${error.code})` : ''
    throw new Error(`PostgreSQL capacity discovery failed${code}; integration shards cannot be planned.`)
  }
}

export function integrationShardPlan(environment, resources = {}, fileCount = Infinity) {
  let { cpuCount, availableMemoryBytes } = resources
  const { maxConnections, reservedConnections, activeConnections } = resources
  const slotCpu = environment.FOREMAN_CODE_CI_CPU_COUNT
  const slotMemory = environment.FOREMAN_CODE_CI_MEMORY_BYTES
  if (slotCpu !== undefined) {
    const budget = positiveInteger(Number(slotCpu), 'CI slot CPU count')
    cpuCount = Math.min(cpuCount ?? budget, budget)
  }
  if (slotMemory !== undefined) {
    const budget = positiveInteger(Number(slotMemory), 'CI slot memory bytes')
    availableMemoryBytes = Math.min(availableMemoryBytes ?? budget, budget)
  }
  const knownCpu = Number.isSafeInteger(cpuCount) && cpuCount > 0
  const knownMemory = Number.isSafeInteger(availableMemoryBytes) && availableMemoryBytes >= 0
  const knownDatabase = Number.isSafeInteger(maxConnections) && maxConnections > 0
    && Number.isSafeInteger(reservedConnections) && reservedConnections >= 0
    && Number.isSafeInteger(activeConnections) && activeConnections >= 0
  // One worker uses the default ten-connection pool plus admin and peer connections.
  const connectionsPerShard = 16
  // Each shard reserves one logical CPU and 1.5 GiB of memory.
  const memoryPerShard = 1.5 * 1024 ** 3
  const cpuLimit = knownCpu ? cpuCount : 12
  const memoryLimit = knownMemory ? Math.floor(availableMemoryBytes / memoryPerShard) : 12
  const freeConnections = knownDatabase ? maxConnections - reservedConnections - activeConnections : null
  const databaseLimit = knownDatabase ? Math.floor(freeConnections / connectionsPerShard) : 12
  const ciShardCeiling = environment.FOREMAN_CODE_CI_INTEGRATION_SHARDS
  const ciShardLimit = ciShardCeiling === undefined ? Infinity : integrationShardLimit(ciShardCeiling)
  const limit = Math.min(cpuLimit, memoryLimit, databaseLimit, ciShardLimit)
  const reasons = [
    knownCpu ? `CPU limit ${cpuLimit}` : 'CPU unknown (fallback 12)',
    knownMemory ? `memory limit ${memoryLimit} (${availableMemoryBytes} available bytes, 1.5 GiB/shard)`
      : 'memory unknown (fallback 12)',
    knownDatabase ? `PostgreSQL limit ${databaseLimit} (max_connections=${maxConnections},`
      + ` ${reservedConnections} reserved, ${activeConnections} occupied, ${connectionsPerShard} connections/shard)`
      : 'PostgreSQL limits unknown (fallback 12)',
  ]
  if (ciShardCeiling !== undefined) reasons.push(`CI shard ceiling ${ciShardLimit}`)
  if (slotCpu !== undefined || slotMemory !== undefined) reasons.push('limited to this CI slot share')
  if (limit < 1) throw new Error(`No integration shard fits available resources: ${reasons.join('; ')}`)
  const requested = readProductEnvironment(environment, 'INTEGRATION_SHARDS')
  const selected = reservedIntegrationShards(environment, limit)
  if (requested !== undefined) reasons.push(`requested ${requested}`)
  if (environment.FOREMAN_CODE_VERIFICATION_ROOT) {
    reasons.push(`CI reservation ${environment.FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS}`
      + `, qualification ${environment.FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS}`)
  }
  const shards = Math.min(selected, fileCount)
  if (fileCount < selected) reasons.push(`${fileCount} runnable files`)
  return { shards, limit, reason: reasons.join('; ') }
}

export async function scheduleFiles(files, slots, runFile, shouldStop = () => false) {
  let next = 0
  const outcomes = []
  await Promise.all(slots.map(async (slot) => {
    while (!shouldStop() && next < files.length) {
      const file = files[next++]
      let result
      try { result = await runFile(slot, file) }
      catch (error) { result = { code: 1, error } }
      outcomes.push({ slot, file, ...result })
      if (result.slotUnavailable) break
    }
  }))
  return { outcomes, skipped: files.length - next, unexecuted: files.slice(next) }
}

export async function scheduleIntegrationQueue(files, slots, {
  extraItems = [], executeExtra, runFile, prepareRetest = async () => {}, gate = false,
  maxConcurrency, profiles = {}, durations = {}, samplePressure, shouldStop = () => false, onEvent,
  pollIntervalMs, onProcessFailure = () => {},
}) {
  const queueProfiles = { ...profiles }
  const integrationItems = files.map((file) => {
    const durationMs = profiles[file]?.durationMs ?? durations[file]
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      queueProfiles[file] = { ...profiles[file], durationMs }
    }
    const cpuCost = integrationCpuCost(file, maxConcurrency, profiles[file]?.durationMs, durations[file])
    return { id: file, file, kind: 'integration', cpuCost,
      exclusive: exclusiveIntegrationFiles.includes(file) }
  })
  const items = [...integrationItems, ...extraItems]
  const busy = new Set()
  let usedCpuSlots = 0
  let processFailure
  const freeSlot = () => slots.find((slot) => !slot.unavailable && !busy.has(slot.index))
  return scheduleQueue(items, {
    maxConcurrency, profiles: queueProfiles, samplePressure,
    dedicated: process.env.FOREMAN_CODE_CI_DEDICATED === '1',
    shouldStop: () => Boolean(processFailure) || shouldStop(),
    onEvent: (event) => {
      if (event.type === 'start') usedCpuSlots += event.item.cpuCost ?? 1
      if (event.type === 'finish') usedCpuSlots -= event.item.cpuCost ?? 1
      onEvent?.(event)
    },
    pollIntervalMs, retest: !gate,
    canUseWorker: (_index, item) => usedCpuSlots + (item.cpuCost ?? 1) <= maxConcurrency
      && (item.kind !== 'integration' || Boolean(freeSlot())),
    execute: async (item, context) => {
      if (item.kind !== 'integration') return executeExtra(item, context)
      const slot = freeSlot()
      if (!slot) return { code: 1, complete: false, reason: 'No usable integration slot' }
      busy.add(slot.index)
      try {
        if (context.isRetest) await prepareRetest(slot, item.file)
        const result = await runFile(slot, item.file, context)
        if (result.slotUnavailable) slot.unavailable = true
        if (result.ownedProcessActive) {
          processFailure = result.reason ?? `Integration slot ${slot.index} still owns a child process group`
          onProcessFailure(processFailure)
        }
        // Database retirement does not retire a worker used by non-database gate checks.
        return { ...result, slotUnavailable: false }
      } catch (error) {
        slot.unavailable = true
        return { code: 1, complete: false, reason: error.message }
      } finally {
        busy.delete(slot.index)
      }
    },
  })
}

export function integrationTimeouts(environment, timeoutScale = 1) {
  const timeouts = { ...integrationProcessLimits }
  for (const [setting, variable] of [
    ['idleTimeoutMs', 'FOREMAN_CODE_INTEGRATION_IDLE_TIMEOUT_MS'],
    ['fileTimeoutMs', 'FOREMAN_CODE_INTEGRATION_FILE_TIMEOUT_MS'],
  ]) {
    const selected = readProductEnvironment(environment, variable.slice('FOREMAN_CODE_'.length))
    if (selected === undefined) continue
    const value = Number(selected)
    if (!Number.isSafeInteger(value) || value < 1000 || value > 60 * 60_000) {
      throw new Error(`${variable} must be an integer from 1000 to 3600000 ms`)
    }
    timeouts[setting] = value
  }
  timeouts.idleTimeoutMs = Math.ceil(timeouts.idleTimeoutMs * Math.max(1, timeoutScale))
  timeouts.fileTimeoutMs = Math.ceil(timeouts.fileTimeoutMs * Math.max(1, timeoutScale))
  return timeouts
}

export function integrationProgressLine({ phase, total, passed, failed, active, slotCount,
  usableCount = slotCount }, now = Date.now()) {
  const completed = passed + failed
  const queued = Math.max(0, total - completed - active.size)
  const running = [...active].map(([index, { file, progress }]) => {
    const elapsed = Math.floor((now - progress.started) / 1000)
    const idle = Math.floor((now - progress.lastOutputAt) / 1000)
    return `slot ${index}: ${file}, elapsed ${elapsed}s, output idle ${idle}s, ${progress.bytes} bytes`
  })
  const summary = `[integration] PROGRESS ${phase}: ${completed}/${total} completed`
    + ` (${passed} passed, ${failed} failed); ${active.size}/${slotCount} slots active; ${queued} queued`
    + (usableCount < slotCount ? `; ${slotCount - usableCount} retired` : '')
  return `${summary}${running.length ? `; ${running.join('; ')}` : ''}.`
}

function procStart(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') diagnosticWarning('read integration process identity', error)
    return null
  }
}

export function hasActiveHeavyJobToken(environment, common, owner) {
  return Boolean(owner?.token && readProductEnvironment(environment, 'HEAVY_JOB_COMMON') === common
    && readProductEnvironment(environment, 'HEAVY_JOB_TOKEN') === owner.token
    && owner.pid > 0 && procStart(owner.pid) === owner.start)
}

export function hasHeavyJobAdmission(environment, common) {
  const state = join(common, 'graphql-heavy-jobs')
  const paths = [join(state, 'active', 'owner.json')]
  try { paths.push(...readdirSync(join(state, 'running')).map((name) => join(state, 'running', name))) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return paths.some((path) => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'))
      return owner?.common === common && hasActiveHeavyJobToken(environment, common, owner)
    } catch { return false }
  })
}

export function signalOwnedChildren(active, timers, signal, graceMs = 5000) {
  for (const [index, { child }] of active) {
    if (!child.pid) continue
    try { process.kill(-child.pid, signal) } catch { /* already exited */ }
    if (!timers.has(index)) timers.set(index, setTimeout(() => {
      if (groupUsed(child.pid)) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
    }, graceMs))
  }
}

export function integrationEnvironment(environment, slot) {
  return testEnvironment(environment, slot)
}

export function options(argv, environment = process.env) {
  const startAt = readProductEnvironment(environment, 'INTEGRATION_START_AT') || null
  const failedFrom = readProductEnvironment(environment, 'INTEGRATION_FAILED_LOG') || null
  if (!argv.length) {
    if (startAt && failedFrom) throw new Error('Choose either a resume cursor or a failed-file log')
    return { startAt, failedFrom, files: null }
  }
  if (argv[0] === '--files' && argv.length > 1 && !startAt && !failedFrom) {
    return { startAt: null, failedFrom: null, files: argv.slice(1) }
  }
  if (argv.length === 2 && argv[0] === '--start-at' && argv[1] && !failedFrom) return { startAt: argv[1], failedFrom: null }
  if (argv.length === 2 && argv[0] === '--failed-from' && argv[1] && !startAt) return { startAt: null, failedFrom: argv[1] }
  throw new Error('Usage: test-integration.mjs [--files <integration files...> | --start-at <integration file> | --failed-from <runner log>]')
}

async function main() {
  options(process.argv.slice(2))
  const commonResult = spawnSync('git', ['rev-parse', '--path-format=absolute',
    process.env.CI_HOST_RUNNER === '1' ? '--git-dir' : '--git-common-dir'], { cwd: root, encoding: 'utf8' })
  if (commonResult.status !== 0) throw new Error('Could not find the project heavy-job queue')
  const common = realpathSync(commonResult.stdout.trim())
  if (!hasHeavyJobAdmission(process.env, common)) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./heavy-job.mjs', import.meta.url)), '--timeout-ms', '9000000', '--', process.execPath, import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)) })
    return
  }
  const result = await runIntegration(process.argv.slice(2))
  process.exitCode = result.code
}

export async function runIntegration(argv = [], {
  extraItems = [], executeExtra, reportDirectory, profilePath, env = process.env, contractsBuilt = false,
} = {}) {
  const { startAt, failedFrom, files } = options(argv, env)
  const recoveryAdmin = await testAdminPool()
  try {
    const recovered = await recoverAbandonedTestRoots(recoveryAdmin)
    console.log(`[integration] disposable recovery: ${recovered.removed.length} removed;`
      + ` ${recovered.retained.length} retained.`)
    for (const retained of recovered.retained) {
      console.log(`[integration] retained ${retained.directory}: ${retained.reason}`)
    }
  } finally { await recoveryAdmin.end() }
  const gate = integrationGate(env) || extraItems.length > 0
  if (!contractsBuilt) {
    const contractsBuild = spawnSync('corepack', ['pnpm', '--dir', 'packages/contracts', 'build'],
      { cwd: root, stdio: 'inherit', env })
    if (contractsBuild.status !== 0) throw new Error('Integration contracts build failed')
  }
  const allFiles = discoverFiles()
  let selected = selectFiles(allFiles, startAt)
  if (failedFrom) selected = failedFilesFromLog(readFileSync(failedFrom, 'utf8'), allFiles)
  if (files) selected = selectExactFiles(allFiles, files)
  const environment = await integrationEnvironmentCapabilities(env)
  const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
  const testNamePattern = readProductEnvironment(env, 'INTEGRATION_TEST_NAME_PATTERN')
  const diagnostic = Boolean(startAt || failedFrom || files || testNamePattern)
  const profilesPath = resolve(profilePath ?? env.GRAPHQL_TEST_PROFILE_PATH ?? join(root, '.logs', 'test-profiles.json'))
  const profiles = readProfiles(profilesPath)
  // TEST_DATABASE_URL only selects the loopback server; every slot still gets
  // its own disposable database there, so the run stays fully parallel.
  if (env.TEST_DATABASE_URL) requireTestServerUrl(env.TEST_DATABASE_URL)
  if (env.FOREMAN_CODE_VERIFICATION_ROOT && !env.TEST_DATABASE_URL) {
    throw new Error('Integration Jobs require an explicit Job-local test database URL')
  }
  const timeouts = integrationTimeouts(env)
  const expectedDurations = readDurations(integrationDurationsPath(env))
  const admin = await testAdminPool()
  let shardPlan
  try {
    shardPlan = integrationShardPlan(env, await readIntegrationResources(admin), runnable.length)
  } catch (error) {
    await admin.end()
    throw error
  }
  const shardCount = shardPlan.shards
  const maximum = reservedIntegrationShards(env, shardPlan.limit)
  const concurrency = Math.max(1, Math.min(maximum, runnable.length + extraItems.length))
  const slots = []
  const active = new Map()
  const killTimers = new Map()
  const tempRoot = createTestRoot(undefined, 'graphql-integration-')
  const retainedDirectory = join(root, '.logs', 'test-integration')
  mkdirSync(retainedDirectory, { recursive: true })
  const destination = reportDirectory ?? env.FOREMAN_CODE_VERIFICATION_REPORT_DIR
  const failedLogs = destination
    ? privateDirectory(join(destination, 'parts', 'integration'))
    : createTestRoot(retainedDirectory).directory
  const startedAt = new Date().toISOString()
  const firstPass = [...unavailable]
  const retestReports = []
  const logBytes = positiveInteger(Number(env.FOREMAN_CODE_VERIFICATION_LOG_BYTES
    ?? readProductEnvironment(env, 'INTEGRATION_LOG_BYTES') ?? 8 * 1024 * 1024), 'Integration log byte limit')
  const reportBytes = positiveInteger(Number(env.FOREMAN_CODE_VERIFICATION_REPORT_BYTES
    ?? readProductEnvironment(env, 'INTEGRATION_REPORT_BYTES') ?? 32 * 1024 * 1024), 'Integration report byte limit')
  const abortController = new AbortController()
  let interrupted = null
  let fatalProcessError
  const shouldStopQueue = () => Boolean(interrupted || fatalProcessError)
  const stopForProcessFailure = (reason) => {
    if (fatalProcessError) return
    fatalProcessError = reason
    abortController.abort(reason)
    signalOwnedChildren(active, killTimers, 'SIGTERM')
    console.error(`[integration] queue stopped: ${reason}`)
  }
  const interrupt = (signal) => {
    interrupted ??= signal
    abortController.abort(signal)
    signalOwnedChildren(active, killTimers, signal)
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  let passed = 0
  let failed = 0
  let hung = 0
  let skipped = 0
  let unreported = 0
  const failedFiles = []
  const hungFiles = []
  const retestFailedFiles = new Set()
  const cases = { passed: 0, failed: 0, skipped: 0 }
  const retest = { passed: 0, failed: 0, skipped: 0 }
  let phase = 'first pass'
  let phaseTotal = runnable.length
  let heartbeat
  let queueResult
  let finalResult
  let template
  const reportProgress = () => {
    const counts = phase.startsWith('retest') ? retest : { passed, failed }
    console.log(integrationProgressLine({ phase, total: phaseTotal, ...counts, active, slotCount: shardCount,
      usableCount: slots.filter((slot) => !slot.unavailable).length }))
  }
  const resetSlotDatabase = async (slot) => {
    const started = performance.now()
    Object.assign(slot, await resetTestDatabase(admin, slot))
    slot.used = false
    slot.databaseSetupMs = performance.now() - started
    delete slot.resetError
  }
  // An idle reusable coordinator ends before its slot runs a fresh process, is rebuilt, or is cleaned up.
  const dropSlotServer = async (slot) => {
    const server = slot.server
    slot.server = undefined
    try { await stopSlotServer(server) }
    catch (error) { slot.resetError = error; throw error }
  }
  const recordUnexecuted = (files, phase = 'first', reason = 'no usable integration slots') => {
    const isRetest = phase === 'retest'
    for (const file of files) {
      if (isRetest) {
        if (!retestFailedFiles.has(file)) {
          retest.failed++
          retestFailedFiles.add(file)
        }
      } else {
        failed++
        unreported++
        failedFiles.push(file)
      }
      recordFileAttempt(isRetest ? retestReports : firstPass, file,
        { code: isRetest ? 1 : null, complete: false, reason, status: 'NOT_RUN' })
      console.error(`[integration] ${isRetest ? 'RETEST ' : ''}FAIL ${file} (slot 0, exit 1);`
        + ` not executed: ${reason}; log: unavailable`)
    }
  }
  try {
    template = await createTestDatabaseTemplate(admin, tempRoot, { cacheDirectory: ciTemplateCacheDirectory(env) })
    console.log(`[integration] database template ${template.hash}; migration import ${Math.round(template.timings.importMs)} ms;`
      + ` migrations ${Math.round(template.timings.migrationMs)} ms; setup ${Math.round(template.timings.setupMs)} ms;`
      + ` ${template.persistent ? 'persistent' : 'job'} template.`)
    for (let index = 0; index < shardCount; index++) {
      if (interrupted) throw new Error(`Interrupted during database setup (${interrupted})`)
      const resource = createTestRoot(tempRoot.directory, `slot-${index + 1}-`)
      const started = performance.now()
      const database = await createTestDatabase(admin, resource, { template })
      slots.push({ index: index + 1, ...database, used: false, databaseSetupMs: performance.now() - started })
    }
    console.log(`[integration] ${allFiles.length} files discovered; ${selected.length} selected; ${shardCount} ${shardCount === 1 ? 'slot' : 'slots'}.`)
    console.log(`[integration] chosen shards ${shardCount}, resource cap ${shardPlan.limit}: ${shardPlan.reason}.`)
    console.log(`[integration] CPU budget ${concurrency}; installed-Worker or measured >=60 s files use`
      + ` ${Math.min(2, concurrency)} slots; other work uses 1.`)
    for (const entry of unavailable) console.error(`[integration] UNAVAILABLE ${entry.file}: ${entry.reason}`)
    console.log(`[integration] process watchdog: ${timeouts.idleTimeoutMs} ms without output; ${timeouts.fileTimeoutMs} ms per file;`
      + ` a file with a known duration is hung after 3x that (at least 60 s more); ${Object.keys(expectedDurations).length} durations known.`)
    heartbeat = setInterval(reportProgress, 30_000)
    if (files) console.log('[integration] REQUESTED files only; skipped cases still fail this run.')
    if (startAt) console.log(`[integration] RESUME at ${startAt}: partial run only; a clean full run is required for suite proof.`)
    if (failedFrom) console.log(`[integration] RETEST ${selected.length} failed files from ${failedFrom}: partial run only; a clean full run is required for suite proof.`)
    if (files) console.log('[integration] Selected-file run; results cover only the requested files.')
    if (testNamePattern) console.log(`[integration] DIAGNOSTIC case selection: ${JSON.stringify(testNamePattern)}; not a verification gate.`)
    const runFile = async (slot, file, { isRetest, timeoutScale }) => {
      if (interrupted) return { code: 128 + (interrupted === 'SIGINT' ? 2 : 15) }
      if (active.has(slot.index)) throw new Error(`Slot ${slot.index} still has an owned process group`)
      if (slot.unavailable) throw new Error(`Slot ${slot.index} is retired`)
      const started = Date.now()
      if (slot.used) {
        try { await resetSlotDatabase(slot) }
        catch (error) { slot.resetError = error; throw error }
      }
      const databaseSetupMs = slot.databaseSetupMs
      slot.used = true
      const label = isRetest ? 'RETEST ' : ''
      recordFileAttempt(isRetest ? retestReports : firstPass, file, { slot: slot.index,
        startedAt: new Date(started).toISOString(), code: null, complete: false, reason: 'no terminal file report' })
      const log = integrationLogPath(slot.directory, file)
      mkdirSync(dirname(log), { recursive: true })
      const output = boundedLog(log, logBytes)
      const json = `${log}.json`
      const environment = { ...integrationEnvironment(env, slot), FOREMAN_CODE_TEST_FILE_STARTED_AT: String(Date.now()),
        FOREMAN_CODE_TEST_FILE: file, FOREMAN_CODE_TEST_CACHE_ROOT: testFixtureCacheRoot(env) }
      if (env.CI === 'true' && env.FOREMAN_CODE_INTEGRATION_COVERAGE !== '0') {
        environment.FOREMAN_CODE_INTEGRATION_COVERAGE_DIRECTORY = join(failedLogs, 'coverage')
        mkdirSync(environment.FOREMAN_CODE_INTEGRATION_COVERAGE_DIRECTORY, { recursive: true })
      }
      const vitest = vitestCommand(environment, file, testNamePattern, json)
      const reuse = !isRetest && reusableIntegrationFile(file)
      if (!reuse) await dropSlotServer(slot)
      // One slot is one case; it.concurrent must not multiply its SQL fixture load.
      const server = reuse ? (slot.server ??= startSlotServer(vitest.env, testNamePattern)) : undefined
      const child = server?.child ?? spawn(vitest.command, vitest.args,
        { cwd: vitest.cwd, env: vitest.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const progress = integrationProcessProgress()
      const phaseOutput = integrationPhaseForwarder(line => console.log(line))
      const recordOutput = (chunk) => {
        progress.bytes += chunk.length
        progress.lastOutputAt = Date.now()
        output.write(chunk)
      }
      const recordStdout = chunk => {
        recordOutput(chunk)
        phaseOutput.push(chunk)
      }
      let outputResult
      const closeOutput = () => {
        phaseOutput.finish()
        outputResult ??= output.close()
        return outputResult
      }
      let outputClosed
      let finished
      if (server) finished = server.run({ file, json, environment: vitest.env }, recordStdout)
      else {
        child.stdout.on('data', recordStdout)
        child.stderr.on('data', recordOutput)
        outputClosed = new Promise((done) => child.once('close', () => done(closeOutput())))
      }
      active.set(slot.index, { child, file, progress })
      console.log(`[integration] ${label}START ${file} (slot ${slot.index}, pid ${child.pid ?? 'unavailable'}); log: ${log}`)
      if (interrupted) signalOwnedChildren(active, killTimers, interrupted)
      const metricsTracker = child.pid ? startProcessMetrics(child.pid) : null
      let metrics
      let result
      const scaledTimeouts = integrationTimeouts(env, timeoutScale)
      const fileTimeoutMs = scaledTimeouts.fileTimeoutMs
      const expectedMs = expectedDurations[file]
      const deadlineMs = adaptiveDeadlineMs(expectedMs, fileTimeoutMs, timeoutScale)
      try {
        result = await superviseIntegrationProcess(child, { log, progress, ...scaledTimeouts,
          idleTimeoutMs: Math.min(fileTimeoutMs, scaledTimeouts.idleTimeoutMs),
          fileTimeoutMs, deadlineMs,
          onTimeout: (reason) => console.error(`[integration] ${label}TIMEOUT ${file} (slot ${slot.index}): ${reason.message}`),
          cleanupAfterExit: () => settleTestResources(admin, slot),
          finished,
          // A coordinator that finished its file stays for the slot's next file; only what the file left is stopped.
          stopProcesses: (outcome, graceMs) => server && !outcome.timedOut && server.alive
            ? stopStrayProcesses(child.pid, { graceMs }) : stopGroup(child.pid, { graceMs }),
          resetAfterTimeout: async () => {
            try { await resetSlotDatabase(slot) }
            catch (reason) { slot.resetError = reason; throw reason }
            console.log(`[integration] slot ${slot.index} database reset after timeout; remaining queue continues.`)
          },
        })
      } finally {
        metrics = metricsTracker?.stop()
      }
      if (server) {
        server.detach()
        if (result.timedOut || result.slotUnavailable || !server.alive) {
          try { await stopGroup(child.pid) }
          catch (reason) { console.error(`[integration] slot ${slot.index} coordinator stop failed: ${reason.message}`) }
          slot.server = undefined
        }
      }
      const ownedProcessActive = slot.server ? false : groupUsed(child.pid)
      if (ownedProcessActive) {
        slot.unavailable = true
        stopForProcessFailure(result.error?.message
          ?? `Integration slot ${slot.index} still owns child process group ${child.pid}`)
        child.stdout.off('data', recordStdout)
        child.stderr.off('data', recordOutput)
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const retainedLog = ownedProcessActive || server ? closeOutput() : await outputClosed
      let code = ownedProcessActive ? 1 : result.code
      let error = ownedProcessActive ? new Error(fatalProcessError) : result.error
      clearTimeout(killTimers.get(slot.index))
      killTimers.delete(slot.index)
      if (!ownedProcessActive) active.delete(slot.index)
      if (result.slotUnavailable) {
        slot.unavailable = true
        console.error(`[integration] slot ${slot.index} RETIRED; healthy slots continue the remaining queue.`)
      }
      const retained = integrationLogPath(join(failedLogs, 'slots', `${isRetest ? 'retest-' : ''}slot-${slot.index}`), file)
      mkdirSync(dirname(retained), { recursive: true })
      copyFileSync(log, retained)
      const elapsedMs = Date.now() - started
      let fileReport
      let reportError
      try {
        fileReport = readVitestReport(json, { root, expectedFiles: [file], maxBytes: reportBytes })
        copyFileSync(json, `${retained}.json`)
      } catch (reason) { reportError = reason.message }
      const summary = fileReport?.totals
      if (!isRetest) {
        if (summary) for (const kind of ['passed', 'failed', 'skipped']) cases[kind] += summary[kind]
        else unreported++
      }
      if (code === 0 && (!fileReport?.complete || reportError)) {
        code = 1
        error = new Error(reportError ?? 'Vitest file report incomplete')
      }
      if (code === 0 && fileReport.failed) { code = 1; error = new Error('Vitest file reported a failure') }
      if (code === 0 && failForSkippedCases(summary, diagnostic)) {
        code = 1
        error = new Error(`${summary.skipped} skipped cases in an integration run`)
      }
      let hangDetails
      const startupPhases = readIntegrationStartup(readFileSync(log, 'utf8'))
      if (code === 0) {
        if (isRetest) retest.passed++
        else passed++
        console.log(`[integration] ${label}PASS ${file} (slot ${slot.index}; ${summary.passed} cases passed, ${summary.skipped} skipped; ${elapsedMs} ms${startupText(startupPhases)})`)
      }
      else {
        if (isRetest) {
          if (!retestFailedFiles.has(file)) { retest.failed++; retestFailedFiles.add(file) }
        } else {
          failed++
          failedFiles.push(file)
          if (result.hung) { hung++; hungFiles.push(file) }
        }
        const saved = integrationLogPath(isRetest ? join(failedLogs, 'retest') : failedLogs, file)
        mkdirSync(dirname(saved), { recursive: true })
        copyFileSync(log, saved)
        const output = readFileSync(log, 'utf8')
        if (result.hung) {
          hangDetails = { expectedMs, deadlineMs, ...hungContext(output.slice(-65_536)) }
          console.error(`[integration] ${label}HUNG ${file} (slot ${slot.index}, exit ${code}); ${elapsedMs} ms,`
            + ` expected ${expectedMs} ms, deadline ${deadlineMs} ms; last case: ${hangDetails.lastCase ?? 'none finished'};`
            + ` last output: ${hangDetails.lastOutput ?? 'none'}; log: ${saved}`)
        } else {
          console.error(`[integration] ${label}FAIL ${file} (slot ${slot.index}, exit ${code}); ${elapsedMs} ms; log: ${saved}`)
        }
        for (const name of failedCasesFromLog(output)) console.error(`[integration]   × ${name}`)
        // Keep actionable errors in the queue log when its temporary checkout is removed.
        const detail = output.slice(-32_768).split(/\r?\n/).slice(-160).join('\n')
        console.error(`[integration] failure output for ${file}:\n${detail}`)
        if (error) console.error(`[integration] ${error.message}`)
        if (result.resetError) console.error(`[integration] ${result.resetError.message}`)
      }
      const record = { file, slot: slot.index, code, elapsedMs,
        startup: { databaseSetupMs, phases: startupPhases },
        complete: Boolean(fileReport?.complete && !reportError && !ownedProcessActive), timedOut: result.timedOut,
        report: fileReport, reportError, log: retainedLog, metrics, reason: error?.message ?? reportError,
        ...(hangDetails ? { status: 'HUNG', hung: hangDetails } : {}) }
      recordFileAttempt(isRetest ? retestReports : firstPass, file, record)
      writeReport(`${retained}.result.json`, record, reportBytes)
      return { code, complete: record.complete, metrics, reason: record.reason,
        timedOut: result.timedOut, slotUnavailable: slot.unavailable, ownedProcessActive }
    }
    const runSafely = async (slot, file, context) => {
      try { return await runFile(slot, file, context) }
      catch (error) {
        const owned = active.get(slot.index)
        if (owned && !groupUsed(owned.child.pid)) active.delete(slot.index)
        if (active.has(slot.index) || slot.resetError) slot.unavailable = true
        const ownedProcessActive = active.has(slot.index)
        if (ownedProcessActive) stopForProcessFailure(error.message)
        const { isRetest } = context
        if (isRetest) {
          if (!retestFailedFiles.has(file)) { retest.failed++; retestFailedFiles.add(file) }
        } else if (!failedFiles.includes(file)) { failed++; failedFiles.push(file) }
        const log = integrationLogPath(slot.directory, file)
        const saved = integrationLogPath(isRetest ? join(failedLogs, 'retest') : failedLogs, file)
        let retained = 'unavailable'
        if (existsSync(log)) {
          try {
            mkdirSync(dirname(saved), { recursive: true })
            copyFileSync(log, saved)
            retained = saved
          } catch (error) { diagnosticWarning('retain failed unit log', error) }
        }
        console.error(`[integration] ${isRetest ? 'RETEST ' : ''}FAIL ${file} (slot ${slot.index}, exit 1); log: ${retained}`)
        recordFileAttempt(isRetest ? retestReports : firstPass, file,
          { code: 1, complete: false, reason: error.message })
        console.error(`[integration] runner error: ${error instanceof Error ? error.message : String(error)}`)
        return { code: 1, complete: false, reason: error.message,
          slotUnavailable: slot.unavailable, ownedProcessActive }
      }
    }
    const prepareRetest = async (slot, file) => {
      phase = 'retest'
      phaseTotal = failedFiles.length
      recordFileAttempt(retestReports, file,
        { slot: slot.index, code: 1, complete: false, reason: 'retest database setup failed' })
      try {
        await dropSlotServer(slot)
        await dropTestDatabase(admin, slot)
        removeTestRoot(slot)
        const resource = createTestRoot(tempRoot.directory, `retest-slot-${slot.index}-`)
        delete slot.name
        delete slot.databaseUrl
        Object.assign(slot, resource)
        const started = performance.now()
        Object.assign(slot, await createTestDatabase(admin, resource, { template }))
        slot.databaseSetupMs = performance.now() - started
        slot.used = false
        delete slot.resetError
      } catch (error) {
        slot.resetError = error
        retest.failed++
        retestFailedFiles.add(file)
        recordFileAttempt(retestReports, file, { reason: error.message })
        console.error(`[integration] slot ${slot.index} RETIRED during retest setup: ${error.message}`)
        throw error
      }
    }
    queueResult = await scheduleIntegrationQueue(runnable, slots, {
      gate, maxConcurrency: concurrency, profiles, durations: expectedDurations, runFile: runSafely, prepareRetest,
      extraItems,
      executeExtra: (item, context) => executeExtra(item, context, {
        shouldStop: shouldStopQueue, signal: abortController.signal,
      }),
      shouldStop: shouldStopQueue,
      onProcessFailure: stopForProcessFailure,
    })
    const notRun = queueResult.unexecuted.filter((item) => item.kind === 'integration')
    skipped = interrupted ? notRun.length : 0
    if (!interrupted) for (const item of notRun) {
      const result = queueResult.results.find((entry) => entry.id === item.id)
      recordUnexecuted([item.file], 'first', result?.reason ?? 'no usable integration slots')
    }
    for (const result of queueResult.results) {
      const record = firstPass.find((entry) => entry.file === result.id)
      // A hung first attempt stays HUNG even when its isolated retest passes.
      if (record && record.status !== 'HUNG') record.status = result.status
      if (result.status === 'FLAKY' && record) {
        console.error(`[integration] FLAKY ${result.id}: failed first pass, passed isolated retest; first pass still fails this run.`)
      }
      if (!gate && record && record.code !== null && record.code !== 0
        && result.attempts.length === 1 && !interrupted) {
        recordUnexecuted([result.id], 'retest',
          result.retestReason ?? result.reason ?? 'no usable integration slots for isolated retest')
      }
    }
    retest.skipped = !gate && interrupted ? Math.max(0, failedFiles.length - retest.passed - retest.failed) : 0
  } finally {
    clearInterval(heartbeat)
    if (queueResult) {
      try {
        writeProfiles(profilesPath, queueResult.profiles)
      } catch (error) {
        console.error(`[integration] could not record test profiles: ${error.message}`)
      }
    }
    let cleanupError
    for (const [index, { child }] of active) {
      try { await stopGroup(child.pid, { signal: interrupted || 'SIGTERM' }); active.delete(index) }
      catch (error) { cleanupError ??= error }
    }
    for (const slot of slots) {
      try { await dropSlotServer(slot) }
      catch (error) { cleanupError ??= error }
      try { await sweepRestartUnits(slot) }
      catch (error) { cleanupError ??= error }
    }
    for (const timer of killTimers.values()) clearTimeout(timer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try {
      if (!cleanupError) {
        for (const slot of slots) if (slot.name) {
          try {
            await cleanupTestResources(slot)
          }
          catch (error) { cleanupError ??= error }
        }
        if (template && !template.persistent && !cleanupError) {
          try { await dropTestDatabaseTemplate(admin, template) }
          catch (error) { cleanupError ??= error }
        }
      }
    } finally {
      try { await admin.end() }
      catch (error) { cleanupError ??= error }
      const report = integrationReport(selected, firstPass, retestReports, { startedAt,
        finishedAt: new Date().toISOString(), interrupted, diagnostic, environment,
        processStopped: !active.size && !cleanupError && !fatalProcessError })
      const fileResults = firstPass.flatMap((file) => file.report?.files ?? [])
      try {
        writeReport(join(failedLogs, 'vitest.json'), mergedVitestReport(fileResults, startedAt, report.outcome), reportBytes)
        writeReport(join(failedLogs, 'junit.xml'), junitReport(fileResults, report.outcome), reportBytes)
        const archiveBytes = positiveInteger(Number(readProductEnvironment(env, 'INTEGRATION_ARCHIVE_BYTES')
          ?? reportBytes), 'Integration archive byte limit')
        writeReport(join(failedLogs, 'logs.tar.gz'), logArchive(failedLogs, archiveBytes), archiveBytes)
      } catch (error) {
        report.completeness = 'partial'
        if (!interrupted) report.outcome = 'incomplete'
        report.publicationError = error.message
      }
      finalResult = finalizeIntegrationResult({ report, results: queueResult?.results ?? [],
        selectedFiles: selected, reportDirectory: failedLogs, interrupted, diagnostic,
        cleanupError, error: fatalProcessError })
      if (finalResult.error) console.error(`[integration] cleanup/process error: ${finalResult.error}`)
      writeReport(join(failedLogs, 'summary.json'), report, reportBytes)
      // Measured file durations, so a host CI dispatcher can learn each file's usual time.
      const measured = measuredDurations(firstPass)
      try {
        writeDurations(join(failedLogs, 'durations.json'), measured)
        const output = readProductEnvironment(env, 'INTEGRATION_DURATIONS_OUTPUT')
        if (output) writeDurations(resolve(output), measured)
      } catch (error) {
        console.error(`[integration] could not record measured durations: ${error.message}`)
      }
      // Structured per-test results, so a host CI dispatcher can show them with the ticket.
      if (env.CI === 'true' && env.FOREMAN_CODE_INTEGRATION_COVERAGE !== '0') {
        const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
        if (commit.status !== 0) throw new Error('Could not identify the integration coverage commit')
        const coverage = integrationCoverageReport(join(failedLogs, 'coverage'), commit.stdout.trim(), discoverFiles(),
          firstPass.map(file => file.file))
        writeDurations(join(failedLogs, 'integration-coverage.json'), coverage)
        console.log(`[integration] coverage: ${Object.keys(coverage.coverage).length}/${coverage.testFiles.length} test files;`
          + ` ${coverage.staticTests.length} retain static selection; commit ${coverage.commit}`)
        const output = env.FOREMAN_CODE_INTEGRATION_COVERAGE_OUTPUT
        if (output) writeDurations(resolve(output), coverage)
      }
      const testResults = readProductEnvironment(env, 'INTEGRATION_TEST_RESULTS_OUTPUT')
      if (testResults) {
        try {
          writeCiTestResults(resolve(testResults), [join(failedLogs, 'vitest.json')], root)
        } catch (error) {
          console.error(`[integration] could not record test results: ${error.message}`)
        }
      }
      console.log(`[integration] machine-readable reports: ${failedLogs}`)
      if (!active.size && !cleanupError) removeTestRoot(tempRoot)
      console.log(`[integration] files: ${passed} passed, ${failed - hung} failed, ${hung} hung, ${skipped} skipped;`
        + ` ${unavailable.length} unavailable; cases: ${cases.passed} passed, ${cases.failed} failed,`
        + ` ${cases.skipped} skipped${unreported ? `; ${unreported} files without case totals` : ''}`
        + `${diagnostic || files ? '; partial run is not full-suite proof' : ''}.`)
      if (retest.passed || retest.failed || retest.skipped) console.log(`[integration] retest files: ${retest.passed} passed, ${retest.failed} failed, ${retest.skipped} skipped; first-pass failures still fail this run.`)
      const failedOnly = failedFiles.filter((file) => !hungFiles.includes(file)).sort()
      if (failedOnly.length) console.error(`[integration] failed files: ${failedOnly.join(', ')}`)
      if (hungFiles.length) console.error(`[integration] hung files: ${hungFiles.sort().join(', ')}`)
    }
  }
  return finalResult
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[integration] ${error.message}`); process.exitCode = 1 })
}
