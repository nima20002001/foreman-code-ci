import type { ReadObservation } from '@foreman-code/contracts'
import { useEffect, useState } from 'react'
import { ChevronRight, Monitor } from 'lucide-react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { computerDisplayName, type ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerMaintenance, useStartMaintenance } from '../../shared/api/computerMaintenance'
import type { ComputerConnections, ComputerMaintenanceStartInput, MaintenanceStatus, MaintenanceTask, WorkerBundleReadiness, WorkerReleasePublication } from '@foreman-code/contracts/computer-maintenance'
import { Badge, Button, IconButton, Tooltip } from '../../shared/ui/nocturne'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { askOperator } from '../operator-chat/operatorChatStore'
import { MainRuntimeSetup } from '../runtime-qualification/MainRuntimeSetup'
import { ComputerName } from './ComputerName'
import { ComputerUtilization } from './ComputerUtilization'
import { ComputerStatusChips } from './ComputerStatusChips'
import { deriveStatusChips, workerBehind } from './statusChips'
import { humanizeMaintenanceText, newestTaskPerKind, taskLabel } from './maintenanceText'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import './computerCards.css'

type Card = { target: DeviceProvisioningTarget; build: BuildComputerStatus | undefined; buildError: boolean }

/** One summary card per computer. Changes go through the Operator agent; the cards update from readback. */
export function ComputerCards({ mainId, devices, onSelectComputer, only }: {
  mainId: string; devices: DeviceRegistration[]; onSelectComputer?: ((deviceId: string) => void) | undefined
  /** Show just this paired device (its details page). */
  only?: string
}) {
  const targets: DeviceProvisioningTarget[] = [{ hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, ...devices.filter(device => device.status === 'paired').map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId },
    applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
    authorizationRevision: device.authorizationRevision,
  }))]
  const reads = useBuildComputers(targets)
  const visibleTargets = targets.filter(target => !only || target.hostRef.kind === 'device' && target.hostRef.deviceId === only)
  const activity = useComputerActivity()
  const maintenance = useComputerMaintenance(visibleTargets)
  const start = useStartMaintenance()
  const observedFresh = useComputerActivityFreshness(activity.dataUpdatedAt, activity.fetchStatus)
  const fresh = observedFresh && !activity.isError
  const cards: Card[] = targets.map((target, index) => ({ target, build: reads[index]!.data, buildError: reads[index]!.isError }))
    // The order builds use: enabled computers from the highest priority down.
    .sort((a, b) => Number(!a.build?.preference.buildEnabled) - Number(!b.build?.preference.buildEnabled)
      || (b.build?.preference.buildPriority ?? 0) - (a.build?.preference.buildPriority ?? 0)
      || computerKey(a.target).localeCompare(computerKey(b.target)))
  const builders = cards.filter(card => card.build?.preference.buildEnabled)
  const ranksKnown = reads.every(read => read.isSuccess)
  return <>
    <UnsavedEditorGuard editor={{ label: 'computer maintenance request', dirty: start.unresolved,
      busy: start.isPending, uncertain: start.unresolved, save: start.reconcile,
      discard: () => { if (!start.unresolved) start.reset() }, error: start.error?.message }} />
    {only ? null : <div className="computer-fleet-actions" role="group" aria-label="All computers">
      <Button size="sm" disabled={start.isPending || start.unresolved} onClick={() => {
        start.mutate([{ task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } },
          { task: { kind: 'update-system' } }])
      }}>Update computers</Button>
      <Button size="sm" variant="ghost" disabled={start.isPending || start.unresolved} onClick={() => {
        start.mutate([{ task: { kind: 'sync-mcp' } }, { task: { kind: 'sync-plugins' } }])
      }}>Sync MCP servers and plugins</Button>
    </div>}
    {start.unresolved ? <Button size="sm" disabled={start.isPending} onClick={start.retryOriginal}>
      {start.isPending ? 'Reconciling…' : 'Retry original maintenance request'}
    </Button> : null}
    {start.isError ? <small role="alert">{start.error.message}</small> : null}
    {start.data?.flatMap(result => result.computers).filter(computer => computer.error).map((computer, index) =>
      <small role="alert" key={`${computerKey(computer.target)}:${index}`}>
        {activity.data?.computers.find(known => computerKey(known.target) === computerKey(computer.target))?.name
          ?? computerDisplayName(computer.target.hostRef)}: {computer.error}
      </small>)}
    <ul className="computer-card-grid" aria-label="Computers">
      {cards.filter(card => visibleTargets.includes(card.target)).map(card => {
        const index = visibleTargets.indexOf(card.target)
        const maintenanceRead = maintenance[index]!
        const observed = activity.data?.mainId === mainId
          ? activity.data.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target)) : undefined
        return <li key={computerKey(card.target)}>
          <ComputerCard card={card} observed={observed} fresh={fresh}
            activityComplete={activity.data?.activityComplete === true && !activity.data.truncated}
            connections={maintenanceRead.data?.connections} maintenance={maintenanceRead.data?.status}
            workerPublication={maintenanceRead.data?.workerPublication}
            workerReadiness={maintenanceRead.data?.workerReadiness}
            maintenanceObservation={maintenanceRead.data?.observation}
            maintenanceError={maintenanceRead.isError || maintenanceRead.data?.observation?.status === 'unavailable'}
            onRetryMaintenance={() => { void maintenanceRead.refetch() }}
            onMaintain={tasks => start.mutate(tasks.map(task => ({ task, targets: [card.target] })))}
            starting={start.isPending && [start.variables ?? []].flat().some(input => !input.targets || input.targets.some(target => sameDeviceProvisioningTarget(target, card.target)))}
            maintaining={start.isPending || start.unresolved}
            buildPosition={ranksKnown ? builders.indexOf(card) + 1 : undefined} buildCount={builders.length}
            onOpen={card.target.hostRef.kind === 'device' && onSelectComputer
              ? () => { if (card.target.hostRef.kind === 'device') onSelectComputer(card.target.hostRef.deviceId) } : undefined} />
        </li>
      })}
      {devices.filter(device => device.status !== 'paired' && (!only || device.deviceId === only)).map(device => <li key={device.deviceId}>
        <article className="computer-card computer-card--registration" aria-label={computerDisplayName({ kind: 'device', deviceId: device.deviceId })}>
          <header className="computer-card-header"><Monitor size={20} aria-hidden="true" />
            <h3>{computerDisplayName({ kind: 'device', deviceId: device.deviceId })}</h3>
            <Badge tone={device.status === 'pending' ? 'warning' : 'neutral'}>{device.status === 'pending' ? 'Pairing pending' : 'Access revoked'}</Badge>
          </header>
          {onSelectComputer ? <Button size="sm" variant="ghost" onClick={() => onSelectComputer(device.deviceId)}>Open</Button> : null}
        </article>
      </li>)}
    </ul>
    {only ? null : <MainRuntimeSetup />}
  </>
}

