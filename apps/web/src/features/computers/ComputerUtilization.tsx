import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerReadings } from './useComputerReadings'

export function ComputerUtilization({ target, online }: { target: DeviceProvisioningTarget; online: boolean }) {
  const readings = useComputerReadings(target, online)
  const storage = readings.storage
  return <div className="computer-utilization" aria-label="Computer utilization" aria-busy={readings.pending}>
    <UtilizationMetric label="CPU" value={readings.cpu} stale={readings.stale.cpu} reason={readings.reasons.cpu} icon={<Cpu size={13} />} />
    <UtilizationMetric label="Memory" value={readings.memory} stale={readings.stale.memory} reason={readings.reasons.memory}
      icon={<MemoryStick size={13} />} />
    <UtilizationMetric label="Disk" value={storage && readings.storageUsedPercent} stale={readings.stale.storage} reason="Unavailable"
      icon={<HardDrive size={13} />} text={storage ? `${formatStorage(storage.availableBytes)} free` : undefined}
      detail={storage ? `${formatStorage(storage.availableBytes)} free of ${formatStorage(storage.totalBytes)}` : undefined} />
  </div>
}
const GIB = 1024 ** 3
/** df-style binary sizes; short enough for the sidebar. */
function formatStorage(bytes: number) {
  return bytes >= 1024 * GIB ? `${(bytes / 1024 / GIB).toFixed(1)}T` : bytes >= 10 * GIB ? `${Math.round(bytes / GIB)}G`
    : `${(bytes / GIB).toFixed(1)}G`
}
function UtilizationMetric({ label, value, stale, reason, icon, text, detail }: {
  label: string; value: number | null; stale: boolean; reason: string; icon: React.ReactNode; text?: string | undefined; detail?: string | undefined
}) {
  const display = value === null ? '—' : text ?? `${Math.round(value)}%`
  const known = value !== null && stale ? `Last known ${detail ?? display}` : detail ?? display
  return <span className="computer-metric" data-stale={value !== null && stale || undefined} title={`${label}: ${value === null ? reason : known}`}>
    <span aria-hidden="true">{icon}</span>
    <span className="computer-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.min(100, Math.round(value))}
      aria-valuetext={value === null ? reason : known}>
      <span style={{ width: `${Math.min(100, value ?? 0)}%` }} data-high={value !== null && value >= 90 || undefined} />
    </span><span className="computer-metric-value">{display}</span>
  </span>
}
