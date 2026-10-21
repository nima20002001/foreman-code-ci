import { exclusiveIntegrationFiles, integrationCpuCost, requiresUserSystemd, type CiDurations, type CiRunInput,
  type CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiIntegrationInventory } from './integrationParts.js'
import { planCiParts, runsOnCircleCi, type CiUnitInventory } from './parts.js'
import { buildComputerIntegrationShards } from './capacity.js'
import { executorSpeedKey, type ExecutorSpeeds } from './executorSpeed.js'
import { withoutReservedCloudSlots } from './cloudSlots.js'

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
}

function addIntegrationFile(load: IntegrationLoad, file: string, durationMs: number): IntegrationLoad {
  if (exclusive.has(file)) return { lanes: load.lanes, serial: load.serial + durationMs }
  const lanes = [...load.lanes]
  const cost = integrationCpuCost(file, lanes.length, durationMs)
  const indexes = lanes.map((_, index) => index).sort((left, right) => lanes[left]! - lanes[right]!).slice(0, cost)
  const finish = Math.max(...indexes.map(index => lanes[index]!)) + durationMs
  for (const index of indexes) lanes[index] = finish
  return { lanes, serial: load.serial }
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
  const available = await Promise.all(computers.map(async computer => {
    const status = await readCiComputerStatus(endpoint, computer)
    if (!status?.ready) return null
    const shards = buildComputerIntegrationShards(status, computer.buildAllowancePercent)
    const occupied = Math.max(status.slotsUsed ?? 0, usedByComputer.get(computer.key) ?? 0)
    // Gate dispatch reserves the whole builder, so even a partially occupied builder cannot start a gate part.
    const freeSlots = computer.hostRef.kind !== 'cloud' && occupied > 0
      ? 0 : Math.max(0, (status.slotsTotal ?? 1) - occupied)
    const available: GateComputer = { computer, shards, freeSlots, checkMs: 0, files: [] }
    return available
  }))
  return available.filter((value): value is GateComputer => value !== null)
}

/** One wave: every ready executor takes at most one part. Measured build throughput sizes integration parts;
 * CPU, memory and build allowance bound execution shards. Cloud slots take one check or integration part each.
 * Busy builders are a fallback when no free executor can take a file; not-ready computers and reserved cloud slots stay out. */
