import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { groupUsed, stopGroup } from './integration-process.mjs'
import { boundedLog, emptyCounts, junitReport, logArchive, mergedVitestReport, portionKey, portionPath,
  positiveInteger, privateDirectory, readNodeReport, readReport, readVitestReport, reportPaths,
  suiteSummary, writeReport } from './verification-reports.mjs'

const rootCommands = { typecheck: 'typecheck', lint: 'lint', unit: 'test', build: 'build', integration: 'test:integration' }
const limitNames = ['summaryBytes', 'junitBytes', 'vitestBytes', 'logsArchiveBytes', 'logBytes']

export function validateVerificationContext(context) {
  const identity = context?.identity
  if (!identity || !['install', ...Object.keys(rootCommands)].includes(identity.suite)) {
    throw new Error('An ordinary-suite accepted execution context is required')
  }
  for (const field of ['commit', 'manifestDigest', 'definitionVersionId', 'executionId', 'attemptId']) {
    if (typeof identity[field] !== 'string' || !identity[field]) throw new Error(`Missing execution identity: ${field}`)
  }
  if (!identity.target || !identity.profile || !identity.resources || !identity.parameters) {
    throw new Error('Accepted target, profile, resources and parameters are required')
  }
  const git = context.privateGit
  if (!git || git.sourceCommit !== identity.commit
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(git.generatedCommit)
    || ['repositoryReceiptDigest', 'configDigest', 'indexDigest'].some(field => !/^[a-f0-9]{64}$/.test(git[field]))) {
    throw new Error('Authenticated private Git receipt must retain the accepted source commit')
  }
  positiveInteger(identity.resources.reportBytes, 'Accepted report reservation')
  positiveInteger(context.executionTimeoutMs, 'Execution deadline')
  positiveInteger(context.cancellationTimeoutMs, 'Cancellation deadline')
  positiveInteger(context.qualifiedUnitWorkers, 'Qualified unit workers', 12)
  positiveInteger(identity.parameters.unitWorkers, 'Unit workers', context.qualifiedUnitWorkers)
  positiveInteger(identity.parameters.integrationShards, 'Integration shards', 12)
  if (identity.suite === 'integration') {
    positiveInteger(context.qualifiedIntegrationShards, 'Qualified integration shards', 12)
    positiveInteger(identity.parameters.integrationShards, 'Integration shards', context.qualifiedIntegrationShards)
  }
  for (const name of limitNames) positiveInteger(context.limits?.[name], name)
  const outputBytes = context.limits.summaryBytes + context.limits.junitBytes
    + context.limits.vitestBytes + context.limits.logsArchiveBytes
  if (outputBytes > identity.resources.reportBytes || context.limits.logBytes > context.limits.logsArchiveBytes) {
    throw new Error('Report limits exceed the accepted report reservation')
  }
  if (!Array.isArray(context.requiredPortions) || !context.requiredPortions.length
    || context.requiredPortions.some(portion => !portion.key || !['command', 'bootstrap', 'vitest', 'node', 'integration'].includes(portion.kind)
      || ['vitest', 'node', 'integration'].includes(portion.kind) && (!Array.isArray(portion.files) || !portion.files.length))) {
    throw new Error('Protected command and test inventory required')
  }
  if (!context.storeDirectory || !context.mutableDirectory || !context.preseedReceipt
    || !isAbsolute(context.storeDirectory) || !isAbsolute(context.mutableDirectory)) {
    throw new Error('Offline install requires a private store and reviewed preseed receipt')
  }
  const store = relative(context.mutableDirectory, context.storeDirectory)
  if (!store || store === '..' || store.startsWith(`..${sep}`) || isAbsolute(store)) {
    throw new Error('Offline store must be inside the Job mutable directory')
  }
  return context
}

export function offlineInstallCommand(context) {
  validateVerificationContext(context)
  return ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--offline', '--prod=false',
    '--store-dir', context.storeDirectory]
}

