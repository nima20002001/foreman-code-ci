import type { ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useComputerUtilizations } from '../../shared/api/computerActivity'
import { metricView, sampleClock } from '../resource-telemetry/telemetryView'
import { useMonotonicElapsed } from '../resource-telemetry/useMonotonicElapsed'
import { computerLoad } from './computerLoad'

/** Aggregate only current readings; missing computers remain visible in the reporting count. */
export function useComputerFleetReadings(computers: ComputerActivity[], fresh: boolean) {
  const queries = useComputerUtilizations(computers.map(computer => ({ target: computer.target, online: fresh && computer.online })))
  const firstReceived = queries.find(query => query.data)?.data?.receivedMonoMs
  const elapsed = useMonotonicElapsed(firstReceived)
  const now = (firstReceived ?? performance.now()) + elapsed
  return computers.map((computer, index) => {
    const received = queries[index]?.data
    const sample = fresh && computer.online && received?.result.kind === 'sample' ? received.result.sample : undefined
    const age = received ? Math.max(0, now - received.receivedMonoMs) + received.requestDurationMs : 0
    const cpu = sample?.cpu.state === 'fresh' && metricView('CPU', sample, age).status === 'fresh' ? sample.cpu.value : null
    const memory = sample?.memory.state === 'fresh' && metricView('RAM', sample, age).status === 'fresh' ? sample.memory.value : null
    const storage = sample?.storage && sampleClock(sample, age).freshRemainingMs > 0 ? sample.storage : null
    const level = computerLoad({ online: fresh ? computer.online : null,
      cpuPercent: cpu?.hostCapacityPercent ?? null,
      memoryPercent: memory?.totalBytes ? memory.bytes / memory.totalBytes * 100 : null,
      diskUsedPercent: storage?.totalBytes ? (storage.totalBytes - storage.availableBytes) / storage.totalBytes * 100 : null,
      workloads: computer.agents.length + computer.jobs.length })
    return { computer, cpu, memory, level }
  })
}
