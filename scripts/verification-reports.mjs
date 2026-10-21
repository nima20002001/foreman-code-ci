import { integrationEnvironmentCapabilities, partitionUnitCapabilities } from './integration-capabilities.mjs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const reportPaths = {
  summary: '.logs/verification/summary.json',
  junit: '.logs/verification/junit.xml',
  vitest: '.logs/verification/vitest.json',
  logs: '.logs/verification/logs.tar.gz',
}
export const emptyCounts = () => ({ total: 0, passed: 0, failed: 0, skipped: 0 })
const skippedStates = new Set(['pending', 'skipped', 'todo', 'disabled'])

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer at most ${maximum}`)
  }
  return value
}

export function privateDirectory(path) {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) privateDirectory(parent)
  try {
    const stat = lstatSync(absolute)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe report directory: ${absolute}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    mkdirSync(absolute, { mode: 0o700 })
  }
  return absolute
}

export function readReport(path, maxBytes) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path) || stat.size > maxBytes) {
    throw new Error(`Missing, unsafe or oversized report: ${path}`)
  }
  return readFileSync(path, 'utf8')
}

export function writeReport(path, value, maxBytes) {
  const bytes = Buffer.isBuffer(value) ? value
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  if (bytes.length > maxBytes) throw new Error(`Report exceeds its declared byte limit: ${basename(path)}`)
  privateDirectory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export function portionKey(directory, script) {
  return `${directory || 'root'}:${script}`
}

export function portionPath(directory, key, suffix) {
  const name = key.replace(/[^a-zA-Z0-9-]/g, '_')
  return join(directory, 'parts', `${name}.${suffix}`)
}

export function repositoryFile(root, name) {
  if (typeof name !== 'string' || !name) throw new Error('Report file name is missing')
  const path = relative(root, isAbsolute(name) ? name : resolve(root, name))
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Report file is outside the source snapshot')
  }
  return path.split(sep).join('/')
}

export function normalizeVitestReport(report, { root, expectedFiles }) {
  if (!report || !Array.isArray(report.testResults) || typeof report.success !== 'boolean') {
    throw new Error('Corrupt Vitest JSON report')
  }
  const suiteCounts = [report.numTotalTestSuites, report.numPassedTestSuites,
    report.numFailedTestSuites, report.numPendingTestSuites]
  if (suiteCounts.some((value) => !Number.isSafeInteger(value) || value < 0)
    || suiteCounts[0] !== suiteCounts[1] + suiteCounts[2] + suiteCounts[3]) {
    throw new Error('Vitest suite totals do not reconcile')
  }
  const totals = emptyCounts()
  const seen = new Set()
  const files = report.testResults.map((file) => {
    const name = repositoryFile(root, file.name)
    if (seen.has(name) || !['passed', 'failed'].includes(file.status) || !Array.isArray(file.assertionResults)) {
      throw new Error('Corrupt or duplicated file result')
    }
    seen.add(name)
    if (!Number.isFinite(file.startTime) || !Number.isFinite(file.endTime) || file.endTime < file.startTime) {
      throw new Error('Corrupt file timing')
    }
    const assertions = file.assertionResults.map((test) => {
      if (typeof test.fullName !== 'string' || !['passed', 'failed', ...skippedStates].includes(test.status)) {
        throw new Error('Corrupt case result')
      }
      if ((test.duration != null && (!Number.isFinite(test.duration) || test.duration < 0))
        || (test.failureMessages != null && (!Array.isArray(test.failureMessages)
          || test.failureMessages.some((message) => typeof message !== 'string')))) {
        throw new Error('Corrupt case timing or failure messages')
      }
      totals.total++
      if (skippedStates.has(test.status)) totals.skipped++
      else totals[test.status]++
      return { fullName: test.fullName, title: test.title ?? test.fullName, status: test.status,
        duration: test.duration ?? 0, failureMessages: test.failureMessages ?? [] }
    })
    return { name, status: file.status, message: file.message ?? '',
      startTime: file.startTime, endTime: file.endTime, assertionResults: assertions }
  })
  const declared = [report.numTotalTests, report.numPassedTests, report.numFailedTests,
    report.numPendingTests + (report.numTodoTests ?? 0)]
  if (declared.some((value) => !Number.isSafeInteger(value) || value < 0)
    || declared.some((value, index) => value !== Object.values(totals)[index])) {
    throw new Error('Vitest case totals do not reconcile')
  }
  const missing = expectedFiles.filter((file) => !seen.has(file))
  const unexpected = [...seen].filter((file) => !expectedFiles.includes(file))
  if (unexpected.length) throw new Error('Report contains files outside its inventory')
  const incomplete = missing.length > 0 || files.some((file) => !file.assertionResults.length)
  return { files, totals, missing, complete: !incomplete,
    failed: !report.success || report.numFailedTestSuites > 0 || files.some((file) => file.status === 'failed') || totals.failed > 0 }
}

export function readVitestReport(path, options) {
  return normalizeVitestReport(JSON.parse(readReport(path, options.maxBytes)), options)
}

export function mergedVitestReport(files, startedAt, outcome) {
  const cases = files.flatMap((file) => file.assertionResults)
  const skipped = cases.filter((test) => skippedStates.has(test.status)).length
  return {
    numTotalTestSuites: files.length,
    numPassedTestSuites: files.filter((file) => file.status === 'passed').length,
    numFailedTestSuites: files.filter((file) => file.status === 'failed').length,
    numPendingTestSuites: 0,
    numTotalTests: cases.length,
    numPassedTests: cases.filter((test) => test.status === 'passed').length,
    numFailedTests: cases.filter((test) => test.status === 'failed').length,
    numPendingTests: skipped,
    numTodoTests: 0,
    startTime: Date.parse(startedAt),
    success: outcome === 'passed',
    testResults: files,
  }
}

const xml = (value) => String(value).toWellFormed().replace(/[\ufffe\uffff]/g, '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

export function junitReport(files, outcome, identity = {}) {
  const report = mergedVitestReport(files, new Date(0).toISOString(), outcome)
  const properties = Object.entries({ outcome, ...identity }).map(([name, value]) =>
    `<property name="${xml(name)}" value="${xml(typeof value === 'string' ? value : JSON.stringify(value))}"/>`).join('')
  let errors = 0
  const suites = files.map((file) => {
    const failed = file.assertionResults.filter((test) => test.status === 'failed').length
    const skipped = file.assertionResults.filter((test) => skippedStates.has(test.status)).length
    const setupError = Number(file.status === 'failed' && failed === 0)
    errors += setupError
    const cases = file.assertionResults.map((test) => {
      let result = ''
      if (test.status === 'failed') result = `<failure>${xml(test.failureMessages.join('\n'))}</failure>`
      if (skippedStates.has(test.status)) result = '<skipped/>'
      return `<testcase name="${xml(test.fullName)}" classname="${xml(file.name)}" time="${test.duration / 1000}">${result}</testcase>`
    })
    const message = setupError ? `<system-err>${xml(file.message || 'File failed outside a test case')}</system-err>` : ''
    return `<testsuite name="${xml(file.name)}" tests="${cases.length}" failures="${failed}" skipped="${skipped}" errors="${setupError}">`
      + `<properties>${properties}</properties>${cases.join('')}${message}</testsuite>`
  })
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<testsuites tests="${report.numTotalTests}" failures="${report.numFailedTests}" skipped="${report.numPendingTests}" errors="${errors}">`
    + suites.join('') + '</testsuites>\n'
}