export function verificationCommand(context, root = process.cwd()) {
  validateVerificationContext(context)
  if (context.identity.suite === 'install') return offlineInstallCommand(context)
  const command = ['corepack', 'pnpm', rootCommands[context.identity.suite]]
  // A qualification's integration smoke subset runs only its listed files; CI Jobs run the whole suite.
  const integration = context.requiredPortions.find(portion => portion.kind === 'integration')
  if (integration && integration.files.length < integrationTestFiles(root).length) command.push('--files', ...integration.files)
  return command
}

export function verifyOfflinePreseed(root, receipt) {
  const lockfileSha256 = createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex')
  if (receipt.lockfileSha256 !== lockfileSha256 || receipt.pnpmVersion !== '11.27.0'
    || receipt.platform !== process.platform || receipt.architecture !== process.arch
    || !/^[a-f0-9]{64}$/.test(receipt.provenanceDigest)
    || receipt.minimumReleaseAgeMinutes !== 2880 || receipt.releaseAgeVerified !== true) {
    throw new Error('Preseed receipt does not cover the frozen lockfile, platform and 48-hour policy')
  }
}

export function verifyEffectivePackagePolicy(root, environment) {
  const run = (args) => execFileSync('corepack', ['pnpm', ...args], { cwd: root, env: environment,
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }).trim()
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager !== 'pnpm@11.27.0'
    || run(['--version']) !== '11.27.0') throw new Error('Verification requires pinned pnpm 11.27.0')
  for (const [key, required] of [['minimumReleaseAge', '2880'], ['minimumReleaseAgeStrict', 'true'],
    ['minimumReleaseAgeIgnoreMissingTime', 'false']]) {
    if (run(['config', 'get', key]) !== required) throw new Error(`Effective pnpm policy is unsafe: ${key}`)
  }
  const exclusions = run(['config', 'get', 'minimumReleaseAgeExclude'])
  if (!['undefined', 'null', '[]', ''].includes(exclusions)) throw new Error('Release-age exclusions are prohibited')
}

export function verifyPrivateGitHead(root, context, environment = process.env) {
  validateVerificationContext(context)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: environment, encoding: 'utf8' }).trim()
  if (head !== context.privateGit.generatedCommit) throw new Error('Private Git HEAD differs from its authenticated receipt')
}

export function prepareVerificationDirectory(root) {
  const directory = resolve(root, dirname(reportPaths.summary))
  privateDirectory(directory)
  for (const entry of readdirSync(directory)) {
    const stat = lstatSync(join(directory, entry))
    if (entry !== 'summary.json' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) {
      throw new Error('Verification output directory already contains attempt results; use a fresh attempt')
    }
  }
  privateDirectory(join(directory, 'parts'))
  return directory
}

export function expectedPortions(root, suite) {
  if (suite === 'install') return [{ key: 'root:install', kind: 'command' }]
  const bootstrap = { key: 'root:install', kind: 'bootstrap' }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'foreman-code') {
    if (!rootCommands[suite]) throw new Error(`Unsupported verification suite: ${suite}`)
    return [bootstrap, { key: portionKey('', rootCommands[suite]), kind: 'command' }]
  }
  if (suite === 'integration') return [bootstrap,
    { key: portionKey('packages/contracts', 'build'), kind: 'command' },
    { key: portionKey('', 'test:integration'), kind: 'integration' },
  ]
  if (suite === 'unit') return [bootstrap, { key: 'root:worker-artifact', kind: 'bootstrap' },
    { key: portionKey('packages/contracts', 'test'), kind: 'vitest' },
    { key: portionKey('apps/api', 'test'), kind: 'vitest' },
    { key: portionKey('apps/web', 'test:unit'), kind: 'vitest' },
    { key: portionKey('apps/web', 'test:run-graph-smoke'), kind: 'node' },
    { key: portionKey('apps/worker', 'test'), kind: 'node' },
    { key: portionKey('', 'test:scripts'), kind: 'node' },
  ]
  const portions = [bootstrap]
  if (suite !== 'build') portions.push({ key: portionKey('packages/contracts', 'build'), kind: 'command' })
  for (const base of ['apps', 'packages']) for (const name of readdirSync(join(root, base)).sort()) {
    const directory = `${base}/${name}`
    const path = join(root, directory, 'package.json')
    if (!existsSync(path)) continue
    if (JSON.parse(readFileSync(path, 'utf8')).scripts?.[suite]) {
      portions.push({ key: portionKey(directory, suite), kind: 'command' })
    }
  }
  return portions
}

