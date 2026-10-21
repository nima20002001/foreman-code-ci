import { useMemo, type ReactNode } from 'react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { Cloud, Laptop, Monitor } from 'lucide-react'
import type { CloudCiActivity, ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { DEFAULT_CIRCLE_ACCOUNT_ID } from '@foreman-code/contracts/management'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerMaintenance } from '../../shared/api/computerMaintenance'
import { useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { SidebarHoverCardHeader as CardHeader } from '../../shared/ui/SidebarHoverCardHeader'
import { useSidebarHoverCard } from '../../shared/ui/useSidebarHoverCard'
import { Badge } from '../../shared/ui/nocturne'
import { presentationFor } from '../settings/computerPresenceModel'
import { ComputerUtilization } from './ComputerUtilization'
import { computerLoad, LOAD_LABELS, type ComputerLoadLevel } from './computerLoad'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import { useComputerReadings } from './useComputerReadings'
import { useComputerFleetReadings } from './useComputerFleetReadings'
import { SidebarComputeGroup } from './SidebarComputeGroup'
import { CloudComputeTotals, PhysicalComputeTotals } from './SidebarComputeTotals'
import './computers.css'

/** Two fleet icons open lists; each computer keeps its existing detail card one level deeper. */
export function SidebarComputers() {
  const query = useComputerActivity()
  // A failed refresh keeps the last list; without a fresh observation nothing is presented as current.
  const fresh = useComputerActivityFreshness(query.dataUpdatedAt, query.fetchStatus) && !query.isError
  const computers = query.data?.computers ?? []
  const clouds = query.data?.cloud ?? []
  if (computers.length + clouds.length === 0) return null
  const complete = query.data?.activityComplete === true && !query.data.truncated
  return <ul className="sidebar-computers" aria-label="Computers">
    {computers.length > 0 && <PhysicalComputers computers={computers} fresh={fresh} complete={complete} />}
    {clouds.length > 0 && <CloudComputers clouds={clouds} fresh={fresh} />}
  </ul>
}

function fleetLoad(levels: ComputerLoadLevel[]): ComputerLoadLevel {
  const order: ComputerLoadLevel[] = ['offline', 'unknown', 'calm', 'busy', 'heavy', 'saturated']
  return levels.reduce((highest, level) => order.indexOf(level) > order.indexOf(highest) ? level : highest, 'offline')
}

function PhysicalComputers({ computers, fresh, complete }: {
  computers: ComputerActivity[]; fresh: boolean; complete: boolean
}) {
  const readings = useComputerFleetReadings(computers, fresh)
  const active = computers.filter(computer => fresh && computer.online)
  const runningCount = active.reduce((count, computer) => count + computer.agents.length + computer.jobs.length, 0)
  const activityIds = useMemo(() => computers.filter(computer => fresh && computer.online).flatMap(computer => [
    ...computer.agents.map(agent => `${computerKey(computer.target)}:agent:${agent.id}`),
    ...computer.jobs.map(job => `${computerKey(computer.target)}:job:${job.id}`),
  ]), [computers, fresh])
  return <SidebarComputeGroup name="Computers" icon={<Monitor size={16} />} level={fleetLoad(readings.map(reading => reading.level))}
    runningCount={runningCount} activityIds={activityIds}>
    <PhysicalComputeTotals readings={readings} />
    <ul className="sidebar-compute-list" aria-label="Physical computers">
      {computers.map(computer => <ComputerRow key={computerKey(computer.target)} computer={computer} fresh={fresh} complete={complete} />)}
    </ul>
  </SidebarComputeGroup>
}

function cloudLoad(cloud: CloudCiActivity, fresh: boolean) {
  return computerLoad({ online: fresh ? cloud.ready : null, cpuPercent: null, memoryPercent: null, diskUsedPercent: null,
    ciSlotsPercent: cloud.running / cloud.slots * 100, workloads: 0 })
}

function CloudComputers({ clouds, fresh }: { clouds: CloudCiActivity[]; fresh: boolean }) {
  const runningCount = clouds.reduce((count, cloud) => count + (fresh && cloud.ready ? cloud.running : 0), 0)
  // Totals use readiness for available capacity; roles also limit new starts without changing account health.
  const capacity = clouds.map(cloud => ({ ...cloud, ready: cloud.ready && acceptsNewWork(cloud) }))
  const draining = clouds.filter(cloud => !acceptsNewWork(cloud)).reduce((count, cloud) => count + cloud.running, 0)
  return <SidebarComputeGroup name="Cloud CI" icon={<Cloud size={16} />} level={fleetLoad(clouds.map(cloud => cloudLoad(cloud, fresh)))}
    runningCount={runningCount}>
    <CloudComputeTotals clouds={capacity} fresh={fresh} />
    {fresh && draining > 0 && <p className="sidebar-hover-note">
      {draining} {draining === 1 ? 'job' : 'jobs'} draining on standby or exhausted orgs.
    </p>}
    <ul className="sidebar-compute-list" aria-label="Cloud runner groups">
      {clouds.map(cloud => <CloudRow
        key={`${cloud.provider}~${cloud.circleAccountId ?? DEFAULT_CIRCLE_ACCOUNT_ID}@${cloud.account?.toLowerCase() ?? ''}`}
        cloud={cloud} fresh={fresh} />)}
    </ul>
  </SidebarComputeGroup>
}

function acceptsNewWork(cloud: CloudCiActivity) {
  return cloud.schedulingRole === undefined || cloud.schedulingRole === 'active'
}

function ComputerRow({ computer, fresh, complete }: { computer: ComputerActivity; fresh: boolean; complete: boolean }) {
  const online = fresh && computer.online
  const readings = useComputerReadings(computer.target, online)
  const workloads = computer.agents.length + computer.jobs.length
  const level = computerLoad({ online: fresh ? computer.online : null, cpuPercent: readings.cpu, memoryPercent: readings.memory,
    diskUsedPercent: readings.storageUsedPercent, workloads })
  const main = computer.target.hostRef.kind === 'main'
  const hostRef = computer.target.hostRef
  return <HoverRow level={level} label={`${computer.name}, ${main ? 'Main' : 'Worker'}, ${LOAD_LABELS[level]}`}
    runningCount={online ? workloads : 0} name={computer.name}
    link={hostRef.kind === 'device' ? { to: '/settings/computers/$deviceId', params: { deviceId: hostRef.deviceId } } : { to: '/settings/computers' }}
    card={<ComputerDetails computer={computer} online={online} fresh={fresh} complete={complete} level={level} />} />
}

function CloudRow({ cloud, fresh }: { cloud: CloudCiActivity; fresh: boolean }) {
  const level = cloudLoad(cloud, fresh)
  let state = LOAD_LABELS.unknown
  if (fresh) {
    state = cloud.ready ? `${cloud.running} of ${cloud.slots} CI machines in use` : 'Not logged in on Main'
  }
  const role = fresh && cloud.provider === 'circleci' && cloud.schedulingRole
    ? CIRCLE_ROLE_LABELS[cloud.schedulingRole] : undefined
  const health = !fresh || cloud.ready ? LOAD_LABELS[level] : state
  return <HoverRow level={level} label={`${cloud.name}, Cloud CI, ${role ? `${role}, ` : ''}${health}`}
    runningCount={fresh && cloud.ready ? cloud.running : 0}
    name={cloud.name} status={role}
    link={{ to: '/settings/computers' }}
    card={<div className="sidebar-hover-body">
      <CardHeader icon={<Cloud size={16} />} name={cloud.name} role="Cloud CI" />
      {role && <Badge>{role}</Badge>}
      <p className="sidebar-hover-state" data-load={level}>{state}</p>
      {fresh && cloud.schedulingReason && <p className="sidebar-hover-note">{cloud.schedulingReason}</p>}
      <CircleCredits cloud={cloud} />
    </div>} />
}

const NUMBER = new Intl.NumberFormat('en-US')
const CIRCLE_ROLE_LABELS: Record<NonNullable<CloudCiActivity['schedulingRole']>, string> = {
  active: 'Active',
  standby: 'Standby',
  exhausted: 'Out of credits',
}

/** CircleCI has no plan-balance API: the credits are the configured allowance minus this month's usage, so an estimate. One row is one CircleCI org. */
function CircleCredits({ cloud }: { cloud: CloudCiActivity }) {
  if (cloud.provider !== 'circleci' || cloud.credits === undefined && cloud.creditsUnavailable === undefined) return null
  const { credits } = cloud
  if (!credits) return <p className="sidebar-hover-note">
    Credits unavailable{cloud.creditsUnavailable ? ` (${cloud.creditsUnavailable})` : ''}
  </p>
  return <p className="sidebar-hover-note">
    ≈ {NUMBER.format(credits.remaining)} of {NUMBER.format(credits.total)} credits left · updated {ago(Date.parse(credits.asOf))}
  </p>
}

type RowLink = { to: '/settings/computers' } | { to: '/settings/computers/$deviceId'; params: { deviceId: string } }

function HoverRow({ level, label, name, status, link, card, runningCount }: {
  level: ComputerLoadLevel; label: string; name: string; link: RowLink; card: ReactNode; runningCount: number
  status?: string | undefined
}) {
  const hover = useSidebarHoverCard()
  const countLabel = `${runningCount} running ${runningCount === 1 ? 'Agent or CI job' : 'Agents and CI jobs'}`
  return <li data-load={level}>
    <SidebarNavigationButton {...hover.anchorProps} {...link} className="sidebar-compute-row"
      aria-label={runningCount > 0 ? `${label}, ${countLabel}` : label}>
      <span className="sidebar-compute-status" aria-hidden="true" />
      <span className="sidebar-compute-name">{name}</span>
      {status && <Badge>{status}</Badge>}
      {runningCount > 0 && <span className="sidebar-compute-running" aria-hidden="true">{runningCount > 9 ? '9+' : runningCount}</span>}
    </SidebarNavigationButton>
    {hover.card(card)}
  </li>
}

const SHOWN_ITEMS = 3

function ago(at: number) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  return seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
    : seconds < 86_400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86_400)} d ago`
}

/** Mounted only while the card is open, so versions and last-seen are read on demand. */
function ComputerDetails({ computer, online, fresh, complete, level }: {
  computer: ComputerActivity; online: boolean; fresh: boolean; complete: boolean; level: ComputerLoadLevel
}) {
  const target = computer.target
  const device = target.hostRef.kind === 'device'
  const maintenance = useComputerMaintenance([target])[0]?.data?.status
  const registry = useHostHarnessRegistryQuery(device ? target.hostRef : undefined, target.applicationInstallationId)
  const presence = device ? presentationFor(target.hostRef, target.applicationInstallationId, registry.data?.hostMetadata) : undefined
  const connection = presence?.kind === 'observed' ? presence.connection : undefined
  const appVersion = maintenance?.worker?.currentVersion ?? connection?.appVersion
  const harness = (tool: 'codex' | 'claude') => {
    const entry = maintenance?.harnesses.find(value => value.harness === tool)
    return entry ? entry.installed ? entry.version ?? 'Installed' : 'Not installed' : undefined
  }
  const versions = [['App', appVersion], ['Codex', harness('codex')], ['Claude', harness('claude')]] as const
  const state = !fresh ? LOAD_LABELS.unknown : online ? `Online · ${LOAD_LABELS[level]}` : 'Offline'
  return <div className="sidebar-hover-body">
    <CardHeader icon={device ? <Laptop size={16} /> : <Monitor size={16} />} name={computer.name} role={device ? 'Worker' : 'Main'} />
    <p className="sidebar-hover-state" data-load={level}>{state}
      {connection && <span> · last seen {ago(Date.parse(connection.lastSeenAt))}</span>}</p>
    {online && <ComputerUtilization target={target} online />}
    <ActivityList label="Agents" items={computer.agents.map(agent => `${agent.agentName} · ${agent.workflowName}`)} />
    <ActivityList label="CI jobs" items={computer.jobs.map(job => `${job.name} · ${job.workspaceName}`)} />
    {!complete && <p className="sidebar-hover-note">Showing activity you can read.</p>}
    {versions.some(([, value]) => value) && <dl className="computer-hover-versions">
      {versions.filter(([, value]) => value).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>}
  </div>
}

function ActivityList({ label, items }: { label: string; items: string[] }) {
  return <section className="computer-hover-activity" aria-label={label}>
    <h4>{label} <span>{items.length ? items.length : 'None running'}</span></h4>
    {items.length > 0 && <ul>
      {items.slice(0, SHOWN_ITEMS).map((item, index) => <li key={index}>{item}</li>)}
      {items.length > SHOWN_ITEMS && <li>and {items.length - SHOWN_ITEMS} more</li>}
    </ul>}
  </section>
}