type Task = ComputerMaintenanceStartInput['task']
function ComputerCard({ card, observed, fresh, activityComplete, connections, maintenance, workerPublication, workerReadiness, maintenanceObservation, maintenanceError,
  onRetryMaintenance, onMaintain, starting, maintaining, buildPosition, buildCount, onOpen }: {
  card: Card; observed: ComputerActivity | undefined; fresh: boolean; connections: ComputerConnections | undefined
  activityComplete: boolean; maintenanceError: boolean; onRetryMaintenance(): void
  maintenance: MaintenanceStatus | null | undefined; onMaintain(tasks: Task[]): void; starting: boolean; maintaining: boolean
  workerPublication: WorkerReleasePublication | undefined
  workerReadiness: WorkerBundleReadiness | undefined
  maintenanceObservation: ReadObservation | undefined
  buildPosition: number | undefined; buildCount: number; onOpen: (() => void) | undefined
}) {
  const name = observed?.name ?? computerDisplayName(card.target.hostRef)
  const tasks = newestTaskPerKind(maintenance?.tasks ?? [])
  const online = fresh && observed?.online === true
  const workflows = new Set(observed?.agents.map(agent => agent.workflowId) ?? []).size
  const chips = deriveStatusChips({ accounts: connections?.accounts, connections, status: maintenance,
    readiness: workerReadiness, starting })
  const publicationBlocked = Boolean(workerPublication && workerPublication.state !== 'published')
  const updateTasks = pendingUpdates(card.target, maintenance, workerReadiness, publicationBlocked)
  const updateState = chips.find(chip => chip.id === 'update')!.state
  return <article className="computer-card" aria-label={name}>
    <header className="computer-card-header">
      <Monitor size={20} aria-hidden="true" />
      <ComputerName name={name} target={card.target} />
      <Badge tone={online ? 'success' : 'neutral'} dot>{presenceLabel(observed, fresh)}</Badge>
      <Badge>Agent host</Badge>
      {card.build?.preference.buildEnabled ? <Badge>CI</Badge> : null}
      {onOpen ? <IconButton label={`Open ${name}`} variant="ghost" size="sm" onClick={onOpen}><ChevronRight size={16} /></IconButton> : null}
    </header>
    <ComputerStatusChips chips={chips} computer={name}
      onSignIn={tool => askOperator(tool === 'GitHub' ? `Sign GitHub in on ${name} and set up git to use it.` : `Sign ${tool} in on ${name}.`)} />
    <ComputerUtilization target={card.target} online={online} />
    <dl className="computer-card-facts">
      {card.target.hostRef.kind === 'device' ? <div><dt>Worker</dt><dd>
        <WorkerState worker={maintenance?.worker} readiness={workerReadiness} />
      </dd></div> : null}
      {publicationBlocked ? <div><dt>Worker release</dt><dd>
        <p role={workerPublication!.state === 'failed' ? 'alert' : 'status'}>
          Worker {workerPublication!.version} {workerPublication!.state === 'failed'
            ? 'publication failed' : 'is waiting for GitHub publication and verification'}.
          {workerPublication!.lastError ? <small>{workerPublication!.lastError}</small> : null}
        </p>
      </dd></div> : null}
      <div><dt>Builds</dt><dd>{buildSummary(card, buildPosition, buildCount)}
        {card.build?.state === 'setup-required' ? <Badge tone="warning">Setup needed</Badge> : null}</dd></div>
      <div><dt>Activity</dt><dd>{observed ? <>
        {!fresh ? 'Last observed: ' : null}{!activityComplete ? 'Visible activity: ' : null}
        {`${count(observed.agents.length, 'agent')} running · ${count(workflows, 'workflow')}`}
        {observed.jobs.length ? ` · ${count(observed.jobs.length, 'job')}` : ''}
        {!activityComplete ? <small>Other activity may not be visible.</small> : null}
      </> : 'Activity unknown'}</dd></div>
      {card.target.hostRef.kind === 'main' && card.build ? <div><dt>Worker execution</dt><dd>
        {card.build.remoteExecutionEnabled ? 'On' : 'Off'}</dd></div> : null}
      <div><dt>Disk</dt><dd>{maintenance?.system.disk ? `${bytes(maintenance.system.disk.freeBytes)} free of ${bytes(maintenance.system.disk.totalBytes)}` : '—'}</dd></div>
    </dl>
    {maintenanceError ? <div role="alert" className="computer-card-note">
      <p>Maintenance could not be refreshed.{maintenance ? <> Showing last confirmed details from <time dateTime={maintenance.observedAt}>{maintenance.observedAt}</time>. Current task state is unknown.</> : null}</p>
      {maintenanceObservation?.status === 'unavailable' ? <p>
        {maintenanceObservation.lastError} {maintenanceObservation.consecutiveFailures} consecutive failed reads.
        {maintenanceObservation.lastSuccess ? <> Last successful read: <time dateTime={maintenanceObservation.lastSuccess}>
          {maintenanceObservation.lastSuccess}</time>.</> : null}
      </p> : null}
      <Button size="sm" variant="ghost" onClick={onRetryMaintenance}>Retry maintenance</Button>
    </div> : null}
    {tasks.map(task => <TaskLine key={task.id} task={task} stale={maintenanceError} />)}
    <footer className="computer-card-footer">
      {maintenance?.system.rebootRequired ? <Badge tone="warning">Restart needed</Badge> : null}
      <RestartButton status={maintenance} busy={maintaining || maintenanceError} onRestart={() => onMaintain([{ kind: 'restart' }])}
        agents={observed?.agents.length ?? 0} jobs={observed?.jobs.length ?? 0} activityComplete={Boolean(observed) && fresh && activityComplete} />
      <Button size="sm" variant="ghost" onClick={() => askOperator(`On ${name}: `, { send: false })}>Ask Operator to change…</Button>
      <Button size="sm" disabled={maintaining || maintenanceError || !maintenance || updateState === 'running' || updateTasks.length === 0}
        title={updateTasks.length === 0 && maintenance ? 'Nothing to update' : undefined}
        onClick={() => onMaintain(updateTasks)}>Update</Button>
    </footer>
  </article>
}