const QUALIFICATION_SUBSET = 'scripts/integration-qualification.json'
const INTEGRATION_DURATIONS = 'scripts/ci-learned-durations.json'

/** One deterministic, duration-balanced slice of the integration files: the longest files go first, each to the
 * partition with the least recorded time. Files without a recorded duration count as the median. */
export function integrationPartition(files, durations, partition) {
  const known = files.map(file => durations[file]).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const weight = file => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : fallback
  const loads = Array(partition.count).fill(0), owner = new Map()
  for (const file of [...files].sort((left, right) => weight(right) - weight(left) || (left < right ? -1 : 1))) {
    let lightest = 0
    for (let index = 1; index < loads.length; index++) if (loads[index] < loads[lightest]) lightest = index
    loads[lightest] += weight(file)
    owner.set(file, lightest)
  }
  return files.filter(file => owner.get(file) === partition.index)
}
const integrationTestFiles = root => existsSync(join(root, 'apps/api/test'))
  ? readdirSync(join(root, 'apps/api/test')).filter(name => name.endsWith('.integration.test.ts'))
    .map(name => `apps/api/test/${name}`).sort()
  : []

/** `qualification` selects the commit's committed integration smoke subset when it has one: qualification proves
 * the computer's runtime (PostgreSQL startup and isolation, migrations, MCP, sources, Jobs), not the whole suite. */
export function captureVerificationInventory(root, suite, { qualification = false, partition } = {}) {
  const portions = expectedPortions(root, suite)
  if (portions.every(portion => ['command', 'bootstrap'].includes(portion.kind))) return portions
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.logs'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    }
  }
  if (suite === 'unit' || suite === 'integration') visit(root)
  return portions.map(portion => {
    if (!['vitest', 'node', 'integration'].includes(portion.kind)) return portion
    let selected
    if (portion.kind === 'integration') {
      selected = files.filter(path => /^apps\/api\/test\/.*\.integration\.test\.ts$/.test(path))
      if (qualification && existsSync(join(root, QUALIFICATION_SUBSET))) {
        const subset = JSON.parse(readFileSync(join(root, QUALIFICATION_SUBSET), 'utf8')).files
        if (!Array.isArray(subset) || !subset.length || subset.some(path => !selected.includes(path))) {
          throw new Error(`${QUALIFICATION_SUBSET} must list existing integration test files`)
        }
        selected = subset
      } else if (partition) {
        const durations = existsSync(join(root, INTEGRATION_DURATIONS))
          ? JSON.parse(readFileSync(join(root, INTEGRATION_DURATIONS), 'utf8')) : {}
        selected = integrationPartition(selected, durations && typeof durations === 'object' ? durations : {}, partition)
      }
    } else if (portion.kind === 'vitest') {
      const prefix = portion.key.split(':')[0] + '/'
      selected = files.filter(path => path.startsWith(prefix) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
        && !/\.(integration|acceptance)\.test\./.test(path)
        && (prefix !== 'apps/web/' || path.startsWith('apps/web/src/')))
    } else if (portion.key === 'apps/worker:test') {
      selected = files.filter(path => /^apps\/worker\/test\/[^/]+\.test\.mjs$/.test(path))
    } else if (portion.key === 'apps/web:test:run-graph-smoke') {
      selected = ['apps/web/src/features/workflow-board/currentSource.smoke.mjs']
    } else {
      selected = files.filter(path => /^scripts\/.*\.test\.mjs$/.test(path))
    }
    if (!selected.length) throw new Error(`Empty required test inventory: ${portion.key}`)
    return { ...portion, files: selected.sort() }
  })
}

