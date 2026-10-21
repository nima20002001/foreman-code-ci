import { Link } from '@tanstack/react-router'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { Badge, Card, Icon, LoadingState } from '../../shared/ui/nocturne'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'

function Body({ name, labels }: { name: string; labels: React.ReactNode }) {
  return <>
    <span className="settings-card-icon"><Icon name="settings" size={16} /></span>
    <span className="settings-card-copy"><strong>{name}</strong><span className="settings-card-labels">{labels}</span></span>
    <Icon className="settings-card-chevron" name="chevron" size={16} />
  </>
}

function agentCount(count: number) { return `${count} ${count === 1 ? 'agent' : 'agents'} running` }

/** One compact card per computer: presence, role and running work. Details and changes live on the Computers page. */
export function ComputerSummaryCards() {
  const activity = useComputerActivity()
  const targets: DeviceProvisioningTarget[] = activity.data?.computers.map(computer => computer.target) ?? []
  const builds = useBuildComputers(targets)
  const fresh = useComputerActivityFreshness(activity.dataUpdatedAt, activity.fetchStatus) && !activity.isError
  if (activity.isPending) return <LoadingState label="Loading computers…" />
  if (activity.isError) return <ul className="settings-card-list" aria-label="Computers"><li><Card className="settings-card">
    <Link to="/settings/computers" className="settings-card-open"><Body name="Computers" labels={<Badge tone="warning">Status unavailable</Badge>} /></Link>
  </Card></li></ul>
  return <ul className="settings-card-list" aria-label="Computers">
    {activity.data.computers.map((computer, index) => {
      const host = computer.target.hostRef
      const ci = builds[index]?.data?.preference.buildEnabled === true
      const online = fresh && computer.online
      const labels = <>
        <Badge tone={online ? 'success' : 'neutral'} dot>{!fresh ? 'Status stale' : online ? 'Online' : 'Offline'}</Badge>
        <Badge>Agent host</Badge>
        {ci ? <Badge>CI</Badge> : null}
        {computer.agents.length ? <Badge>{agentCount(computer.agents.length)}</Badge> : null}
      </>
      return <li key={computerKey(computer.target)}><Card className="settings-card">
        {host.kind === 'main'
          ? <Link to="/settings/computers" className="settings-card-open"><Body name={computer.name} labels={labels} /></Link>
          : <Link to="/settings/computers/$deviceId" params={{ deviceId: host.deviceId }} className="settings-card-open"><Body name={computer.name} labels={labels} /></Link>}
      </Card></li>
    })}
  </ul>
}