/** What one Update click runs: only the parts that need it, plus any part whose last attempt failed. */
function pendingUpdates(target: DeviceProvisioningTarget, status: MaintenanceStatus | null | undefined,
  readiness: WorkerBundleReadiness | undefined, publicationBlocked: boolean): Task[] {
  if (!status) return []
  const failed = new Set(newestTaskPerKind(status.tasks).filter(task => task.state === 'failed').map(task => task.kind))
  const harnesses = status.harnesses.filter(entry => !entry.installed
    || Boolean(entry.latest && entry.version !== entry.latest)).map(entry => entry.harness)
  const tasks: Task[] = []
  if (harnesses.length || failed.has('update-harnesses')) {
    tasks.push({ kind: 'update-harnesses', harnesses: harnesses.length ? harnesses : ['codex', 'claude'] })
  }
  if (status.system.sudo && ((status.system.packageUpdates ?? 0) > 0 || failed.has('update-system'))) tasks.push({ kind: 'update-system' })
  const workerUpdateNeeded = workerBehind(status, readiness) || failed.has('update-worker')
  if (target.hostRef.kind === 'device' && !publicationBlocked && workerUpdateNeeded) tasks.push({ kind: 'update-worker' })
  return tasks
}

/** One line per task kind. Codes such as EDQUOT read as plain words; the raw text is in the tooltip. */
function TaskLine({ task, stale }: { task: MaintenanceTask; stale: boolean }) {
  const { text, raw } = humanizeMaintenanceText(task.summary)
  const body = task.state === 'running' ? `${taskLabel(task.kind)}…` : `${taskLabel(task.kind)}: ${text}`
  return <p className="computer-card-task" data-state={task.state} role="status">
    {stale ? 'Last confirmed: ' : null}
    {raw && task.state !== 'running' ? <Tooltip content={raw}><span tabIndex={0}>{body}</span></Tooltip> : body}</p>
}