export function suiteSummary(identity, portions, { startedAt, finishedAt, terminalOutcome, processStopped }) {
  const totals = emptyCounts()
  for (const portion of portions) for (const name of Object.keys(totals)) totals[name] += portion.totals[name]
  const completedPortions = portions.filter((portion) => portion.complete).length
  const firstPassFailed = portions.filter((portion) => portion.failed).length
  const complete = completedPortions === portions.length && processStopped
  let outcome = 'passed'
  if (!complete) outcome = 'incomplete'
  else if (firstPassFailed || totals.failed || totals.skipped || terminalOutcome === 'failed') outcome = 'failed'
  if (terminalOutcome === 'cancelled' || terminalOutcome === 'timed_out') outcome = terminalOutcome
  if (terminalOutcome === 'incomplete') outcome = 'incomplete'
  return { schemaVersion: 1, ...identity, startedAt, finishedAt, totals, firstPassFailed,
    expectedPortions: portions.length, completedPortions, disallowedSkipped: totals.skipped,
    completeness: complete ? 'complete' : 'partial', outcome }
}

export function boundedLog(path, maxBytes) {
  privateDirectory(dirname(path))
  const fd = openSync(path, 'wx', 0o600)
  let bytes = 0
  let discardedBytes = 0
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = Math.max(0, maxBytes - bytes)
      const kept = buffer.subarray(0, remaining)
      if (kept.length) writeFileSync(fd, kept)
      bytes += kept.length
      discardedBytes += buffer.length - kept.length
    },
    close() { closeSync(fd); return { bytes, discardedBytes } },
  }
}

function tarEntry(name, bytes) {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100))
  for (const [offset, length, value] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0],
    [124, 12, bytes.length], [136, 12, 0]]) {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length)
  }
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