export async function planCiGate(input: CiRunInput, integration: CiIntegrationInventory,
  unit: CiUnitInventory, durations: CiDurations, endpoint: HostCiEndpoint,
  speeds: ExecutorSpeeds = new Map(), reservedCloudSlots = 0, unitSlots?: number,
  usedByComputer: ReadonlyMap<string, number> = new Map()): Promise<GatePart[]> {
  const fleet = await gateComputers(endpoint, reservedCloudSlots, usedByComputer)
  const hosts = fleet.filter(item => item.computer.hostRef.kind !== 'cloud')
  const clouds = fleet.filter(item => item.computer.hostRef.kind === 'cloud')
  if (!fleet.some(item => item.computer.hostRef.kind !== 'cloud') || !clouds.length || !integration.files.length) {
    throw new DomainError('CI_GATE_CAPACITY_REQUIRED', 'A gate needs a ready build computer, cloud CI, and integration files.', 409)
  }
  const availableSlots = clouds.reduce((sum, item) => sum + item.freeSlots, 0)
  const slots = Math.min(unitSlots ?? availableSlots, availableSlots)
  const checks = (['typecheck', 'lint', 'unit'] as const).flatMap(suite =>
    planCiParts({ ...input, gate: false, suite, scope: 'full' }, durations, unit, slots).map(part => ({ ...part, suite })))
  // Checks that only some providers run are placed first, so they still find an empty slot of their own.
  const placed = new Map<(typeof checks)[number], GatePart>()
  for (const part of [...checks].sort((left, right) => Number(runsOnCircleCi(left)) - Number(runsOnCircleCi(right)))) {
    const eligible = clouds.filter(item => item.computer.hostRef.provider !== 'circleci' || runsOnCircleCi(part))
    const target = [...eligible].sort((left, right) => left.checkMs - right.checkMs)[0]
    if (!target) throw new DomainError('CI_GATE_CAPACITY_REQUIRED', `No cloud executor can run ${part.part ?? part.suite}.`, 409)
    const expectedDurationMs = part.expectedDurationMs ?? (part.suite === 'unit' ? 210_000 : 150_000)
    target.checkMs += expectedDurationMs
    placed.set(part, { ...part, plannedHostKey: target.computer.key, expectedDurationMs })
  }
  const result: GatePart[] = checks.map(part => placed.get(part)!)
  // A cloud slot runs one ticket per boot, so a second part on a slot waits for a new boot. Integration therefore goes
  // only to build computers and cloud slots without a check: every executor gets at most one part.
  const integrationFleet = [...hosts, ...clouds.filter(item => item.checkMs === 0)]
  const known = Object.values(integration.durations).sort((left, right) => left - right)
  const median = known[Math.floor(known.length / 2)] ?? 30_000
  const duration = (file: string) => integration.durations[file] ?? median
  const files = [...new Set(integration.files)].sort((left, right) => duration(right) - duration(left) || left.localeCompare(right))
  // Longest-first list scheduling over hosts and clouds with incremental shard loads: each file goes where it finishes
  // earliest (hosts win ties), so clouds only take integration that shortens the gate's critical path.
  const load = new Map(integrationFleet.map(item => [item,
    { lanes: Array.from({ length: item.shards }, () => 0), serial: 0, work: 0 }]))
  const factor = (item: GateComputer) => {
    const speed = speeds.get(executorSpeedKey(item.computer))
    return typeof speed === 'number' ? speed : speed?.factor ?? 1
  }
  const measuredTime = (item: GateComputer, work: number, nominal: number,
    estimate: 'typical' | 'conservative' = 'typical') => {
    const speed = speeds.get(executorSpeedKey(item.computer))
    if (item.computer.hostRef.kind === 'cloud' || !speed || typeof speed === 'number') {
      return factor(item) * nominal
    }
    const throughput = estimate === 'conservative' ? speed.conservativeThroughput : speed.throughput
    return Math.max(nominal, work / throughput)
  }
  const finishWith = (item: GateComputer, file: string) => {
    const state = load.get(item)!
    const next = addIntegrationFile(state, file, duration(file))
    return item.checkMs + measuredTime(item, state.work + duration(file), SETUP_MS + next.serial + Math.max(...next.lanes))
  }
  const finish = (item: GateComputer, estimate: 'typical' | 'conservative' = 'typical') => {
    if (!item.files.length) return item.checkMs
    const state = load.get(item)!
    return item.checkMs + measuredTime(item, state.work,
      SETUP_MS + state.serial + Math.max(...state.lanes), estimate)
  }
  const addFile = (item: GateComputer, file: string) => {
    const state = load.get(item)!
    load.set(item, { ...addIntegrationFile(state, file, duration(file)), work: state.work + duration(file) })
    item.files.push(file)
  }
  const exclusiveCount = (item: GateComputer) => item.files.filter(file => exclusive.has(file) || requiresUserSystemd(file)).length
  for (const file of files) {
    const serial = exclusive.has(file) || requiresUserSystemd(file)
    const eligible = integrationFleet.filter(item => item.computer.hostRef.kind !== 'cloud'
      || !requiresUserSystemd(file) || item.computer.userSystemd?.supported)
    const free = eligible.filter(item => item.freeSlots > 0)
    const candidates = free.length ? free : eligible
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
  for (const host of hosts) {
    while (host.files.length && finish(host, 'conservative') > Math.max(...clouds.map(item => finish(item)))) {
      const file = [...host.files].reverse().find(file => integrationClouds.some(item =>
        !requiresUserSystemd(file) || item.computer.userSystemd?.supported))
      if (!file) break
      const target = [...integrationClouds].filter(item =>
        !requiresUserSystemd(file) || item.computer.userSystemd?.supported)
        .sort((left, right) => finishWith(left, file) - finishWith(right, file))[0]!
      const remaining = host.files.filter(value => value !== file)
      host.files = []
      load.set(host, { lanes: Array.from({ length: host.shards }, () => 0), serial: 0, work: 0 })
      for (const remainingFile of remaining) addFile(host, remainingFile)
      addFile(target, file)
    }
  }
  for (const item of integrationFleet.filter(item => item.files.length)) {
    const measured = typeof speeds.get(executorSpeedKey(item.computer)) === 'object'
    const appliedFactor = (item.computer.hostRef.kind === 'cloud' || !measured) && factor(item) !== 1
    result.push({ suite: 'integration', part: null, partition: null, files: item.files,
      plannedHostKey: item.computer.key, integrationShards: item.shards,
      expectedDurationMs: Math.ceil(finish(item, 'conservative')),
      requiresBuildComputer: item.files.some(requiresUserSystemd),
      ...(appliedFactor ? { speedFactor: factor(item) } : {}) })
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
