import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { executeCommand } from './dense-process.mjs'
import { discoverFiles, runIntegration } from './test-integration.mjs'
import { captureVerificationInventory, collectPortions } from './verification-runner.mjs'
import { emptyCounts, junitReport, positiveInteger, privateDirectory, writeReport } from './verification-reports.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const reportLimits = { logBytes: 2 ** 20, vitestBytes: 16 * 2 ** 20 }
const unitCommands = [
  ['gate:contracts-unit', 'packages/contracts:test', '@foreman-code/contracts', 'test'],
  ['gate:api-unit', 'apps/api:test', '@foreman-code/api', 'test'],
  ['gate:web-unit', 'apps/web:test:unit', '@foreman-code/web', 'test:unit'],
  ['gate:web-smoke', 'apps/web:test:run-graph-smoke', '@foreman-code/web', 'test:run-graph-smoke'],
  ['gate:worker-unit', 'apps/worker:test', '@foreman-code/worker', 'test'],
  ['gate:scripts-unit', 'root:test:scripts', undefined, 'test:scripts'],
]

export function createDenseItems({ root = repositoryRoot, env = process.env, inventory } = {}) {
  const portions = inventory ?? captureVerificationInventory(root, 'unit')
  const unitWorkers = positiveInteger(Number(env.GRAPHQL_DENSE_UNIT_WORKERS ?? 2), 'Dense unit workers', 12)
  const timeoutMs = positiveInteger(Number(env.GRAPHQL_DENSE_ITEM_TIMEOUT_MS ?? 1_800_000), 'Dense item timeout')
  const idleTimeoutMs = positiveInteger(Number(env.GRAPHQL_DENSE_IDLE_TIMEOUT_MS ?? 60_000), 'Dense idle timeout')
  const environment = { ...env, FOREMAN_CODE_VERIFICATION_UNIT_WORKERS: String(unitWorkers),
    FOREMAN_CODE_TEST_MAX_WORKERS: String(unitWorkers) }
  const items = unitCommands.map(([id, key, filter, script]) => {
    const portion = portions.find(candidate => candidate.key === key)
    if (!portion?.files?.length) throw new Error(`Missing dense unit inventory: ${key}`)
    const packageArguments = filter ? ['--filter', filter, script] : [script]
    return { id, command: 'corepack',
      args: ['pnpm', 'exec', 'node', join(root, 'scripts/test-command.mjs'), '--', 'corepack', 'pnpm',
        ...packageArguments],
      cwd: root, env: environment, timeoutMs, idleTimeoutMs, portion }
  })
  const commands = [
    ['lint', ['-r', '--no-bail', '--no-sort', '--if-present', 'lint']],
    ['typecheck', ['-r', '--if-present', 'typecheck']],
    ['build', ['build']],
  ]
  for (const [script, args] of commands) {
    items.push({ id: `gate:${script}`, command: 'corepack', args: ['pnpm', ...args],
      cwd: root, env: environment, timeoutMs, idleTimeoutMs, exclusive: script === 'build' })
  }
  return items
}

function attemptDirectory(directory, item, context) {
  return privateDirectory(join(directory, 'jobs', item.id.replace(/[^a-zA-Z0-9-]/g, '_'),
    `attempt-${context.attempt}`))
}

export async function executeDenseItem(item, context, {
  directory, execute = executeCommand, shouldStop = () => false,
} = {}) {
  const reports = attemptDirectory(directory, item, context)
  const environment = { ...item.env }
  if (item.portion) {
    Object.assign(environment, {
      FOREMAN_CODE_VERIFICATION_ROOT: item.cwd,
      FOREMAN_CODE_VERIFICATION_REPORT_DIR: reports,
      FOREMAN_CODE_VERIFICATION_LOG_BYTES: String(reportLimits.logBytes),
      FOREMAN_CODE_VERIFICATION_REPORT_BYTES: String(reportLimits.vitestBytes),
    })
    delete environment.FOREMAN_CODE_VERIFICATION_COMMAND_KEY
  }
  const result = await execute({ ...item, env: environment, log: join(reports, 'command.log') }, context,
    { shouldStop, maxLogBytes: reportLimits.logBytes })
  if (!item.portion) return result
  const [portion] = collectPortions(reports, item.cwd, [item.portion], reportLimits)
  const coverage = { key: portion.key, complete: portion.complete, failed: portion.failed,
    expectedFiles: item.portion.files.length, reportedFiles: portion.files.length,
    totals: portion.totals, missing: portion.missing, error: portion.error }
  const passed = portion.complete && !portion.failed && portion.totals.skipped === 0
  let reason = result.reason
  if (!passed && !reason) {
    reason = portion.error ?? `Unit coverage incomplete or failed (${portion.totals.skipped} skipped cases)`
  }
  return { ...result, code: passed ? result.code : result.code || 1,
    complete: result.complete && portion.complete, reason, coverage }
}

function reportedAttempt(attempt) {
  const { code, complete, reason, timedOut, metrics, log, output, coverage } = attempt
  return { code, complete, reason, timedOut, metrics, log, output, coverage }
}