function commandPortion(key, receipt) {
  const passed = receipt.code === 0
  return { key, complete: true, failed: !passed,
    totals: { total: 1, passed: Number(passed), failed: Number(!passed), skipped: 0 },
    files: [{ name: key, status: passed ? 'passed' : 'failed',
      startTime: Date.parse(receipt.startedAt), endTime: Date.parse(receipt.finishedAt),
      assertionResults: [{ title: key, fullName: key, status: passed ? 'passed' : 'failed',
        duration: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
        failureMessages: passed ? [] : [receipt.error ?? `Command exited ${receipt.code}`] }] }] }
}

export function collectPortions(directory, root, expected, limits) {
  return expected.map(({ key, kind, files: trustedFiles }) => {
    let receipt
    let receiptError
    try {
      receipt = JSON.parse(readReport(portionPath(directory, key, 'command.json'), limits.logBytes))
    } catch (error) { receiptError = error.message }
    try {
      if ((kind === 'command' || kind === 'bootstrap') && receiptError) throw new Error(receiptError)
      if (receipt && (receipt.key !== key || !Number.isSafeInteger(receipt.code)
        || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt))
        || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt))) {
        throw new Error('Corrupt command result')
      }
      if (kind === 'command') return commandPortion(key, receipt)
      if (kind === 'bootstrap') return { key, complete: true, failed: receipt.code !== 0, totals: emptyCounts(), files: [] }
      const expectedFiles = trustedFiles
        ?? JSON.parse(readReport(portionPath(directory, key, 'inventory.json'), limits.vitestBytes))
      if (!Array.isArray(expectedFiles) || !expectedFiles.length || new Set(expectedFiles).size !== expectedFiles.length) {
        throw new Error('Missing or corrupt test inventory')
      }
      const options = { root, expectedFiles, maxBytes: limits.vitestBytes }
      if (kind === 'integration') return collectIntegrationPortion(directory, key, receipt, options)
      const capabilityPath = portionPath(directory, key, 'capabilities.json')
      const capabilities = kind === 'vitest' && existsSync(capabilityPath)
        ? JSON.parse(readReport(capabilityPath, limits.vitestBytes)) : undefined
      const unavailable = capabilities?.unavailable ?? []
      if (unavailable.length === expectedFiles.length
        && expectedFiles.every(file => unavailable.some(entry => entry.file === file))) {
        return { key, complete: false, failed: false, totals: emptyCounts(), files: [],
          missing: expectedFiles, environment: capabilities.environment, unavailable }
      }
      const report = kind === 'node'
        ? readNodeReport(portionPath(directory, key, 'node.ndjson'), options)
        : readVitestReport(portionPath(directory, key, 'vitest.json'), options)
      return { key, ...report, complete: report.complete && Boolean(receipt) && unavailable.length === 0,
        failed: report.failed || Boolean(receipt && receipt.code !== 0), error: receiptError,
        ...(capabilities ? { environment: capabilities.environment, unavailable } : {}) }
    } catch (error) {
      return { key, complete: false, failed: Boolean(receipt && receipt.code !== 0), totals: emptyCounts(), files: [], error: error.message }
    }
  })
}

function collectIntegrationPortion(directory, key, receipt, options) {
  const reports = join(directory, 'parts', 'integration')
  const summary = JSON.parse(readReport(join(reports, 'summary.json'), options.maxBytes))
  const report = readVitestReport(join(reports, 'vitest.json'), options)
  const reportedFiles = summary.files?.map(file => file.file)
  const covered = Array.isArray(reportedFiles) && reportedFiles.length === options.expectedFiles.length
    && new Set(reportedFiles).size === reportedFiles.length
    && options.expectedFiles.every(file => reportedFiles.includes(file))
  const totalsMatch = Object.keys(report.totals).every(name => summary.totals?.[name] === report.totals[name])
  const complete = covered && totalsMatch && summary.schemaVersion === 1 && summary.suite === 'integration'
    && summary.expectedPortions === options.expectedFiles.length
    && summary.completedPortions === summary.expectedPortions && summary.completeness === 'complete'
    && ['passed', 'failed'].includes(summary.outcome) && summary.files.every(file => file.complete)
    && Number.isSafeInteger(summary.firstPassFailed) && summary.firstPassFailed >= 0
  return { key, ...report, complete: report.complete && complete && Boolean(receipt),
    failed: report.failed || summary.firstPassFailed > 0 || summary.outcome === 'failed'
      || Boolean(receipt && receipt.code !== 0) }
}

