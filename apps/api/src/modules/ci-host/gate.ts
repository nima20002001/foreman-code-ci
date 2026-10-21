import { CI_MAX_RUN_TICKETS, exclusiveIntegrationFiles, integrationCpuCost, requiresUserSystemd, type CiDurations, type CiRunInput,
  type CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiIntegrationInventory } from './integrationParts.js'
import { planCiParts, runsOnCircleCi, type CiUnitInventory } from './parts.js'
import { buildComputerIntegrationShards } from './capacity.js'
import { executorSpeedFactor, executorSpeedKey, type ExecutorSpeeds } from './executorSpeed.js'
import { withoutReservedCloudSlots } from './cloudSlots.js'
import { CLOUD_GATE_JOB_BUDGET_MS } from './cloudJobLimits.js'

const SETUP_MS = 90_000
const exclusive = new Set(exclusiveIntegrationFiles)
const log = componentLogger('jobs')

interface GateComputer {
  computer: HostCiComputer
  shards: number
  freeSlots: number
  checkMs: number
  files: string[]
}
export interface GatePart {
  suite: CiRunRecord['suite']
  part: CiRunRecord['part']
  partition: CiRunRecord['partition']
  files: string[]
  plannedHostKey: string
  expectedDurationMs: number
  integrationShards?: number
  requiresBuildComputer?: boolean
  speedFactor?: number
}

interface IntegrationLoad {
  lanes: number[]
  serial: number
  work: number
  files: string[]
}

function emptyIntegrationLoad(shards: number): IntegrationLoad {
  return { lanes: Array.from({ length: shards }, () => 0), serial: 0, work: 0, files: [] }
}

function integrationLoadMs(load: IntegrationLoad): number {
  return load.files.length ? SETUP_MS + load.serial + Math.max(...load.lanes) : 0
}

function addIntegrationFile(load: IntegrationLoad, file: string, durationMs: number): IntegrationLoad {
  const next = { ...load, work: load.work + durationMs, files: [...load.files, file] }
  if (exclusive.has(file)) return { ...next, serial: load.serial + durationMs }
  const lanes = [...load.lanes]
  const cost = integrationCpuCost(file, lanes.length, durationMs)
  const indexes = lanes.map((_, index) => index).sort((left, right) => lanes[left]! - lanes[right]!).slice(0, cost)
  const finish = Math.max(...indexes.map(index => lanes[index]!)) + durationMs
  for (const index of indexes) lanes[index] = finish
  return { ...next, lanes }
}

export async function readCiComputerStatus(endpoint: HostCiEndpoint, computer: HostCiComputer) {
  const status = await endpoint.request(computer, { operation: 'status' }).catch(error => {
    log.warn({ err: error, computer: computer.key }, 'CI computer status unavailable')
    return null
  })
  return status?.operation === 'status' ? status : null
}

async function gateComputers(endpoint: HostCiEndpoint, reservedCloudSlots: number,
  usedByComputer: ReadonlyMap<string, number>): Promise<GateComputer[]> {
  const computers = withoutReservedCloudSlots(await endpoint.computers(), reservedCloudSlots)
  const available: (GateComputer | null)[] = []
  const unreadableClouds: string[] = []
  for (let offset = 0; offset < computers.length; offset += 8) {
    const batch = await Promise.all(computers.slice(offset, offset + 8).map(async computer => {
      const status = await readCiComputerStatus(endpoint, computer)
      if (!status && computer.hostRef.kind === 'cloud') unreadableClouds.push(computer.key)
      if (!status?.ready) return null
      const shards = buildComputerIntegrationShards(status, computer.buildAllowancePercent)
      const occupied = Math.max(status.slotsUsed ?? 0, usedByComputer.get(computer.key) ?? 0)
      // Gate dispatch reserves the whole builder, so even a partially occupied builder cannot start a gate part.
      const freeSlots = computer.hostRef.kind !== 'cloud' && occupied > 0
        ? 0 : Math.max(0, (status.slotsTotal ?? 1) - occupied)
      const available: GateComputer = { computer, shards, freeSlots, checkMs: 0, files: [] }
      return available
    }))
    available.push(...batch)
  }
  if (unreadableClouds.length) {
    throw new DomainError('CI_GATE_CAPACITY_REQUIRED',
      'Cloud CI status is temporarily unavailable. Retry gate planning after the fleet can be read.',
      409, { retryable: true, unavailableComputers: unreadableClouds.sort() })
  }
  return available.filter((value): value is GateComputer => value !== null)
}

/** Prefer one wave; GitHub slots can take integration after checks when no unused cloud slot is free.
 * Measured build throughput sizes integration parts; CPU, memory and build allowance bound execution shards.
 * Busy builders are a fallback when no free executor can take a file; not-ready computers and reserved cloud slots stay out. */
