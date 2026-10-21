import type { CiHostStatus, CiRunRecord } from '@foreman-code/contracts'

const gib = 2 ** 30
const coresPerSlot = 6
const memoryPerSlot = 6 * gib

/** Reserve one logical CPU and 1.5 GiB per integration shard, plus 1 GiB for shared processes. */
export function gateIntegrationShards(cpuCount: number, memoryBytes: number): number {
  return Math.max(1, Math.min(64, Math.floor(cpuCount), Math.floor((memoryBytes - gib) / (1.5 * gib))))
}

export function allowedCiResources(resources: {
  cpuCount: number
  memoryBytes: number
  availableMemoryBytes: number
}, buildAllowancePercent = 100) {
  const fraction = buildAllowancePercent / 100
  const cpuCount = Math.max(1, Math.floor(resources.cpuCount * fraction))
  const memoryBytes = Math.max(1, Math.floor(resources.memoryBytes * fraction))
  return { cpuCount, memoryBytes, availableMemoryBytes: Math.min(resources.availableMemoryBytes, memoryBytes) }
}

export function buildComputerIntegrationShards(status: Pick<CiHostStatus, 'cpuCount' | 'memoryBytes' | 'buildAllowancePercent'>,
  buildAllowancePercent = 100): number {
  const allowance = status.buildAllowancePercent === undefined ? buildAllowancePercent : 100
  const resources = allowedCiResources({ ...status, availableMemoryBytes: status.memoryBytes }, allowance)
  return gateIntegrationShards(resources.cpuCount, hostCiCapacity(resources).memoryBudget)
}

export function gateDispatchShards(run: Pick<CiRunRecord, 'gate' | 'suite' | 'plannedHostKey' | 'integrationShards'>,
  computerKey: string, availableShards: number): { integrationShards?: number } {
  if (!run.gate || run.suite !== 'integration') return {}
  const integrationShards = computerKey === run.plannedHostKey
    ? Math.min(run.integrationShards!, availableShards) : availableShards
  return { integrationShards }
}

export function hostCiCapacity(resources: {
  cpuCount: number
  memoryBytes: number
  availableMemoryBytes: number
}, reservations: readonly { cpuCount: number; memoryBytes: number; memoryBudget?: number }[] = []) {
  const cpuSlots = Math.max(1, Math.floor(resources.cpuCount / coresPerSlot))
  const hostMemoryBudget = Math.max(1, Math.floor(resources.memoryBytes - Math.max(gib, resources.memoryBytes * 0.1)))
  const reservedCpu = reservations.reduce((sum, run) => sum + run.cpuCount, 0)
  const reservedMemory = reservations.reduce((sum, run) => sum + run.memoryBytes, 0)
  // Retain the measured budget while jobs run; their unconsumed quotas are already promised memory.
  const memoryBudget = Math.max(1, Math.min(hostMemoryBudget, resources.availableMemoryBytes + reservedMemory,
    ...reservations.map(run => run.memoryBudget ?? hostMemoryBudget)))
  const freeMemory = Math.max(0, Math.min(resources.availableMemoryBytes, memoryBudget - reservedMemory))
  const cpuCount = Math.max(1, Math.floor(resources.cpuCount / cpuSlots))
  const freeSlots = Math.max(0, Math.min(cpuSlots - reservations.length,
    Math.floor((resources.cpuCount - reservedCpu) / cpuCount), Math.floor(freeMemory / memoryPerSlot)))
  // Without a gibibyte for even one slot, advertise none instead of a ticket with an unusable memory limit.
  const slotsTotal = reservations.length || freeSlots || freeMemory >= gib ? Math.max(1, reservations.length + freeSlots) : 0
  const memoryBytes = slotsTotal === 0 ? 0 : Math.max(1, Math.floor(Math.min(memoryBudget / slotsTotal,
    freeMemory / Math.max(1, freeSlots))))
  return { slotsTotal, slotsUsed: reservations.length, cpuCount, memoryBytes, memoryBudget }
}