type WorkerStatus = NonNullable<MaintenanceStatus['worker']>
const WORKER_STATE_LABELS: Record<WorkerStatus['state'], string> = {
  current: 'Up to date',
  pending: 'Update pending',
  draining: 'Waiting for current work to finish',
  downloading: 'Downloading update',
  installing: 'Installing update',
  restarting: 'Restarting Worker',
  'rolled-back': 'Rolled back to previous version',
  failed: 'Update failed',
}

function WorkerState({ worker, readiness }: { worker: MaintenanceStatus['worker']; readiness: WorkerBundleReadiness | undefined }) {
  const retry = worker?.state === 'failed' || worker?.state === 'rolled-back'
  let label = worker ? WORKER_STATE_LABELS[worker.state] : 'Status unavailable'
  if (worker?.state === 'current' && readiness?.ready === false) {
    if (readiness.code === 'WORKER_VERSION_SKEW') label = 'Worker update required'
    if (readiness.code === 'WORKER_BUNDLE_UNPUBLISHED') label = 'Worker bundle unavailable'
    if (readiness.code === 'WORKER_UPDATING') label = 'Worker update in progress'
  }
  const error = retry && worker.lastError ? humanizeMaintenanceText(worker.lastError) : undefined
  return <span className="computer-card-worker">
    {worker ? <>
      <span>Current {worker.currentVersion}</span>
      <span>Target {worker.targetVersion ?? 'not reported'}</span>
      <span role="status"><Badge tone={retry || readiness?.ready === false ? 'warning' : 'neutral'}>{label}</Badge></span>
      {error ? <small className="computer-card-worker-error">Last error: {error.raw
        ? <Tooltip content={error.raw}><span tabIndex={0}>{error.text}</span></Tooltip> : error.text}</small> : null}
    </> : <span>Status unavailable</span>}
  </span>
}

/** Restart asks once more because it stops what is running on that computer. */
function RestartButton({ status, busy, onRestart, agents, jobs, activityComplete }: {
  status: MaintenanceStatus | null | undefined; busy: boolean; onRestart(): void
  agents: number; jobs: number; activityComplete: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 6_000)
    return () => clearTimeout(timer)
  }, [confirming])
  if (!status) return null
  return <Button size="sm" variant={confirming ? 'danger' : 'ghost'} disabled={busy || !status.system.sudo}
    title={status.system.sudo ? undefined : 'Needs passwordless sudo'}
    onClick={() => { if (confirming) { setConfirming(false); onRestart() } else setConfirming(true) }}>
    {confirming ? restartConfirmation(agents, jobs, activityComplete) : 'Restart'}</Button>
}

function presenceLabel(observed: ComputerActivity | undefined, fresh: boolean) {
  if (!observed) return 'Status unknown'
  if (!fresh) return 'Status stale'
  return observed.online ? 'Online' : 'Offline'
}

function buildSummary(card: Card, position: number | undefined, total: number) {
  if (card.buildError) return 'Unavailable'
  const preference = card.build?.preference
  if (!preference) return 'Loading…'
  if (!preference.buildEnabled) return 'Off'
  const rank = position === undefined ? 'Fleet priority loading' : `${ordinal(position)} of ${total}`
  return `${rank} · up to ${preference.buildAllowancePercent}% CPU and RAM`
}

function restartConfirmation(agents: number, jobs: number, complete: boolean) {
  const work = [agents ? count(agents, 'agent') : '', jobs ? count(jobs, 'job') : ''].filter(Boolean).join(' and ')
  if (!complete) return work ? `Restart and stop ${work}? Other work may be running` : 'Restart? Other work may be running'
  return work ? `Restart and stop ${work}?` : 'Confirm restart'
}

function bytes(value: number) { return value >= 1e12 ? `${(value / 1e12).toFixed(1)} TB` : `${Math.round(value / 1e9)} GB` }

function ordinal(value: number) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? 'st' : value % 10 === 2 && value % 100 !== 12 ? 'nd' : value % 10 === 3 && value % 100 !== 13 ? 'rd' : 'th'
  return `${value}${suffix}`
}
function count(value: number, noun: string) { return `${value} ${noun}${value === 1 ? '' : 's'}` }
