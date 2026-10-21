import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

const smokeFile = 'apps/api/test/ci-smoke.integration.test.ts'

function httpClient(origin, signal, requestTimeoutMs, token, log = console.log) {
  return async (path, { timeoutMs = requestTimeoutMs, step = 'request', ...options } = {}) => {
    const started = Date.now()
    const method = options.method ?? 'GET'
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetch(`${origin}${path}`, { ...options,
        headers: { origin, ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.any([signal, timeout]) })
      const body = await response.text()
      if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${body}`)
      const result = body ? JSON.parse(body) : {}
      if (step.startsWith('admission')) {
        log(`CI smoke ${step}: ${method} ${path} completed in ${Date.now() - started} ms (limit ${timeoutMs} ms).`)
      }
      return result
    } catch (error) {
      if (token && error.message.includes(token)) {
        error = new Error(error.message.replaceAll(token, '[redacted]'))
      }
      if (timeout.aborted || signal.reason?.name === 'TimeoutError') {
        throw new Error(`CI smoke ${step}: ${method} ${path} timed out after ${Date.now() - started} ms `
          + `(request limit ${timeoutMs} ms): ${error.message}`)
      }
      throw new Error(`CI smoke ${step}: ${error.message}`, { cause: error })
    }
  }
}

function smokeTargets(computers) {
  const providers = new Set()
  return computers.filter(computer => {
    if (!computer.ready) return false
    if (computer.hostRef.kind !== 'cloud') return true
    if (providers.has(computer.hostRef.provider)) return false
    providers.add(computer.hostRef.provider)
    return true
  })
}

export async function runInstallCiSmoke({ origin, workspaceId, commit, token,
  timeoutMs = 240_000, requestTimeoutMs = 5000, admissionTimeoutMs = 60_000, pollMs = 1000, log = console.log }) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
  const request = httpClient(origin, signal, requestTimeoutMs, token, log)
  const root = `/api/management/workspaces/${encodeURIComponent(workspaceId)}/ci`
  const tickets = new Set()
  let ciFinished = false
  let admissionCount = 0
  const probes = async () => {
    try {
      do {
        await request('/health/live', { step: 'health probe' })
        if (!ciFinished) await delay(pollMs, undefined, { signal })
      } while (!ciFinished)
    } catch (error) {
      // The deadline also aborts the CI run, whose error names the real cause; a probe's bare abort must not mask it.
      if (!signal.aborted) throw error
    }
  }
  const admit = async selection => {
    const body = JSON.stringify({ suite: selection.smokeComputer ? 'integration' : 'unit', scope: 'affected', commit,
      commandId: randomUUID(), priority: 'high', noSupersede: true, ...selection })
    let result
    while (true) {
      try {
        result = await request(root, { method: 'POST', timeoutMs: admissionTimeoutMs, step: `admission ${++admissionCount}`, body })
        break
      } catch (error) {
        // A Worker still reconnecting after the restart is retried; the smoke deadline bounds the wait.
        if (signal.aborted || !/HTTP 503: .*"retryable":true/.test(error.message)) throw error
        log(error.message)
        await delay(pollMs, undefined, { signal })
      }
    }
    for (const part of result.partitions ?? [result]) tickets.add(part.ticketId)
    if (result.partitions) throw new Error(`CI smoke unexpectedly split into ${result.partitions.length} jobs.`)
    return result.ticketId
  }
  // A slow read right after a restart is retried; the smoke deadline still bounds every retry.
  const read = async (path, step) => {
    while (true) {
      try {
        return await request(path, { step })
      } catch (error) {
        if (signal.aborted || !/timed out/.test(error.message)) throw error
        log(error.message)
      }
    }
  }
  const wait = async (ticketId, computer) => {
    while (true) {
      const result = await read(`${root}/${ticketId}`, `ticket ${ticketId}`)
      if (result.run.state === 'passed' && result.run.exitCode === 0) {
        if (computer) {
          if (!isDeepStrictEqual(result.run.computer?.hostRef, computer.hostRef)) {
            throw new Error(`CI smoke ${ticketId} ran on a different computer.`)
          }
          // Execution settles before report collection; only collected results can prove which file ran.
          if (result.run.collection === 'pending') {
            await delay(pollMs, undefined, { signal })
            continue
          }
          const { tests } = await request(`${root}/${ticketId}/tests`, { step: `test results ${ticketId}` })
          const file = tests?.files.find(file => file.file === smokeFile)
          if (!file?.tests.some(test => test.status === 'passed') || tests.summary.failed !== 0) {
            throw new Error(`CI smoke ${ticketId} passed without running ${smokeFile}.`)
          }
        }
        tickets.delete(ticketId)
        return
      }
      if (['failed', 'canceled', 'lost'].includes(result.run.state)) {
        throw new Error(`CI smoke ${ticketId} (${JSON.stringify(computer?.hostRef)}): `
          + `${result.run.message ?? result.run.state}\n${result.logTail}`)
      }
      await delay(pollMs, undefined, { signal })
    }
  }
  const run = async () => {
    // Use the same HTTP principal and new command IDs to detect a leaked admission lock.
    const first = await admit({ files: [] })
    const second = await admit({ files: [] })
    await wait(first)
    await wait(second)
    let targets
    let lastUnready
    while (true) {
      let computers
      try {
        ({ computers } = await read(`${root}/computers`, 'computer discovery'))
      } catch (cause) {
        // A deadline that lands inside a later discovery must still name the computer that stayed unready.
        throw lastUnready && signal.aborted ? new Error(lastUnready, { cause }) : cause
      }
      const unready = computers.find(computer => !computer.ready && computer.hostRef.kind !== 'cloud')
      if (!unready) {
        targets = smokeTargets(computers)
        break
      }
      const message = `CI smoke enabled computer ${JSON.stringify(unready.hostRef)} is not ready: `
        + unready.reasons.join('; ')
      lastUnready = message
      log(message)
      try {
        await delay(pollMs, undefined, { signal })
      } catch (cause) {
        throw new Error(message, { cause })
      }
    }
    if (!targets.length) throw new Error('CI smoke has no ready executor. Configure CI or explicitly opt out.')
    const jobs = []
    for (const computer of targets) {
      jobs.push({ computer, ticketId: await admit({ files: [smokeFile], smokeComputer: computer.hostRef }) })
    }
    await Promise.all(jobs.map(({ ticketId, computer }) => wait(ticketId, computer)))
    ciFinished = true
  }
  try {
    await Promise.all([probes(), run()])
  } catch (error) {
    if (token && error.message.includes(token)) {
      error = new Error(error.message.replaceAll(token, '[redacted]'))
    }
    controller.abort(error)
    const cleanup = httpClient(origin, AbortSignal.timeout(3000), 3000, token)
    await Promise.all([...tickets].map(async ticketId => {
      try { await cleanup(`${root}/${ticketId}`, { method: 'DELETE' }) }
      catch (failure) { console.error(`CI smoke cancellation ${ticketId}: ${failure.message}`) }
    }))
    if (signal.reason?.name === 'TimeoutError') throw new Error(`CI smoke timed out after ${timeoutMs} ms: ${error.message}`)
    throw error
  } finally {
    controller.abort()
  }
}

export async function runProductionCiSmoke({ origin, release, token, ...smokeOptions }) {
  if (process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1') {
    console.log('CI smoke explicitly skipped (FOREMAN_INSTALL_SKIP_CI_SMOKE=1).')
    return
  }
  const { repository, commit } = JSON.parse(await readFile(join(release, 'ci-smoke.json'), 'utf8'))
  if (!token) throw new Error('Production CI smoke requires an application credential.')
  const request = httpClient(origin, AbortSignal.timeout(5000), 5000, token)
  let cursor
  let workspace
  do {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
    const page = await request(`/api/management/workspaces?${query}`, { step: 'workspace discovery' })
    workspace = page.items.find(item => `${item.workspace.repository?.owner}/${item.workspace.repository?.name}` === repository)
    cursor = page.pageInfo.nextCursor
  } while (!workspace && cursor)
  if (!workspace) throw new Error(`CI smoke requires a configured workspace for ${repository}.`)
  await runInstallCiSmoke({ ...smokeOptions, origin, workspaceId: workspace.workspace.id, commit, token })
  console.log('CI smoke passed: responsive API, consecutive admissions and every ready executor.')
}