export function denseSummary({ items, integrationFiles, integration, startedAt, finishedAt, error }) {
  const expected = [...integrationFiles, ...items.map(item => item.id)]
  const scheduled = new Map((integration.results ?? []).map(result => [result.id, result]))
  const results = expected.map(id => {
    const result = scheduled.get(id) ?? { id, status: 'NOT_RUN', attempts: [], reason: 'Required job did not run' }
    return { ...result, attempts: result.attempts.map(reportedAttempt) }
  })
  const counts = { passed: 0, failed: 0, flaky: 0, notRun: 0 }
  const countNames = { PASSED: 'passed', FAILED: 'failed', FLAKY: 'flaky', NOT_RUN: 'notRun' }
  for (const result of results) counts[countNames[result.status]]++
  const reportIncomplete = integration.report?.completeness === 'partial'
  const failure = error ?? integration.error ?? integration.cleanupError ?? integration.report?.publicationError
    ?? (reportIncomplete ? 'Integration report is incomplete' : undefined)
  const complete = !failure && results.every(result => result.status !== 'NOT_RUN'
    && result.attempts.length > 0 && result.attempts.every(attempt => attempt.complete))
  const failed = counts.failed > 0 || counts.flaky > 0 || integration.code !== 0
  let outcome = complete ? 'passed' : 'incomplete'
  if (complete && failed) outcome = 'failed'
  if ([130, 143].includes(integration.code)) outcome = 'cancelled'
  const totals = { ...(integration.report?.totals ?? emptyCounts()) }
  for (const result of results) {
    const coverage = result.attempts[0]?.coverage
    if (coverage) for (const key of Object.keys(totals)) totals[key] += coverage.totals[key]
  }
  return { schemaVersion: 1, suite: 'dense', startedAt, finishedAt, outcome,
    completeness: complete ? 'complete' : 'partial', expectedJobs: expected.length,
    completedJobs: results.filter(result => result.attempts[0]?.complete).length,
    counts, totals, error: failure, integrationReportDirectory: integration.reportDirectory, results }
}

function denseJunit(summary) {
  const files = summary.results.map(result => {
    const passed = result.status === 'PASSED'
    const duration = result.attempts.reduce((total, attempt) => total + (attempt.metrics?.durationMs ?? 0), 0)
    const reasons = result.attempts.map(attempt => attempt.reason).filter(Boolean)
    const message = [result.status, result.reason, ...reasons].filter(Boolean).join(': ')
    return { name: result.id, status: passed ? 'passed' : 'failed', startTime: 0, endTime: duration,
      assertionResults: [{ title: result.id, fullName: result.id, status: passed ? 'passed' : 'failed',
        duration, failureMessages: passed ? [] : [message] }] }
  })
  if (summary.error) {
    files.push({ name: 'dense:runner', status: 'failed', message: summary.error,
      startTime: 0, endTime: 0, assertionResults: [] })
  }
  return junitReport(files, summary.outcome, { suite: 'dense' })
}

export async function runDense(argv = [], {
  root = repositoryRoot, env = process.env, directory, inventory, integrationFiles,
  integrationRunner = runIntegration, execute = executeCommand,
} = {}) {
  if (argv.length) throw new Error('Usage: test-dense.mjs (configure the full gate through environment variables)')
  for (const name of ['INTEGRATION_START_AT', 'INTEGRATION_FAILED_LOG', 'INTEGRATION_TEST_NAME_PATTERN']) {
    if (readProductEnvironment(env, name)) throw new Error(`Dense gate requires full integration coverage: unset ${name}`)
  }
  const startedAt = new Date().toISOString()
  const reports = directory ?? join(root, '.logs', 'test-dense', `${Date.now()}-${randomUUID()}`)
  privateDirectory(reports)
  privateDirectory(join(reports, 'jobs'))
  const items = createDenseItems({ root, env, inventory })
  const requiredIntegrationFiles = integrationFiles ?? discoverFiles()
  let integration = { code: 1, results: [] }
  let error
  try {
    integration = await integrationRunner([], {
      env, extraItems: items, reportDirectory: reports,
      profilePath: env.GRAPHQL_TEST_PROFILE_PATH ?? join(root, '.logs', 'test-profiles.json'),
      executeExtra: (item, context, controls) => executeDenseItem(item, context,
        { directory: reports, execute, shouldStop: controls?.shouldStop }),
    })
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  const summary = denseSummary({ items, integrationFiles: requiredIntegrationFiles,
    integration, startedAt, finishedAt: new Date().toISOString(), error })
  writeReport(join(reports, 'summary.json'), summary, reportLimits.vitestBytes)
  writeReport(join(reports, 'junit.xml'), denseJunit(summary), reportLimits.vitestBytes)
  const code = [130, 143].includes(integration.code) ? integration.code : Number(summary.outcome !== 'passed')
  return { code, summary, directory: reports }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runDense(process.argv.slice(2))
  console.log(`[dense] ${result.summary.outcome}: ${JSON.stringify(result.summary.counts)}`)
  console.log(`[dense] reports: ${result.directory}`)
  process.exitCode = result.code
}
