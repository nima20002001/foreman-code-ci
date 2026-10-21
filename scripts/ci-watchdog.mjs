import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { startProcessGroupTracking, startProcessMetrics } from './dense-resources.mjs'
import { stopGroup } from './integration-process.mjs'
import { ciTestResults } from './ci-test-results.mjs'

// Matches the integration runner's per-file silence limit: cold cloud machines run single tests for over a minute.
export const CI_IDLE_TIMEOUT_MS = 180_000
/** Without a known expected duration there is no part deadline; the idle limit still catches hangs. */
export function ciPartDeadlineMs(expectedDurationMs) {
  return expectedDurationMs > 0 ? Math.max(3 * expectedDurationMs, 120_000) : Number.POSITIVE_INFINITY
}

/** Runs outside the test process so blocked test workers cannot block either deadline. */
export async function runCiPart(command, { expectedDurationMs, progressFile, resultsFile, messageFile,
  idleTimeoutMs = CI_IDLE_TIMEOUT_MS, deadlineMs = ciPartDeadlineMs(expectedDurationMs), env = process.env } = {}) {
  mkdirSync(dirname(progressFile), { recursive: true })
  writeFileSync(progressFile, '')
  const progress = openSync(progressFile, 'r')
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...env, CI_WATCHDOG_ACTIVE: '1', CI_PROGRESS_FILE: progressFile, CI_REPOSITORY_ROOT: process.cwd() } })
  await new Promise((ready, reject) => { child.once('spawn', ready); child.once('error', reject) })
  const processGroups = startProcessGroupTracking(child.pid)
  let monitor
  try {
    monitor = startProcessMetrics(child.pid)
  } catch (error) {
    console.warn(`[ci-watchdog] Warning: process metrics unavailable; continuing without metrics: ${error.message}`)
  }
  const started = Date.now()
  let lastProgress = started
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let reason
  let stopping
  let testsStarted = false
  const running = new Map()
  const output = (destination, bytes) => {
    if (!running.size) lastProgress = Date.now()
    destination.write(bytes)
  }
  child.stdout.on('data', bytes => output(process.stdout, bytes))
  child.stderr.on('data', bytes => output(process.stderr, bytes))
  const stop = () => {
    const groups = processGroups.processGroups()
    stopping ??= Promise.all(groups.map(group => stopGroup(group, { graceMs: 1000 })))
    return stopping
  }
  const signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => { void stop() }]))
  for (const [signal, handler] of signals) process.on(signal, handler)
  const readProgress = () => {
    const buffer = Buffer.alloc(65_536)
    let count
    while ((count = readSync(progress, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, count))
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        const event = JSON.parse(line)
        if (event.kind === 'test' && (event.type === 'start' || event.type === 'finish')) testsStarted = true
        if (event.type === 'start') running.set(event.id, event)
        else if (event.type === 'finish') {
          running.delete(event.id)
          lastProgress = Date.now()
        } else if (event.type === 'output') lastProgress = Date.now()
      }
    }
  }
  const timer = setInterval(() => {
    if (stopping) return
    readProgress()
    const elapsed = Date.now() - started
    const idle = Date.now() - lastProgress
    if (elapsed < deadlineMs && idle < idleTimeoutMs) return
    const limit = elapsed >= deadlineMs ? `exceeded part deadline ${deadlineMs} ms`
      : `no test progress for ${idleTimeoutMs} ms`
    const cases = [...running.values()].filter(test => test.kind !== 'module')
    const active = [...running.values()].filter(test => test.kind !== 'module'
      || !cases.some(active => active.file === test.file))
    const labels = active.map(test => `${test.file}${test.name ? ` > ${test.name}` : ' (module setup/teardown)'}`)
    reason = `CI hang watchdog: ${limit}; running: ${labels.join('; ') || 'no test started (setup or command)'}`.slice(0, 1800)
    console.error(`[ci-watchdog] ${reason}`)
    if (messageFile) writeFileSync(messageFile, JSON.stringify({ message: reason, testsStarted }))
    void stop()
  }, 100)
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', code => resolveExit(code ?? 1))
    })
    if (stopping) await stopping
    readProgress()
    if ((reason || code !== 0) && messageFile) {
      writeFileSync(messageFile, JSON.stringify({
        message: reason ?? `CI command failed with exit code ${code}${testsStarted ? '' : ' before the first test started'}.`,
        testsStarted,
      }))
    }
    if (reason && resultsFile) {
      mkdirSync(dirname(resultsFile), { recursive: true })
      const byFile = new Map()
      for (const test of running.values()) {
        const assertions = byFile.get(test.file) ?? []
        if (test.kind !== 'module' || ![...running.values()].some(active => active.file === test.file && active.kind !== 'module')) {
          assertions.push({ fullName: test.name || 'Module setup/teardown', status: 'failed', failureMessages: [reason] })
        }
        byFile.set(test.file, assertions)
      }
      const report = { testResults: [...byFile].map(([name, assertionResults]) => ({
        name, status: 'failed', assertionResults,
      })) }
      writeFileSync(resultsFile, JSON.stringify(ciTestResults([report], process.cwd())))
    }
    return reason ? 1 : code
  } finally {
    clearInterval(timer)
    closeSync(progress)
    processGroups.stop()
    monitor?.stop()
    for (const [signal, handler] of signals) process.off(signal, handler)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv.slice(2)
  if (command[0] === '--') command.shift()
  const expectedDurationMs = Number(process.env.CI_EXPECTED_DURATION_MS ?? 0)
  if (!Number.isFinite(expectedDurationMs) || expectedDurationMs < 0 || !command.length) {
    throw new Error('CI watchdog requires a command and a nonnegative expected duration')
  }
  const base = resolve(process.env.CI_WATCHDOG_DIRECTORY ?? '.logs/ci-watchdog')
  const idleTimeoutMs = Number(process.env.CI_WATCHDOG_IDLE_MS ?? CI_IDLE_TIMEOUT_MS)
  process.exitCode = await runCiPart(command, { expectedDurationMs, idleTimeoutMs,
    progressFile: resolve(base, 'progress.jsonl'),
    ...(process.env.TEST_RESULTS_OUTPUT || process.env.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT
      ? { resultsFile: resolve(process.env.TEST_RESULTS_OUTPUT ?? process.env.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT) } : {}),
    ...(process.env.CI_WATCHDOG_MESSAGE_FILE ? { messageFile: process.env.CI_WATCHDOG_MESSAGE_FILE } : {}) })
}