export async function planCiGate(input: CiRunInput, integration: CiIntegrationInventory,
  unit: CiUnitInventory, durations: CiDurations, endpoint: HostCiEndpoint,
  speeds: ExecutorSpeeds = new Map(), reservedCloudSlots = 0, unitSlots?: number,
  usedByComputer: ReadonlyMap<string, number> = new Map()): Promise<GatePart[]> {
  const fleet = await gateComputers(endpoint, reservedCloudSlots, usedByComputer)
  const hosts = fleet.filter(item => item.computer.hostRef.kind !== 'cloud')
  const clouds = fleet.filter(item => item.computer.hostRef.kind === 'cloud')
  // Build computers are optional: a cloud-only fleet runs the whole gate.
  if (!clouds.length || !integration.files.length) {
    throw new DomainError('CI_GATE_CAPACITY_REQUIRED', 'A gate needs cloud CI and integration files.', 409)
  }
  const availableSlots = clouds.reduce((sum, item) => sum + item.freeSlots, 0)
  const slots = Math.min(unitSlots ?? availableSlots, availableSlots)
  const checks = (['typecheck', 'lint', 'unit'] as const).flatMap(suite =>
    planCiParts({ ...input, gate: false, suite, scope: 'full' }, durations, unit, slots).map(part => ({ ...part, suite })))
  // Checks that only some providers run are placed first, so they still find an empty slot of their own.
  const placed = new Map<(typeof checks)[number], GatePart>()
  for (const part of [...checks].sort((left, right) => Number(runsOnCircleCi(left)) - Number(runsOnCircleCi(right)))) {
    const expectedDurationMs = part.expectedDurationMs ?? (part.suite === 'unit' ? 210_000 : 150_000)
    const candidates = expectedDurationMs > CLOUD_GATE_JOB_BUDGET_MS ? hosts : clouds
    const eligible = candidates.filter(item => item.computer.hostRef.provider !== 'circleci' || runsOnCircleCi(part))
    const target = [...eligible].sort((left, right) => left.checkMs - right.checkMs)[0]
    if (!target) throw new DomainError('CI_GATE_CAPACITY_REQUIRED', `No cloud executor can run ${part.part ?? part.suite}.`, 409)
    target.checkMs += expectedDurationMs
    placed.set(part, { ...part, plannedHostKey: target.computer.key, expectedDurationMs })
  }
  const result: GatePart[] = checks.map(part => placed.get(part)!)
  // A second GitHub boot includes its check backlog and the integration setup cost in the finish estimate.
  const secondWave = !clouds.some(item => item.checkMs === 0 && item.freeSlots > 0)
  const integrationFleet = [...hosts, ...clouds.filter(item => item.checkMs === 0
    || secondWave && item.computer.hostRef.provider === 'github')]
  const known = Object.values(integration.durations).sort((left, right) => left - right)
  const median = known[Math.floor(known.length / 2)] ?? 30_000
  const duration = (file: string) => integration.durations[file] ?? median
  const files = [...new Set(integration.files)].sort((left, right) => duration(right) - duration(left) || left.localeCompare(right))
  // Longest-first list scheduling over hosts and clouds with incremental shard loads: each file goes where it finishes
  // earliest (hosts win ties), so clouds only take integration that shortens the gate's critical path.
  const load = new Map<GateComputer, IntegrationLoad[]>(integrationFleet.map(item => [item, []]))
  const maxCloudParts = Math.max(0, CI_MAX_RUN_TICKETS - checks.length - hosts.length)
  let cloudPartCount = 0
  const factor = (item: GateComputer) => executorSpeedFactor(item.computer, speeds)
  const measuredTime = (item: GateComputer, work: number, nominal: number,
    estimate: 'typical' | 'conservative' = 'typical') => {
    const speed = speeds.get(executorSpeedKey(item.computer))
    if (item.computer.hostRef.kind === 'cloud' || !speed || typeof speed === 'number') {
      return factor(item) * nominal
    }
    const throughput = estimate === 'conservative' ? speed.conservativeThroughput : speed.throughput
    return Math.max(nominal, work / throughput)
  }
  const withFile = (item: GateComputer, file: string) => {
    const parts = load.get(item)!
    const last = parts.at(-1)
    const next = addIntegrationFile(last ?? emptyIntegrationLoad(item.shards), file, duration(file))
    if (last && item.computer.hostRef.kind === 'cloud'
      && factor(item) * integrationLoadMs(next) > CLOUD_GATE_JOB_BUDGET_MS) {
      return [...parts, addIntegrationFile(emptyIntegrationLoad(item.shards), file, duration(file))]
    }
    return [...parts.slice(0, -1), next]
  }
  const canRunFile = (item: GateComputer, file: string) => item.computer.hostRef.kind !== 'cloud'
    || ((!requiresUserSystemd(file) || item.computer.userSystemd?.supported)
      && factor(item) * (SETUP_MS + duration(file)) <= CLOUD_GATE_JOB_BUDGET_MS
      && cloudPartCount - load.get(item)!.length + withFile(item, file).length <= maxCloudParts)
  const finishLoads = (item: GateComputer, parts: IntegrationLoad[], estimate: 'typical' | 'conservative' = 'typical') =>
    item.checkMs + parts.reduce((sum, state) =>
      sum + measuredTime(item, state.work, integrationLoadMs(state), estimate), 0)
  const finishWith = (item: GateComputer, file: string) => finishLoads(item, withFile(item, file))
  const finish = (item: GateComputer, estimate: 'typical' | 'conservative' = 'typical') => {
    if (!item.files.length) return item.checkMs
    return finishLoads(item, load.get(item)!, estimate)
  }
  const addFile = (item: GateComputer, file: string) => {
    const next = withFile(item, file)
    if (item.computer.hostRef.kind === 'cloud') cloudPartCount += next.length - load.get(item)!.length
    load.set(item, next)
    item.files.push(file)
  }
  const exclusiveCount = (item: GateComputer) => item.files.filter(file => exclusive.has(file) || requiresUserSystemd(file)).length
  for (const file of files) {
    const serial = exclusive.has(file) || requiresUserSystemd(file)
    const eligible = integrationFleet.filter(item => canRunFile(item, file))
    const free = eligible.filter(item => item.freeSlots > 0)
    // Future cloud capacity behind checks does not exclude the existing busy-builder fallback.
    const candidates = free.some(item => item.checkMs === 0) ? free : eligible
    const target = candidates.map((item, order) => ({ item, order, finish: finishWith(item, file) }))
      .sort((left, right) => left.finish - right.finish
        || (serial ? exclusiveCount(left.item) - exclusiveCount(right.item) : 0) || left.order - right.order)[0]?.item
    if (!target) {
      throw new DomainError('CI_GATE_CAPACITY_REQUIRED', `No available gate executor can run ${file}.`, 409)
    }
    addFile(target, file)
  }
  // A recent slowdown bounds host work even if the typical estimate is optimistic.
  const integrationClouds = integrationFleet.filter(item => item.computer.hostRef.kind === 'cloud')
  // Each file can move from a builder to a cloud only once, bounding the number of improving passes.
  for (let pass = 0; pass < files.length; pass++) {
    let moved = false
    for (const host of hosts) {
      while (host.files.length && finish(host, 'conservative') > Math.max(...clouds.map(item => finish(item)))) {
        const file = [...host.files].reverse().find(file => integrationClouds.some(item => canRunFile(item, file)))
        if (!file) break
        const target = [...integrationClouds].filter(item => canRunFile(item, file))
          .sort((left, right) => finishWith(left, file) - finishWith(right, file))[0]!
        const remaining = host.files.filter(value => value !== file)
        let remainingLoad = emptyIntegrationLoad(host.shards)
        for (const remainingFile of remaining) {
          remainingLoad = addIntegrationFile(remainingLoad, remainingFile, duration(remainingFile))
        }
        const hostEnd = finishLoads(host, remaining.length ? [remainingLoad] : [], 'conservative')
        const criticalPath = Math.max(...fleet.map(item => finish(item, 'conservative')))
        const movedCriticalPath = Math.max(hostEnd, finishWith(target, file),
          ...fleet.filter(item => item !== host && item !== target).map(item => finish(item, 'conservative')))
        if (movedCriticalPath >= criticalPath) break
        host.files = remaining
        load.set(host, remaining.length ? [remainingLoad] : [])
        addFile(target, file)
        moved = true
      }
    }
    if (!moved) break
  }
  for (const item of integrationFleet.filter(item => item.files.length)) {
    const measured = typeof speeds.get(executorSpeedKey(item.computer)) === 'object'
    const appliedFactor = (item.computer.hostRef.kind === 'cloud' || !measured) && factor(item) !== 1
    for (const state of load.get(item)!) {
      result.push({ suite: 'integration', part: null, partition: null, files: state.files,
        plannedHostKey: item.computer.key, integrationShards: item.shards,
        expectedDurationMs: Math.ceil(measuredTime(item, state.work, integrationLoadMs(state), 'conservative')),
        requiresBuildComputer: state.files.some(requiresUserSystemd),
        ...(appliedFactor ? { speedFactor: factor(item) } : {}) })
    }
  }
  return result
}