function ownedGroups(token) {
  const groups = new Set()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      const environment = readFileSync(`/proc/${entry}/environ`)
      if (!environment.includes(Buffer.from(`FOREMAN_CODE_VERIFICATION_PROCESS_TOKEN=${token}\0`))) continue
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
      if (fields[0] !== 'Z') groups.add(Number(fields[2]))
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error
    }
  }
  return groups
}

export async function runSuiteProcess(command, { root, env, directory, limits, executionTimeoutMs,
  cancellationTimeoutMs, signal, logName = 'root' }) {
  if (signal?.aborted) return { code: 1, processStopped: true, terminalOutcome: 'cancelled' }
  const token = randomUUID()
  const log = boundedLog(join(directory, 'parts', `${logName}.log`), limits.logBytes)
  const child = spawn(command[0], command.slice(1), { cwd: root, detached: true,
    env: { ...env, FOREMAN_CODE_VERIFICATION_PROCESS_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => log.write(chunk))
  child.stderr.on('data', (chunk) => log.write(chunk))
  let terminalOutcome
  let closing
  let closeError
  const close = (outcome) => {
    terminalOutcome ??= outcome
    closing ??= (async () => {
      const groups = new Set(child.pid ? [child.pid] : [])
      try { for (const group of ownedGroups(token)) groups.add(group) }
      catch (error) { closeError = error }
      const results = await Promise.allSettled([...groups]
        .map((pid) => stopGroup(pid, { graceMs: cancellationTimeoutMs })))
      for (const result of results) if (result.status === 'rejected') closeError ??= result.reason
    })()
  }
  const cancel = () => close('cancelled')
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => close('timed_out'), executionTimeoutMs)
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ code: 1, error: error.message }))
    child.once('close', (code) => done({ code: code ?? 1 }))
  })
  clearTimeout(timer)
  signal?.removeEventListener('abort', cancel)
  let processStopped = false
  try {
    if (closing) await closing
    if (closeError) throw closeError
    for (const group of ownedGroups(token)) await stopGroup(group, { graceMs: cancellationTimeoutMs })
    processStopped = (!child.pid || !groupUsed(child.pid)) && ownedGroups(token).size === 0
  } catch (error) {
    result.error = error.message
    terminalOutcome = 'incomplete'
  }
  return { ...result, processStopped, terminalOutcome: terminalOutcome ?? (result.code === 0 ? 'passed' : 'failed'),
    log: log.close() }
}

export function sampleVerificationResources({ mutableDirectory, cgroupDirectory }) {
  const filesystem = statfsSync(mutableDirectory)
  const read = (name) => readFileSync(join(cgroupDirectory, name), 'utf8').trim()
  const cpu = read('cpu.stat').match(/^usage_usec (\d+)$/m)
  const values = { mutableBytes: (filesystem.blocks - filesystem.bfree) * filesystem.bsize,
    mutableInodes: filesystem.files - filesystem.ffree, memoryPeakBytes: Number(read('memory.peak')),
    pidsPeak: Number(read('pids.peak')), cpuUsageUsec: cpu ? Number(cpu[1]) : NaN }
  if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Resource measurement is unavailable or invalid')
  }
  return { sampledAt: new Date().toISOString(), ...values }
}

