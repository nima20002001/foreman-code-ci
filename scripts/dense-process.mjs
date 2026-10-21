import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { startProcessMetrics } from './dense-resources.mjs'
import { integrationProcessLimits, integrationProcessProgress, stopGroup,
  superviseIntegrationProcess } from './integration-process.mjs'
import { boundedLog } from './verification-reports.mjs'

/** Executes one command in an owned process group with bounded output and watchdogs. */
export async function executeCommand(item, context, options = {}) {
  const log = options.log ?? item.log
    ?? join(item.cwd ?? process.cwd(), '.logs', 'dense', `${randomUUID()}.log`)
  const output = boundedLog(log, options.maxLogBytes ?? 16 * 1024 * 1024)
  const started = performance.now()
  const progress = integrationProcessProgress()
  const scale = Math.max(1, context.timeoutScale ?? 1)
  const pollIntervalMs = options.pollIntervalMs ?? integrationProcessLimits.pollIntervalMs
  const graceMs = options.graceMs ?? integrationProcessLimits.graceMs
  let child
  try {
    child = spawn(item.command, item.args ?? [], {
      cwd: item.cwd,
      env: { ...process.env, ...item.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const retained = output.close()
    return { code: 1, complete: false, reason: `Runner could not start: ${error.message}`,
      log, output: retained, metrics: { durationMs: performance.now() - started } }
  }
  const recordOutput = chunk => {
    progress.bytes += chunk.length
    progress.lastOutputAt = Date.now()
    output.write(chunk)
  }
  child.stdout.on('data', recordOutput)
  child.stderr.on('data', recordOutput)
  const outputClosed = new Promise(resolve => child.once('close', () => resolve(output.close())))
  let exitSignal
  child.once('exit', (_code, signal) => { exitSignal = signal })
  let monitor
  let cancellation
  let cancelled = false
  const stopOwned = async () => {
    const groups = new Set(monitor?.processGroups() ?? [])
    if (child.pid) groups.add(child.pid)
    for (const group of groups) await stopGroup(group, { graceMs })
  }
  let poll
  try {
    if (child.pid) monitor = startProcessMetrics(child.pid, { intervalMs: options.metricsIntervalMs ?? 100 })
    if (options.shouldStop) {
      poll = setInterval(() => {
        if (!cancelled && options.shouldStop()) {
          cancelled = true
          cancellation = stopOwned().catch(error => error)
        }
      }, Math.min(pollIntervalMs, 250))
    }
    const result = await superviseIntegrationProcess(child, {
      log,
      progress,
      fileTimeoutMs: (item.timeoutMs ?? options.timeoutMs ?? integrationProcessLimits.fileTimeoutMs) * scale,
      idleTimeoutMs: (item.idleTimeoutMs ?? options.idleTimeoutMs ?? integrationProcessLimits.idleTimeoutMs) * scale,
      pollIntervalMs,
      graceMs,
      resetAfterTimeout: async () => {},
    })
    const cancellationError = cancellation && await cancellation
    await stopOwned()
    const metrics = monitor?.stop() ?? { durationMs: performance.now() - started }
    const retained = await outputClosed
    let reason
    if (cancelled) reason = 'Stopped during execution'
    else if (result.error) reason = `Runner failed: ${result.error.message}`
    else if (exitSignal) reason = `Runner died from ${exitSignal}`
    else if (result.code !== 0) reason = `Runner exited with code ${result.code}`
    if (cancellationError) throw cancellationError
    const code = cancelled && result.code === 0 ? 130 : result.code
    const complete = !cancelled && !result.timedOut && !result.error && !exitSignal
    return { ...result, code, complete, metrics, log, output: retained, ...(reason ? { reason } : {}) }
  } catch (error) {
    let cleanupError
    try {
      await stopOwned()
    } catch (failure) {
      cleanupError = failure
    }
    let metrics = { durationMs: performance.now() - started }
    try {
      if (monitor) metrics = monitor.stop()
    } catch (failure) {
      error = new Error(`${error.message}; process metrics failed: ${failure.message}`, { cause: error })
    }
    if (cleanupError) {
      return { code: 1, complete: false, reason: `Runner cleanup failed: ${cleanupError.message}`,
        slotUnavailable: true, metrics, log }
    }
    const retained = await outputClosed
    return { code: 1, complete: false, reason: `Runner failed: ${error.message}`, metrics, log, output: retained }
  } finally {
    clearInterval(poll)
  }
}
