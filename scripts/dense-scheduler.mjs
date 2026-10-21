import { sleep } from './sleep.mjs'
import { createPressureSampler, timeoutScale } from './dense-resources.mjs'

const passed = result => result.code === 0 && result.complete !== false

function validateQueue(items, maxConcurrency) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('Maximum test concurrency must be a positive integer')
  }
  const ids = new Set()
  for (const item of items) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw new Error('Queue items require unique nonempty IDs')
    }
    ids.add(item.id)
  }
  for (const item of items) {
    if ((item.dependsOn ?? []).some(id => !ids.has(id) || id === item.id)) {
      throw new Error(`Unknown or self dependency for ${item.id}`)
    }
  }
}

function resourceCost(item, profiles, pressure) {
  const profile = profiles[item.id] ?? {}
  const durationSeconds = profile.durationMs / 1000
  const cpuCores = durationSeconds > 0 ? (profile.cpuSeconds ?? 0) / durationSeconds : 0
  return {
    cpu: cpuCores / (pressure.cpuCount ?? 1),
    memory: pressure.totalMemoryBytes > 0 ? (profile.peakRssBytes ?? 0) / pressure.totalMemoryBytes : 0,
  }
}

function fitsPressure(item, pressure, running, profiles, { cpuTarget, memoryTarget, allowOversize = false, dedicated = false }) {
  // A dedicated CI computer fills every slot: other load never holds files back, only memory does.
  const cpu = dedicated ? 0 : Math.max(pressure.cpuUtilization ?? 0, pressure.cpuPressure ?? 0)
  const memory = Math.max(pressure.memoryUtilization ?? 0, pressure.memoryPressure ?? 0)
  if (cpu >= cpuTarget || memory >= memoryTarget) return false
  const projected = resourceCost(item, profiles, pressure)
  const oversized = projected.cpu >= cpuTarget || projected.memory >= memoryTarget
  // Observed usage already includes active jobs. Recent starts reserve their profiled cost
  // for one feedback interval because their CPU/RSS may not be visible in the next sample.
  if (dedicated) projected.cpu = 0
  for (const entry of running) {
    const cost = resourceCost(entry.item, profiles, pressure)
    if (!dedicated) projected.cpu += cost.cpu
    projected.memory += cost.memory
  }
  if (cpu + projected.cpu < cpuTarget && memory + projected.memory < memoryTarget) return true
  // A profiled job larger than the target still gets one isolated slot on an idle host.
  return allowOversize && oversized && cpu < cpuTarget / 2 && memory < memoryTarget / 2
}

function requiredByExclusive(pending, itemsById) {
  const required = new Set()
  const visit = item => {
    for (const id of item.dependsOn ?? []) {
      if (required.has(id)) continue
      required.add(id)
      visit(itemsById.get(id))
    }
  }
  for (const item of pending.filter(item => item.exclusive)) visit(item)
  return required
}

async function runAttempt(item, context, execute) {
  const started = performance.now()
  let outcome
  try {
    outcome = await execute(item, context)
  } catch (error) {
    outcome = { code: 1, complete: false, reason: `Executor failed: ${error.message ?? String(error)}` }
  }
  if (!outcome || !Number.isInteger(outcome.code)) {
    outcome = { code: 1, complete: false, reason: 'Executor did not return an exit status' }
  }
  const metrics = { durationMs: performance.now() - started }
  for (const name of ['durationMs', 'peakRssBytes', 'cpuSeconds']) {
    const value = outcome.metrics?.[name]
    if (Number.isFinite(value) && value >= 0) metrics[name] = value
  }
  return { ...outcome, metrics }
}

