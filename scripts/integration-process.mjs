import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'

// A case can take 240 seconds plus hooks; multi-case files can exceed ten minutes.
// Log inactivity catches a hung file within five minutes without cutting off a progressing one.
export const integrationProcessLimits = {
  idleTimeoutMs: 5 * 60_000,
  fileTimeoutMs: 5 * 60_000,
  pollIntervalMs: 1000,
  graceMs: 5000,
}

/** How long a file with a known typical duration may run before it counts as hung: three times its usual time, but
 * at least a minute more, scaled for host pressure and never above the pressure-scaled per-file limit. */
export function adaptiveDeadlineMs(expectedMs, fileTimeoutMs, timeoutScale = 1) {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) return null
  return Math.min(fileTimeoutMs, Math.ceil(Math.max(3 * expectedMs, expectedMs + 60_000) * Math.max(1, timeoutScale)))
}

export function groupUsed(pgid) {
  if (!pgid) return false
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ')
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
  }
  return false
}

function signalGroup(pgid, signal) {
  if (!pgid) return
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function waitForGroupExit(pgid, graceMs) {
  const started = Date.now()
  while (groupUsed(pgid) && Date.now() - started < graceMs) {
    await new Promise((done) => setTimeout(done, Math.min(100, graceMs)))
  }
  return !groupUsed(pgid)
}

export async function stopGroup(pgid, { signal = 'SIGTERM', graceMs = 5000 } = {}) {
  if (!groupUsed(pgid)) return
  signalGroup(pgid, signal)
  if (await waitForGroupExit(pgid, graceMs)) return
  signalGroup(pgid, 'SIGKILL')
  if (!await waitForGroupExit(pgid, graceMs)) {
    throw new Error(`Child process group ${pgid} did not exit`)
  }
}

export function integrationProcessProgress() {
  const started = Date.now()
  return { started, lastOutputAt: started, bytes: 0, loggedBytes: 0 }
}

function updateProgress(log, progress) {
  const bytes = statSync(log).size
  if (bytes !== progress.loggedBytes) {
    progress.loggedBytes = bytes
    progress.bytes = Math.max(progress.bytes, bytes)
    progress.lastOutputAt = Date.now()
  }
}

export function waitForIntegrationProcess(child, {
  log,
  progress = integrationProcessProgress(),
  idleTimeoutMs = integrationProcessLimits.idleTimeoutMs,
  fileTimeoutMs = integrationProcessLimits.fileTimeoutMs,
  deadlineMs = null,
  pollIntervalMs = integrationProcessLimits.pollIntervalMs,
  graceMs = integrationProcessLimits.graceMs,
  onTimeout = () => {},
  finished,
}) {
  // A file past its adaptive deadline is hung even while it still logs; the idle watchdog stays as a backstop.
  const hungAfterMs = deadlineMs !== null && deadlineMs < fileTimeoutMs ? deadlineMs : null
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let hung = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(result)
    }
    const onError = (error) => finish({ code: 1, error, timedOut })
    const onExit = (code, signal) => {
      if (timedOut) return
      finish({ code: code ?? (signal === 'SIGINT' ? 130 : 143), timedOut: false })
    }
    const check = async () => {
      if (settled || timedOut) return
      try {
        updateProgress(log, progress)
        const now = Date.now()
        const elapsed = now - progress.started
        const idle = now - progress.lastOutputAt
        hung = hungAfterMs !== null && elapsed >= hungAfterMs
        if (!hung && elapsed < fileTimeoutMs && idle < idleTimeoutMs) return
        timedOut = true
        const reason = hung ? `hung: still running after its ${hungAfterMs} ms deadline`
          : elapsed >= fileTimeoutMs ? `file exceeded ${fileTimeoutMs} ms`
            : `no log output for ${idleTimeoutMs} ms`
        const error = new Error(`Integration process timed out: ${reason}`)
        appendFileSync(log, `\n[integration] TIMEOUT: ${reason}\n`)
        onTimeout(error)
        await stopGroup(child.pid, { graceMs })
        finish({ code: 124, error, timedOut: true, ...(hung ? { hung: true } : {}) })
      } catch (error) {
        finish({ code: 1, error, timedOut })
      }
    }
    const timer = setInterval(() => { void check() }, pollIntervalMs)
    child.once('error', onError)
    child.once('exit', onExit)
    // A reused coordinator reports each file's status without exiting.
    finished?.then((code) => { if (!timedOut) finish({ code, timedOut: false }) })
  })
}

export async function superviseIntegrationProcess(child, {
  resetAfterTimeout, cleanupAfterExit = async () => {},
  stopProcesses = (_result, graceMs) => stopGroup(child.pid, { graceMs }), ...options
}) {
  const result = await waitForIntegrationProcess(child, options)
  try {
    await stopProcesses(result, options.graceMs ?? integrationProcessLimits.graceMs)
    await cleanupAfterExit()
  } catch (error) {
    return { ...result, code: 1, error, slotUnavailable: true }
  }
  if (result.timedOut) {
    try {
      await resetAfterTimeout()
    } catch (resetError) {
      appendFileSync(options.log, `\n[integration] SLOT RETIRED: ${resetError.message}\n`)
      return { ...result, resetError, slotUnavailable: true }
    }
  }
  return result
}