export function logArchive(directory, maxBytes) {
  if (realpathSync(directory) !== resolve(directory)) throw new Error('Archive directory contains a symlink')
  // Bound the uncompressed input too, so publication cannot allocate an unbounded buffer.
  const entries = []
  const expandedLimit = Math.min(maxBytes, 128 * 1024 * 1024)
  const gzipOverhead = Math.ceil(expandedLimit / 16384) * 5 + 4096
  let remaining = Math.max(0, expandedLimit - gzipOverhead)
  let index = 0
  const inventory = { includedFiles: 0, truncatedFiles: 0, omittedFiles: 0, sourceBytes: 0 }
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      const stat = lstatSync(child)
      if (stat.isSymbolicLink()) throw new Error('Archive contains a symlink')
      if (stat.isDirectory()) visit(child)
      else if (stat.isFile()) {
        inventory.sourceBytes += stat.size
        if (remaining <= 1024) { inventory.omittedFiles++; continue }
        const length = Math.min(stat.size, remaining - 1024)
        const fd = openSync(child, 'r')
        const bytes = Buffer.alloc(length)
        try { readSync(fd, bytes, 0, length, 0) }
        finally { closeSync(fd) }
        const truncated = length < stat.size
        inventory.includedFiles++
        if (truncated) inventory.truncatedFiles++
        entries.push(tarEntry(`logs/${index++}-${basename(child).slice(-60)}${truncated ? '.partial' : ''}`, bytes))
        remaining -= 512 + Math.ceil(length / 512) * 512
      }
    }
  }
  visit(directory)
  const manifest = tarEntry('archive-index.json', Buffer.from(JSON.stringify(inventory)))
  const tar = Buffer.concat([manifest, ...entries, Buffer.alloc(1024)])
  let archive = gzipSync(tar)
  if (tar.length > archive.length * 100) archive = gzipSync(tar, { level: 0 })
  if (archive.length > maxBytes) throw new Error('Log archive exceeds its declared byte limit')
  return archive
}

export async function reportedCommand(command, { cwd, env, key, directory, logBytes }) {
  const startedAt = new Date().toISOString()
  const log = boundedLog(portionPath(directory, key, 'log'), logBytes)
  const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => log.write(chunk))
  child.stderr.on('data', (chunk) => log.write(chunk))
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ code: 1, error: error.message }))
    child.once('close', (code, signal) => done({ code: code ?? 1, signal }))
  })
  const receipt = { key, startedAt, finishedAt: new Date().toISOString(), ...result, log: log.close() }
  writeReport(portionPath(directory, key, 'command.json'), receipt, logBytes)
  console.log(`[verification] ${key}: exit ${receipt.code}`)
  return receipt.code
}

export async function runVerificationCommand(command, {
  root, cwd, env, script, environmentCapabilities = integrationEnvironmentCapabilities,
}) {
  const reportDirectory = privateDirectory(env.FOREMAN_CODE_VERIFICATION_REPORT_DIR)
  const directory = env.FOREMAN_CODE_VERIFICATION_COMMAND_KEY
    ? privateDirectory(join(reportDirectory, `nested-${randomUUID()}`)) : reportDirectory
  const key = portionKey(relative(root, cwd).split(sep).join('/'), script)
  const logBytes = positiveInteger(Number(env.FOREMAN_CODE_VERIFICATION_LOG_BYTES), 'Log byte limit')
  const nodeTests = basename(command[0]) === 'node' && command.includes('--test')
  const commandEnvironment = { ...env, FOREMAN_CODE_VERIFICATION_REPORT_DIR: directory,
    FOREMAN_CODE_VERIFICATION_COMMAND_KEY: key }
  // An independent suite must use its requested reporters, not its parent's test IPC channel.
  if (nodeTests) delete commandEnvironment.NODE_TEST_CONTEXT
  const options = { cwd, env: commandEnvironment, key, directory, logBytes }
  let unavailable = []
  if (command[0] === 'vitest') {
    const inventory = portionPath(directory, key, 'inventory.json')
    const args = command.slice(1).filter((value) => value !== 'run')
    const listed = await reportedCommand([command[0], 'list', ...args, '--filesOnly', `--json=${inventory}`],
      { ...options, key: `${key}:inventory` })
    if (listed !== 0) return listed
    const files = JSON.parse(readReport(inventory, Number(env.FOREMAN_CODE_VERIFICATION_REPORT_BYTES)))
      .map((entry) => repositoryFile(root, entry.file))
    writeReport(inventory, files, Number(env.FOREMAN_CODE_VERIFICATION_REPORT_BYTES))
    const environment = await environmentCapabilities(env)
    const partition = partitionUnitCapabilities(files, environment)
    unavailable = partition.unavailable
    writeReport(portionPath(directory, key, 'capabilities.json'), { environment, unavailable },
      Number(env.FOREMAN_CODE_VERIFICATION_REPORT_BYTES))
    if (unavailable.length) {
      console.error(`[verification] ${key}: ${unavailable.length} required files unavailable`)
      if (!partition.runnable.length) return 1
      command = [...command, ...unavailable.flatMap(({ file }) =>
        ['--exclude', relative(cwd, join(root, file)).split(sep).join('/')])]
    }
    command = [...command, '--reporter=default', '--reporter=json',
      `--outputFile.json=${portionPath(directory, key, 'vitest.json')}`]
  }
  if (nodeTests) {
    const files = command.slice(command.indexOf('--test') + 1).filter((arg) => !arg.startsWith('-'))
      .map((file) => repositoryFile(root, resolve(cwd, file)))
    writeReport(portionPath(directory, key, 'inventory.json'), files, logBytes)
    const workerLimit = env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
    const concurrency = workerLimit === undefined ? []
      : [`--test-concurrency=${positiveInteger(Number(workerLimit), 'Node test workers', 256)}`]
    command = [command[0], ...concurrency, '--test-reporter=spec', `--test-reporter=${import.meta.filename}`,
      '--test-reporter-destination=stdout',
      `--test-reporter-destination=${portionPath(directory, key, 'node.ndjson')}`, ...command.slice(1)]
  }
  const code = await reportedCommand(command, options)
  return unavailable.length ? (code || 1) : code
}