export function finalizeVerification(context, { root, directory, state, terminalOutcome, processStopped, finishedAt = new Date().toISOString(), reportRoot = root,
  writeSummary = writeReport, checkpoint = () => {} }) {
  checkpoint()
  const portions = collectPortions(directory, reportRoot, context.requiredPortions, context.limits)
  const summary = suiteSummary(context.identity, portions, { startedAt: state.startedAt,
    finishedAt, terminalOutcome, processStopped })
  const files = portions.flatMap((portion) => portion.files)
  const details = { portions: portions.map(({ key, complete, failed, totals, missing, error, environment, unavailable }) =>
    ({ key, complete, failed, totals, missing, error, environment, unavailable })), terminalOutcome, processStopped }
  try {
    checkpoint()
    writeReport(join(directory, 'parts', 'portions.json'), details, context.limits.vitestBytes)
    checkpoint()
    writeReport(join(directory, 'vitest.json'), { ...mergedVitestReport(files, state.startedAt, summary.outcome),
      verification: summary },
      context.limits.vitestBytes)
    checkpoint()
    writeReport(join(directory, 'junit.xml'), junitReport(files, summary.outcome, context.identity), context.limits.junitBytes)
    checkpoint()
    const archive = logArchive(join(directory, 'parts'), context.limits.logsArchiveBytes)
    // Binary output uses the same atomic writer and declaration limit.
    checkpoint()
    writeReport(join(directory, 'logs.tar.gz'), archive, context.limits.logsArchiveBytes)
  } catch (error) {
    summary.completeness = 'partial'
    if (!['cancelled', 'timed_out'].includes(summary.outcome)) summary.outcome = 'incomplete'
    try {
      checkpoint()
      writeReport(join(directory, 'parts', 'publication-error.json'), { message: error.message }, context.limits.logBytes)
    } catch (publicationError) {
      // The summary can still use its protected inode when no additional report inode is available.
      if (!['EDQUOT', 'ENOSPC'].includes(publicationError.code)) throw publicationError
    }
  }
  checkpoint()
  writeSummary(join(directory, 'summary.json'), summary, context.limits.summaryBytes)
  return summary
}

