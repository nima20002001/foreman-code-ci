import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readReport, writeReport } from './verification-reports.mjs'

const profileLimitBytes = 4 * 1024 * 1024
const metricNames = ['durationMs', 'peakRssBytes', 'cpuSeconds']
let processUnits

function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('Test profiles must be an object keyed by item ID')
  }
  for (const [id, metrics] of Object.entries(profiles)) {
    if (!id || !metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new Error(`Invalid test profile: ${id}`)
    }
    for (const name of metricNames) {
      if (name !== 'durationMs' && metrics[name] === undefined) continue
      if (!Number.isFinite(metrics[name]) || metrics[name] < 0) {
        throw new Error(`Invalid ${name} in test profile: ${id}`)
      }
    }
  }
  return profiles
}

export function readProfiles(path) {
  try {
    return validateProfiles(JSON.parse(readReport(path, profileLimitBytes)))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`Cannot read test profiles: ${error.message}`, { cause: error })
  }
}

export function writeProfiles(path, profiles) {
  writeReport(path, validateProfiles(profiles), profileLimitBytes)
}

function fraction(value) {
  return Math.min(1, Math.max(0, value))
}

function readCpu(procRoot) {
  const text = readFileSync(join(procRoot, 'stat'), 'utf8')
  const fields = text.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number)
  if (!fields || fields.length < 4 || fields.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid /proc/stat CPU counters')
  }
  return {
    total: fields.slice(0, 8).reduce((total, value) => total + value, 0),
    idle: fields[3] + (fields[4] ?? 0),
    count: Math.max(1, text.match(/^cpu\d+\s/gm)?.length ?? 1),
  }
}

function readPsi(path) {
  const text = readFileSync(path, 'utf8')
  const matches = [...text.matchAll(/^(?:some|full)\s+avg10=([\d.]+)/gm)]
  if (!matches.length) throw new Error(`Invalid pressure counters: ${path}`)
  return fraction(Math.max(...matches.map(match => Number(match[1]))) / 100)
}

export function createPressureSampler({ procRoot = '/proc' } = {}) {
  let previous = readCpu(procRoot)
  return () => {
    const current = readCpu(procRoot)
    const delta = current.total - previous.total
    const cpuUtilization = delta > 0 ? fraction(1 - (current.idle - previous.idle) / delta) : 0
    previous = current
    const memory = readFileSync(join(procRoot, 'meminfo'), 'utf8')
    const total = Number(memory.match(/^MemTotal:\s+(\d+)\s+kB$/m)?.[1]) * 1024
    const available = Number(memory.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]) * 1024
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available) || available < 0) {
      throw new Error('Invalid /proc/meminfo memory counters')
    }
    return {
      cpuUtilization,
      cpuPressure: readPsi(join(procRoot, 'pressure', 'cpu')),
      memoryPressure: readPsi(join(procRoot, 'pressure', 'memory')),
      memoryUtilization: fraction(1 - available / total),
      totalMemoryBytes: total,
      availableMemoryBytes: available,
      cpuCount: current.count,
    }
  }
}

export function timeoutScale(pressure) {
  const strain = Math.max(0,
    ((pressure.cpuUtilization ?? 0) - 0.5) / 0.5,
    ((pressure.memoryUtilization ?? 0) - 0.5) / 0.3,
    (pressure.cpuPressure ?? 0) * 2,
    (pressure.memoryPressure ?? 0) * 2)
  return 1 + Math.min(2, strain)
}

function linuxProcessUnits() {
  if (!processUnits) {
    processUnits = {
      clockTicksPerSecond: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 10_000 })),
      pageSizeBytes: Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 10_000 })),
    }
  }
  return processUnits
}