export default async function* nodeReporter(source) {
  let bytes = 0
  const maximum = Number(process.env.FOREMAN_CODE_VERIFICATION_REPORT_BYTES)
  for await (const { type, data } of source) {
    if (!['test:start', 'test:pass', 'test:fail', 'test:summary'].includes(type)) continue
    const event = { type, timestamp: Date.now(), file: data.file, name: data.name, skip: data.skip, todo: data.todo,
      counts: data.counts, success: data.success, nesting: data.nesting,
      duration: data.details?.duration_ms ?? data.duration_ms, testType: data.details?.type,
      error: data.details?.error?.message?.slice(0, 4096) }
    const line = `${JSON.stringify(event)}\n`
    bytes += Buffer.byteLength(line)
    if (Number.isSafeInteger(maximum) && bytes <= maximum) yield line
  }
}

export function readNodeReport(path, { root, expectedFiles, maxBytes }) {
  const files = new Map()
  let finalSummary
  let corrupt = false
  for (const line of readReport(path, maxBytes).trim().split('\n')) {
    let event
    try { event = JSON.parse(line) }
    catch { corrupt = true; break } // A killed reporter can leave a final partial line.
    if (!['test:start', 'test:pass', 'test:fail', 'test:summary'].includes(event.type)) {
      corrupt = true
      break
    }
    if (event.type === 'test:summary' && !event.file) { finalSummary = event; continue }
    if (!event.file) continue
    const name = repositoryFile(root, event.file)
    if (!expectedFiles.includes(name)) throw new Error('Node report contains a file outside its inventory')
    const file = files.get(name) ?? { name, status: 'passed', message: '',
      startTime: event.timestamp ?? 0, endTime: event.timestamp ?? 0, titles: [], assertionResults: [] }
    files.set(name, file)
    file.endTime = event.timestamp ?? file.endTime
    if (event.type === 'test:start') {
      file.titles[event.nesting] = event.name
      file.titles.length = event.nesting + 1
      continue
    }
    if (event.type === 'test:summary') {
      file.complete = true
      if (!event.success) file.status = 'failed'
    } else if (event.testType !== 'suite') {
      const status = event.skip || event.todo ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed'
      const fullName = [...file.titles.slice(0, event.nesting ?? 0), event.name].join(' > ')
      file.assertionResults.push({ fullName, title: event.name, status,
        duration: event.duration ?? 0, failureMessages: event.error ? [event.error] : [] })
      if (status === 'failed') file.status = 'failed'
    }
  }
  const results = [...files.values()]
  const failed = finalSummary?.success === false || results.some((file) => file.status === 'failed')
  const report = mergedVitestReport(results, new Date(0).toISOString(), failed ? 'failed' : 'passed')
  const normalized = normalizeVitestReport(report, { root, expectedFiles })
  const counts = finalSummary?.counts
  const countsAgree = counts && ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']
    .every((name) => Number.isSafeInteger(counts[name]) && counts[name] >= 0)
    && counts.tests === normalized.totals.total && counts.passed === normalized.totals.passed
    && counts.failed + counts.cancelled === normalized.totals.failed
    && counts.skipped + counts.todo === normalized.totals.skipped
  return { ...normalized, complete: normalized.complete && !corrupt && Boolean(finalSummary) && countsAgree
    && results.every((file) => file.complete) }
}

if (process.argv[2] === '__command' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , , root, cwd, script, ...command] = process.argv
  runVerificationCommand(command, { root, cwd, script, env: process.env })
    .then((code) => { process.exitCode = code })
    .catch((error) => { console.error(`[verification] ${error.message}`); process.exitCode = 1 })
}