export function verificationScratchEnvironment(context, base) {
  validateVerificationContext(context)
  const directories = { HOME: 'home', TMPDIR: 'tmp', XDG_CACHE_HOME: 'cache',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data' }
  const environment = { ...base }
  for (const [name, directory] of Object.entries(directories)) {
    environment[name] = privateDirectory(join(context.mutableDirectory, directory))
  }
  return environment
}

export async function verifyRepository(context, { root = process.cwd(), signal } = {}) {
  validateVerificationContext(context)
  const directory = prepareVerificationDirectory(root)
  const state = { identity: context.identity, startedAt: new Date().toISOString(),
    expected: context.requiredPortions }
  writeReport(join(directory, 'parts', 'state.json'), state, context.limits.vitestBytes)
  const environment = { ...verificationScratchEnvironment(context, process.env), FOREMAN_CODE_VERIFICATION_ROOT: resolve(root),
    FOREMAN_CODE_VERIFICATION_REPORT_DIR: directory, FOREMAN_CODE_VERIFICATION_LOG_BYTES: String(context.limits.logBytes),
    FOREMAN_CODE_VERIFICATION_REPORT_BYTES: String(context.limits.vitestBytes),
    FOREMAN_CODE_VERIFICATION_UNIT_WORKERS: String(context.identity.parameters.unitWorkers), COREPACK_ENABLE_NETWORK: '0' }
  if (context.identity.suite === 'integration') {
    environment.FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS = String(context.identity.parameters.integrationShards)
    environment.FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS = String(context.qualifiedIntegrationShards)
  }
  let result = { terminalOutcome: 'incomplete', processStopped: true }
  let measurementTimer
  try {
    verifyPrivateGitHead(root, context)
    verifyEffectivePackagePolicy(root, environment)
    verifyOfflinePreseed(root, context.preseedReceipt)
    writeReport(join(directory, 'parts', 'preseed-receipt.json'), context.preseedReceipt, context.limits.logBytes)
    const samples = []
    const sampledPeaks = {}
    const sample = () => {
      try {
        const reading = sampleVerificationResources(context.measurement)
        samples.push(reading)
        for (const [name, value] of Object.entries(reading)) {
          if (typeof value === 'number') sampledPeaks[name] = Math.max(sampledPeaks[name] ?? 0, value)
        }
      }
      catch (error) { samples.push({ sampledAt: new Date().toISOString(), error: error.message }) }
      // Retain a bounded rolling set; cumulative cgroup peaks survive sample rotation.
      if (samples.length > 1000) samples.shift()
    }
    if (context.measurement) { sample(); measurementTimer = setInterval(sample, 1000) }
    privateDirectory(context.storeDirectory)
    const execute = async (command, logName) => {
      const remainingMs = context.executionTimeoutMs - (Date.now() - Date.parse(state.startedAt))
      if (remainingMs <= 0) return { terminalOutcome: 'timed_out', processStopped: true }
      return runSuiteProcess(command, { root, env: environment, directory, limits: context.limits,
        executionTimeoutMs: remainingMs, cancellationTimeoutMs: context.cancellationTimeoutMs, signal, logName })
    }
    result = await execute(offlineInstallCommand(context), 'install')
    writeReport(portionPath(directory, 'root:install', 'command.json'), { key: 'root:install',
      startedAt: state.startedAt, finishedAt: new Date().toISOString(), code: result.code ?? 1 }, context.limits.logBytes)
    if (result.terminalOutcome === 'passed' && context.identity.suite !== 'install') {
      verifyOfflinePreseed(root, context.preseedReceipt)
      verifyEffectivePackagePolicy(root, environment)
      if (context.requiredPortions.some(portion => portion.key === 'root:worker-artifact')) {
        const tool = context.unitCodex
        if (tool?.executable !== '/opt/graphql-ci/tools/codex'
          || createHash('sha256').update(readFileSync(tool.executable)).digest('hex') !== tool.binarySha256) {
          throw new Error('The qualified Codex schema binary is unavailable or changed')
        }
        const artifact = join(context.mutableDirectory, 'worker-artifact')
        environment.FOREMAN_CODE_WORKER_BUILD_COMMIT = context.privateGit.generatedCommit
        environment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY = artifact
        environment.FOREMAN_CODE_WORKER_CODEX_BINARY = tool.executable
        const startedAt = new Date().toISOString()
        result = await execute(['node', 'scripts/build-worker-artifact.mjs',
          'apps/worker/artifacts/test-hosts/ubuntu-24.04-x64-target.json', artifact], 'worker-artifact')
        writeReport(portionPath(directory, 'root:worker-artifact', 'command.json'), {
          key: 'root:worker-artifact', startedAt, finishedAt: new Date().toISOString(), code: result.code ?? 1,
        }, context.limits.logBytes)
      }
      if (result.terminalOutcome === 'passed') {
        const startedAt = new Date().toISOString()
        result = await execute(verificationCommand(context, root), 'root')
        const key = portionKey('', rootCommands[context.identity.suite])
        if (context.requiredPortions.some(portion => portion.key === key
          && ['command', 'integration'].includes(portion.kind))) {
          writeReport(portionPath(directory, key, 'command.json'), { key, startedAt,
            finishedAt: new Date().toISOString(), code: result.code ?? 1, error: result.error }, context.limits.logBytes)
        }
      }
    }
    if (context.measurement) {
      sample()
      writeReport(join(directory, 'parts', 'resource-samples.json'), { samples, sampledPeaks }, context.limits.vitestBytes)
    }
  } catch (error) {
    if (!['cancelled', 'timed_out'].includes(result.terminalOutcome)) result.terminalOutcome = 'incomplete'
    writeReport(join(directory, 'parts', 'runner-error.json'), { message: error.message }, context.limits.logBytes)
  } finally {
    clearInterval(measurementTimer)
  }
  return finalizeVerification(context, { root, directory, state, ...result })
}