function processSnapshot(procRoot) {
  const records = new Map()
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const text = readFileSync(join(procRoot, entry, 'stat'), 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
      records.set(Number(entry), {
        pid: Number(entry),
        parent: Number(fields[1]),
        group: Number(fields[2]),
        ticks: Number(fields[11]) + Number(fields[12]),
        started: fields[19],
        rssPages: Number(fields[21]),
        state: fields[0],
      })
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return records
}

function processTree(pid, procRoot) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Process tracking requires a positive PID')
  const identities = new Map()
  let rootGroup
  const sample = () => {
    const records = processSnapshot(procRoot)
    if (!rootGroup) rootGroup = records.get(pid)?.group
    const owned = new Set()
    for (const record of records.values()) {
      const known = identities.get(record.pid)
      if ((known && known.started === record.started)
        || (record.pid === pid && !identities.has(pid))
        || (rootGroup === pid && record.group === rootGroup)) owned.add(record.pid)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const record of records.values()) {
        if (!owned.has(record.pid) && owned.has(record.parent)) {
          owned.add(record.pid)
          changed = true
        }
      }
    }
    for (const ownedPid of owned) {
      const record = records.get(ownedPid)
      const previous = identities.get(ownedPid)
      identities.set(ownedPid, { ...record, ticks: Math.max(previous?.ticks ?? 0, record.ticks) })
    }
    return { records, owned }
  }
  return {
    identities,
    sample,
    processGroups(records = sample().records) {
      const groups = new Set()
      for (const [ownedPid, identity] of identities) {
        const record = records.get(ownedPid)
        if (record?.started === identity.started && record.state !== 'Z') groups.add(record.group)
      }
      return [...groups]
    },
  }
}

/** Descendant ownership does not require getconf or resource accounting. */
export function startProcessGroupTracking(pid, { procRoot = '/proc', intervalMs = 100 } = {}) {
  const tree = processTree(pid, procRoot)
  let sampleError
  tree.sample()
  const timer = setInterval(() => {
    try {
      tree.sample()
    } catch (error) {
      sampleError = error
      clearInterval(timer)
    }
  }, intervalMs)
  timer.unref()
  return {
    processGroups() {
      if (sampleError) throw sampleError
      return tree.processGroups()
    },
    stop() { clearInterval(timer) },
  }
}

// Samples can miss processes that are born and reaped between polls, and brief RSS peaks.
// Retained identities account for observed descendants after their parent exits or changes groups.
export function startProcessMetrics(pid, { procRoot = '/proc', intervalMs = 100,
  clockTicksPerSecond, pageSizeBytes } = {}) {
  const tree = processTree(pid, procRoot)
  const units = clockTicksPerSecond && pageSizeBytes
    ? { clockTicksPerSecond, pageSizeBytes }
    : linuxProcessUnits()
  const started = performance.now()
  // CPU a process had already used when tracking began is not this job's, e.g. a reused coordinator's earlier files.
  const initialTicks = new Map()
  let peakRssBytes = 0
  let sampled = false
  let result
  let sampleError
  const sample = () => {
    const { records, owned } = tree.sample()
    let rssBytes = 0
    for (const ownedPid of owned) {
      const record = records.get(ownedPid)
      if (!sampled) initialTicks.set(ownedPid, record.ticks)
      if (record.state !== 'Z') rssBytes += record.rssPages * units.pageSizeBytes
    }
    peakRssBytes = Math.max(peakRssBytes, rssBytes)
    sampled = true
    return records
  }
  sample()
  const timer = setInterval(() => {
    try {
      sample()
    } catch (error) {
      sampleError = error
      clearInterval(timer)
    }
  }, intervalMs)
  timer.unref()
  return {
    processGroups() { return tree.processGroups(sample()) },
    stop() {
      if (result) return result
      clearInterval(timer)
      if (sampleError) throw sampleError
      sample()
      result = {
        durationMs: performance.now() - started,
        peakRssBytes,
        cpuSeconds: [...tree.identities.values()].reduce((total, record) =>
          total + record.ticks - (initialTicks.get(record.pid) ?? 0), 0) / units.clockTicksPerSecond,
      }
      return result
    },
  }
}