/** A started gate finishes before the next admitted gate; other work backfills what the gate leaves idle. */
export function gateQueueBlock(run: CiRunRecord, gate: CiRunRecord | undefined): string | undefined {
  if (!gate || run.groupId === gate.groupId || !run.gate) return undefined
  return `Waiting behind CI gate ${gate.groupId}; this gate resumes when that gate finishes.`
}

/** Cloud slots share provider capacity; idle build computers help after their own gate part finishes. */
export function gatePartStealer(computers: readonly HostCiComputer[], queued: readonly CiRunRecord[]) {
  const cloudProviders = new Map(computers.filter(computer => computer.hostRef.kind === 'cloud')
    .map(computer => [computer.key, computer.hostRef.provider]))
  const waitingHostGates = new Set(queued.filter(run => run.gate && run.plannedHostKey && !cloudProviders.has(run.plannedHostKey))
    .map(run => run.plannedHostKey))
  return (run: CiRunRecord, computer: HostCiComputer) => {
    if (!run.gate || !run.plannedHostKey || computer.key === run.plannedHostKey) return false
    const plannedForCloud = cloudProviders.has(run.plannedHostKey)
    if (computer.hostRef.kind !== 'cloud') {
      return !waitingHostGates.has(computer.key) && (plannedForCloud || run.suite === 'integration')
    }
    return plannedForCloud
  }
}