/** Runs an injectable local executor; worker numbers are reusable, one-based slots. */
export async function scheduleQueue(items, {
  maxConcurrency,
  profiles = {},
  samplePressure,
  execute,
  shouldStop = () => false,
  canUseWorker = () => true,
  pollIntervalMs = 250,
  stallTimeoutMs = 60_000,
  cpuTarget = 0.9,
  dedicated = false,
  memoryTarget = 0.8,
  retest = true,
  onEvent = () => {},
}) {
  validateQueue(items, maxConcurrency)
  if (typeof execute !== 'function') throw new Error('A queue executor is required')
  if (!(pollIntervalMs > 0) || !(stallTimeoutMs > 0)
    || !(cpuTarget > 0 && cpuTarget <= 1) || !(memoryTarget > 0 && memoryTarget <= 1)) {
    throw new Error('Queue polling, stall timeout, and pressure targets must be positive')
  }
  const sample = samplePressure ?? createPressureSampler()
  const updatedProfiles = { ...profiles }
  const itemsById = new Map(items.map(item => [item.id, item]))
  const records = new Map(items.map(item => [item.id, { id: item.id, status: 'NOT_RUN', attempts: [] }]))
  const settled = new Set()
  const retired = new Set()
  const active = new Map()
  let pending = [...items].sort((left, right) =>
    (profiles[right.id]?.durationMs ?? 0) - (profiles[left.id]?.durationMs ?? 0))
  let phase = 'parallel'
  let stalledAt
  let pressureFailure
  let lastStartAt = -Infinity

  const skip = (item, reason) => {
    records.get(item.id).reason = reason
    settled.add(item.id)
    onEvent({ type: 'not-run', item, reason })
  }
  const usableWorker = item => {
    for (let index = 1; index <= maxConcurrency; index++) {
      if (!active.has(index) && !retired.has(index) && canUseWorker(index, item)) return index
    }
    return undefined
  }
  const launch = (item, workerIndex, pressure, attempt) => {
    const context = { workerIndex, attempt, isRetest: attempt === 2, timeoutScale: timeoutScale(pressure) }
    onEvent({ type: 'start', item, ...context, pressure })
    const promise = runAttempt(item, context, execute).then(outcome => {
      const record = records.get(item.id)
      record.attempts.push(outcome)
      record.status = passed(outcome) ? 'PASSED' : 'FAILED'
      if (attempt === 2 && passed(outcome)) record.status = 'FLAKY'
      if (attempt === 1) {
        updatedProfiles[item.id] = { ...updatedProfiles[item.id], ...outcome.metrics }
        settled.add(item.id)
      }
      if (outcome.slotUnavailable) retired.add(workerIndex)
      active.delete(workerIndex)
      onEvent({ type: 'finish', item, ...context, result: outcome, status: record.status })
      return outcome
    })
    active.set(workerIndex, { item, promise, startedAt: performance.now() })
    lastStartAt = performance.now()
    return promise
  }
  const readPressure = async () => {
    try {
      return await sample()
    } catch (error) {
      pressureFailure = `Pressure sampling failed: ${error.message ?? String(error)}`
      onEvent({ type: 'stalled', reason: pressureFailure })
      return undefined
    }
  }
  const waitForFeedback = () => Promise.race([
    sleep(pollIntervalMs), ...[...active.values()].map(entry => entry.promise),
  ])

  while (pending.length || active.size) {
    if (shouldStop() || pressureFailure) {
      for (const item of pending) skip(item, pressureFailure ?? 'Stopped before execution')
      pending = []
      await Promise.all([...active.values()].map(entry => entry.promise))
      break
    }
    pending = pending.filter(item => {
      const failed = (item.dependsOn ?? []).find(id => settled.has(id) && records.get(id).status !== 'PASSED')
      if (!failed) return true
      skip(item, `Dependency did not pass: ${failed}`)
      return false
    })
    const ready = pending.filter(item => (item.dependsOn ?? []).every(id => records.get(id).status === 'PASSED'))
    // Ordinary work fills every slot first; exclusive work runs alone once nothing ordinary is ready, so slots
    // never idle in the middle of a run. Work that depends on an exclusive item resumes in parallel afterwards.
    const ordinaryReady = ready.some(item => !item.exclusive)
    const exclusiveReady = ready.some(item => item.exclusive)
    const exclusiveActive = [...active.values()].some(entry => entry.item.exclusive)
    if (phase === 'parallel' && !ordinaryReady && exclusiveReady) phase = 'drain'
    if (phase === 'drain' && !active.size) phase = 'exclusive'
    if (phase === 'exclusive' && !exclusiveReady && !exclusiveActive) phase = 'parallel'
    let candidates = ready.filter(item => !item.exclusive)
    if (phase === 'drain') candidates = []
    if (phase === 'exclusive') candidates = active.size ? [] : ready.filter(item => item.exclusive)
    const eligible = candidates.map(item => ({ item, workerIndex: usableWorker(item) }))
      .filter(entry => entry.workerIndex !== undefined)
    if (!active.size && !eligible.length) {
      if (candidates.length) {
        for (const item of candidates) skip(item, 'No usable worker')
        const skipped = new Set(candidates.map(item => item.id))
        pending = pending.filter(item => !skipped.has(item.id))
        continue
      }
      for (const item of pending) skip(item, 'Dependencies cannot be satisfied')
      pending = []
      break
    }
    const pressure = await readPressure()
    if (!pressure) continue
    const recent = [...active.values()].filter(entry => performance.now() - entry.startedAt <= pollIntervalMs * 2)
    const next = eligible.find(entry => fitsPressure(entry.item, pressure, recent, updatedProfiles,
      { cpuTarget, memoryTarget, allowOversize: !active.size, dedicated }))
    // A shared host spaces starts so each one shows up in the next pressure sample. A dedicated computer ignores CPU
    // and still reserves every recent start's profiled memory, so it fills free slots without waiting.
    if (next && (dedicated || performance.now() - lastStartAt >= pollIntervalMs)) {
      pending = pending.filter(item => item.id !== next.item.id)
      launch(next.item, next.workerIndex, pressure, 1)
      stalledAt = undefined
      if (dedicated) continue
    } else if (!active.size) {
      stalledAt ??= performance.now()
      if (performance.now() - stalledAt >= stallTimeoutMs) {
        const reason = `Queue stalled under CPU/memory pressure for ${stallTimeoutMs} ms`
        onEvent({ type: 'stalled', reason, pressure })
        for (const item of pending) skip(item, reason)
        pending = []
        break
      }
    } else {
      stalledAt = undefined
    }
    await waitForFeedback()
  }

  // Retests run at a quarter of the workers: low enough load to separate flakes, without one file at a time.
  const failures = items.filter(item => records.get(item.id).status === 'FAILED')
  const retestOne = async item => {
    const started = performance.now()
    let pressure
    while (!shouldStop() && !pressureFailure) {
      pressure = await readPressure()
      if (!pressure || fitsPressure(item, pressure, [], updatedProfiles,
        { cpuTarget, memoryTarget, allowOversize: !active.size, dedicated })) break
      if (performance.now() - started >= stallTimeoutMs) {
        records.get(item.id).retestReason = 'Pressure prevented isolated retest'
        break
      }
      await sleep(pollIntervalMs)
    }
    if (shouldStop() || pressureFailure || records.get(item.id).retestReason) return
    const workerIndex = usableWorker(item)
    if (workerIndex === undefined) {
      records.get(item.id).retestReason = 'No usable worker for isolated retest'
      return
    }
    await launch(item, workerIndex, pressure, 2)
  }
  if (retest) {
    await Promise.all(Array.from({ length: Math.min(failures.length, Math.ceil(maxConcurrency / 4)) }, async () => {
      while (failures.length && !shouldStop() && !pressureFailure) await retestOne(failures.shift())
    }))
  }
  const results = items.map(item => records.get(item.id))
  return { results, unexecuted: items.filter(item => !records.get(item.id).attempts.length), profiles: updatedProfiles }
}
