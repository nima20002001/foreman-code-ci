import type { CloudCiActivity } from '@foreman-code/contracts/computer-activity'
import type { useComputerFleetReadings } from './useComputerFleetReadings'

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const GIB = 1024 ** 3

export function PhysicalComputeTotals({ readings }: { readings: ReturnType<typeof useComputerFleetReadings> }) {
  const cpu = readings.flatMap(reading => reading.cpu ? [reading.cpu] : [])
  const memory = readings.flatMap(reading => reading.memory?.totalBytes ? [reading.memory] : [])
  const cores = cpu.reduce((total, value) => total + value.logicalCpuCount, 0)
  const busy = cpu.reduce((total, value) => total + value.logicalCpuCount * value.hostCapacityPercent / 100, 0)
  const ram = memory.reduce((total, value) => total + (value.totalBytes ?? 0), 0) / GIB
  const used = memory.reduce((total, value) => total + value.bytes, 0) / GIB
  const reporting = readings.filter(reading => reading.cpu && reading.memory?.totalBytes).length
  return <div className="sidebar-compute-totals" aria-label="Total compute">
    <p>{cpu.length ? `${NUMBER.format(cores)} cores · ${NUMBER.format(busy)} busy · ${NUMBER.format(cores - busy)} free` : 'CPU unavailable'}</p>
    <p>{memory.length ? `${NUMBER.format(ram)} GiB · ${NUMBER.format(used)} used · ${NUMBER.format(ram - used)} free` : 'RAM unavailable'}</p>
    {reporting < readings.length && <p className="sidebar-hover-note">{reporting} of {readings.length} computers reporting</p>}
  </div>
}

export function CloudComputeTotals({ clouds, fresh }: { clouds: CloudCiActivity[]; fresh: boolean }) {
  const slots = clouds.reduce((total, cloud) => total + cloud.slots, 0)
  const available = clouds.filter(cloud => cloud.ready)
  const running = available.reduce((total, cloud) => total + cloud.running, 0)
  const capacity = available.reduce((total, cloud) => total + cloud.slots, 0)
  const unavailable = slots - capacity
  const orgs = clouds.filter(cloud => cloud.provider === 'circleci')
  const readable = orgs.filter(org => org.credits)
  const credits = readable.reduce((total, org) => total + (org.credits?.remaining ?? 0), 0)
  const partial = readable.length < orgs.length ? ` (${readable.length} of ${orgs.length} orgs)` : ''
  return <div className="sidebar-compute-totals" aria-label="Total cloud compute">
    <p>{fresh ? `${slots} slots · ${running} busy · ${Math.max(0, capacity - running)} free${unavailable ? ` · ${unavailable} unavailable` : ''}` : 'Slots unavailable'}</p>
    {orgs.length > 0 && <p>
      {readable.length ? `${fresh ? '' : 'Last known · '}≈ ${NUMBER.format(credits)} credits left${partial}` : 'Credits unavailable'}
    </p>}
  </div>
}
