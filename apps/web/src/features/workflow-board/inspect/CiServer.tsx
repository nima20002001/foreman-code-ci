import { InfoHint } from '../../../shared/ui/InfoHint'
import { memo, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import type { CiRunJob, CiTestStatus } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Alert, Badge, Button, Dialog, EmptyState, Icon, Spinner, Tabs, type Tone } from '../../../shared/ui/nocturne'
import { PulseFlight, type EdgePulse } from '../../graph/SignalEdgeShape'
import { useFloatingCurve } from '../../graph/signalEdge'
import { formatClock, formatDuration } from '../../run-subagents/presentation'
import { ciComputerLabel, ciJobLabel } from './runLiveStatus'
import { runInspectionQueryKey } from './queries'
import { WorkflowJobs } from './WorkflowJobs'
import { CI_PLACEMENT_LABELS, ciJobDuration, ciJobRefreshing, isActiveCiJob, runCiApi, type CiServerSummary } from './ciServer'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { isApiAccessError } from '../../../shared/api/accessError'

const SHORT_PLACEMENTS = { host: 'Host CI', github: 'GitHub', circleci: 'CircleCI' } as const

export type CiServerFlowNode = Node<{ summary: CiServerSummary; open(): void; rim: 'box' }, 'ciServer'>
/** A presentation-only component of the Board, never a workflow node: no edges, no saved geometry, no execution.
 * Drawn as a server tower (drive bays, status LEDs, vents) so it never reads as an Agent. */
export const CiServerNode = memo(function CiServerNode({ data }: NodeProps<CiServerFlowNode>) {
  const { summary } = data
  const where = summary.placements.length ? summary.placements.map((placement) => SHORT_PLACEMENTS[placement]).join(' · ')
    : 'Host CI · GitHub · CircleCI'
  return <div className="ci-server-node" data-state={summary.state}>
    <button type="button" className="ci-server-chassis" onClick={data.open}
      aria-label={`CI server, ${summary.label}. Open CI jobs and test results`}>
      <span className="ci-server-bays" aria-hidden="true">{[0, 1, 2].map((bay) => <span key={bay} className="ci-server-bay">
        <i className="ci-server-led" /><i className="ci-server-slot" /></span>)}</span>
      <span key={summary.label} className="ci-server-status"><i aria-hidden="true" />{summary.label}</span>
      <strong className="ci-server-name"><Icon name="server" size={14} />CI server</strong>
      <span className="ci-server-where">{where}</span>
      <span className="ci-server-meta"><span><small>Jobs</small><b>{summary.total}</b></span>
        <span><small>Failed</small><b>{summary.failed}</b></span></span>
      <span className="ci-server-vents" aria-hidden="true" />
    </button>
    {/* Only for the passing lights; nothing connects to the server. */}
    <Handle id="left" type="target" position={Position.Left} isConnectable={false} className="ci-server-target" />
  </div>
})

export type CiTransferFlowEdge = Edge<{ pulses: EdgePulse[] }, 'ciTransfer'>
/** A light in flight between an Agent and the CI server; the edge exists only while it travels. */
export const CiTransferEdge = memo(function CiTransferEdge({ source, target, data }: EdgeProps<CiTransferFlowEdge>) {
  const curve = useFloatingCurve(source, target, 0)
  if (!curve || !data) return null
  return <g className="ci-transfer" aria-hidden="true">
    {data.pulses.map((pulse) => <PulseFlight key={pulse.key} path={curve.path} pulse={pulse} />)}
  </g>
})

const stateTone: Record<CiRunJob['ci']['state'], Tone> = { queued: 'neutral', starting: 'info', running: 'info',
  passed: 'success', failed: 'danger', canceled: 'neutral', lost: 'danger' }
const testTone: Record<CiTestStatus, Tone> = { passed: 'success', failed: 'danger', skipped: 'neutral' }
const STATUSES: readonly CiTestStatus[] = ['failed', 'skipped', 'passed']
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1)

type Tab = 'jobs' | 'tests' | 'log' | 'workflow-jobs'
/** The CI server's jobs for this Run; a job opens its test results and log tail. */
export function CiServerDialog({ open, onOpenChange, scope, workflow, jobs, names, truncated, error, loading, ticketId }: {
  open: boolean; onOpenChange(open: boolean): void; scope?: RepeatGraphScopeV3 | undefined; jobs: readonly CiRunJob[]
  workflow?: { workspaceId: string; workflowId: string } | undefined
  names: ReadonlyMap<string, string>; truncated: boolean; error: boolean; loading: boolean
  ticketId?: string | undefined
}) {
  const [tab, setTab] = useState<Tab>('jobs')
  const [selectedId, setSelectedId] = useState<string>()
  // Kept here so the status filter survives a visit to another tab.
  const [statuses, setStatuses] = useState<CiTestStatus[]>([...STATUSES])
  useEffect(() => {
    if (open && ticketId) {
      setSelectedId(ticketId)
      setTab('tests')
    }
  }, [open, ticketId])
  const selected = jobs.find((job) => job.ticketId === selectedId)
  const agent = (job: CiRunJob) => names.get(job.requester.nodeId) ?? job.requester.nodeName
  const show = (job: CiRunJob) => { setSelectedId(job.ticketId); setTab('tests') }
  return <Dialog open={open} onOpenChange={onOpenChange} size="xl" className="ci-server-dialog" title="CI server"
    closeLabel="Close CI server" headerLeading={<InfoHint label="CI server">{scope
      ? 'CI jobs the Agents of this Run requested, on Host CI, GitHub Actions or CircleCI.'
      : 'CI jobs that Agents request during a Run appear here, on Host CI, GitHub Actions or CircleCI.'}</InfoHint>}>
    {/* The shared Dialog keeps its children while closed; nothing here may poll then. */}
    {open ? <>{error ? <Alert tone="warning" title="CI jobs could not be read.">
      {jobs.length ? 'The list shows the last jobs read.' : 'Reading CI needs the CI read grants for this workspace.'}</Alert> : null}
    <Tabs label="CI server" value={tab} onValueChange={(value) => setTab(value as Tab)} keepMounted={false} items={[
      { value: 'jobs', label: 'Jobs', badge: jobs.length, content: loading ? <Spinner label="Loading CI jobs" />
        : <CiJobsTable jobs={jobs} agent={agent} selectedId={selected?.ticketId} truncated={truncated} onShow={show} run={Boolean(scope)} /> },
      { value: 'tests', label: 'Tests', disabled: !selected || !scope,
        content: selected && scope ? <CiJobTests scope={scope} job={selected} agent={agent(selected)}
        statuses={statuses} onStatusesChange={setStatuses} /> : null },
      { value: 'log', label: 'Log', disabled: !selected || !scope, content: selected && scope ? <CiJobLog scope={scope} job={selected} /> : null },
      ...(workflow ? [{ value: 'workflow-jobs', label: 'Workflow jobs',
        content: <WorkflowJobs key={JSON.stringify(workflow)} {...workflow} /> }] : []),
    ]} /></> : null}
  </Dialog>
}

export function CiJobsTable({ jobs, agent, selectedId, truncated, onShow, run }: { jobs: readonly CiRunJob[]; agent(job: CiRunJob): string
  selectedId?: string | undefined; truncated: boolean; onShow(job: CiRunJob): void; run: boolean }) {
  if (!jobs.length) return <EmptyState icon="terminal" title={run ? 'No CI jobs in this Run yet' : 'No Run selected'}
    description={run ? undefined : 'Start or select a Run.'} />
  return <div className="n-table-scroll" role="region" aria-label="CI jobs" tabIndex={0}>
    <table className="n-table ci-jobs-table"><thead><tr>
      {['Job', 'Scope', 'Placement', 'State', 'Agent', 'Started', 'Duration'].map((name) => <th key={name} scope="col">{name}</th>)}
    </tr></thead><tbody>{jobs.map((job) => <tr key={job.ticketId} aria-selected={job.ticketId === selectedId}>
      <td><button type="button" className="ci-job-open" onClick={() => onShow(job)}
        aria-label={`Show tests of ${ciJobLabel(job.ci)} requested by ${agent(job)}`}>{ciJobLabel(job.ci)}</button></td>
      <td>{label(job.scope)}</td>
      <td>{job.placement ? CI_PLACEMENT_LABELS[job.placement] : 'Waiting for a computer'}
        {job.ci.computer ? <small>{job.ci.computer.label}</small> : null}</td>
      <td><Badge tone={job.message && isActiveCiJob(job) ? 'warning' : stateTone[job.ci.state]} dot>
        {label(job.ci.state)}</Badge>
        {job.message ? <small>{job.message}</small> : null}
        {job.ci.step ? <small>Step {job.ci.step}</small> : null}
        {job.tests ? <small>{job.tests.passed} passed · {job.tests.failed} failed · {job.tests.skipped} skipped</small> : null}</td>
      <td>{agent(job)}</td>
      <td>{job.ci.startedAt ? <time dateTime={job.ci.startedAt}>{formatClock(job.ci.startedAt)}</time>
        : <>Queued <time dateTime={job.ci.queuedAt}>{formatClock(job.ci.queuedAt)}</time></>}</td>
      <td>{ciJobDuration(job) === null ? '—' : formatDuration(ciJobDuration(job)!)}</td>
    </tr>)}</tbody></table>
    {truncated ? <p className="ci-server-note">Showing the newest 500 jobs.</p> : null}
  </div>
}

function CiJobHeader({ job, agent }: { job: CiRunJob; agent?: string }) {
  const duration = ciJobDuration(job)
  return <p className="ci-server-job">
    <strong>{ciJobLabel(job.ci)}</strong>
    <Badge tone={job.message && isActiveCiJob(job) ? 'warning' : stateTone[job.ci.state]} dot>{label(job.ci.state)}</Badge>
    {job.message ? <span>{job.message}</span> : null}
    {agent ? <span>Requested by {agent}</span> : null}
    <span>{ciComputerLabel(job.ci)}</span>
    {job.ci.startedAt ? <span>Started <time dateTime={job.ci.startedAt}>{formatClock(job.ci.startedAt)}</time></span> : null}
    {duration !== null ? <span>{isActiveCiJob(job) ? `${formatDuration(duration)} so far` : `Ran ${formatDuration(duration)}`}</span> : null}
  </p>
}

function CiJobTests({ scope, job, agent, statuses, onStatusesChange }: { scope: RepeatGraphScopeV3; job: CiRunJob; agent: string
  statuses: readonly CiTestStatus[]; onStatusesChange(statuses: CiTestStatus[]): void }) {
  const selected = STATUSES.filter((status) => statuses.includes(status))
  const query = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-tests', job.ticketId, selected.join(','), job.ci.state, job.tests],
    queryFn: ({ signal }) => runCiApi.tests({ workspaceId: scope.workspaceId, ticketId: job.ticketId,
      ...(selected.length < STATUSES.length ? { status: selected } : {}) }, { signal }),
    enabled: selected.length > 0, retry: false,
  })
  const denied = useProtectedAccessError(query)
  const results = !denied && query.data?.ticketId === job.ticketId ? query.data.tests : undefined
  const counts = denied ? undefined : results?.summary ?? job.tests
  const toggle = (status: CiTestStatus) => onStatusesChange(statuses.includes(status)
    ? statuses.filter((value) => value !== status) : [...statuses, status])
  return <div className="ci-server-tests">
    <CiJobHeader job={job} agent={agent} />
    <h3>Tests<InfoHint label="Tests">Vitest unit and integration jobs report their tests when they finish; other jobs have only a log.</InfoHint></h3>
    <div className="ci-test-filters" role="group" aria-label="Show tests by status">
      {STATUSES.map((status) => <Button key={status} size="sm" variant={statuses.includes(status) ? 'secondary' : 'ghost'}
        aria-pressed={statuses.includes(status)} data-status={status} onClick={() => toggle(status)}>
        {label(status)}{counts ? ` ${counts[status]}` : ''}</Button>)}
    </div>
    {!selected.length ? <p className="ci-server-note">Choose at least one status.</p>
      : query.isPending ? <Spinner label="Loading test results" />
      : query.isError && !results ? <Alert tone="warning" title="Test results are unavailable.">
        <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></Alert>
      : !results ? <EmptyState icon="terminal" title="No test results for this job"
        description={isActiveCiJob(job) ? 'Results arrive when the job finishes.'
          : job.collection === 'pending' ? 'Collecting the finished job\'s results.'
          : undefined} />
      : <CiTestFiles files={results.files} truncated={results.truncated} />}
    {query.isError && results ? <Alert tone="warning" title="Test results could not be refreshed.">
      Showing the last test results read.</Alert> : null}
  </div>
}

function CiTestFiles({ files, truncated }: { files: NonNullable<Awaited<ReturnType<typeof runCiApi.tests>>['tests']>['files']; truncated: boolean }) {
  if (!files.length) return <p className="ci-server-note">No tests with these statuses.</p>
  return <>
    <ul className="ci-test-files" aria-label="Test results">{files.map((file) => <li key={file.file} data-status={file.status}>
      <div className="ci-test-file"><Badge tone={testTone[file.status]} dot>{label(file.status)}</Badge>
        <code>{file.file}</code>{file.durationMs !== null ? <span>{formatDuration(file.durationMs)}</span> : null}</div>
      {file.tests.length ? <ul>{file.tests.map((test, index) => <li key={`${test.name}:${index}`} data-status={test.status}>
        <Badge tone={testTone[test.status]}>{label(test.status)}</Badge><span className="ci-test-name">{test.name}</span>
        {test.durationMs !== null ? <span>{formatDuration(test.durationMs)}</span> : null}
        {test.message ? <pre className="ci-test-message">{test.message}</pre> : null}
      </li>)}</ul> : null}
    </li>)}</ul>
    {truncated ? <p className="ci-server-note">Large runs keep failed tests first; the counts include every test.</p> : null}
  </>
}

function CiJobLog({ scope, job }: { scope: RepeatGraphScopeV3; job: CiRunJob }) {
  const started = job.ci.state !== 'queued'
  const query = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-log', job.ticketId, job.ci.state],
    queryFn: ({ signal }) => runCiApi.logTail({ workspaceId: scope.workspaceId, ticketId: job.ticketId }, { signal }),
    enabled: started, retry: false,
    refetchInterval: state => {
      if (isApiAccessError(state.state.error)) return false
      return ciJobRefreshing(job) ? 3000 : false
    },
  })
  const denied = useProtectedAccessError(query)
  const log = denied ? undefined : query.data
  return <div className="ci-server-log">
    <CiJobHeader job={job} />
    {!started ? <p className="ci-server-note">The job has not started; its log appears once a computer takes it.</p>
      : query.isPending ? <Spinner label="Loading log" />
      : (denied || query.isError) && !log ? <Alert tone="warning" title="The log is unavailable right now.">
        The computer that ran this job may be offline.</Alert>
      : <pre className="ci-log" tabIndex={0} aria-label="Log tail">{log?.text || 'The log is empty.'}</pre>}
    {query.isError && log ? <Alert tone="warning" title="The log could not be refreshed.">
      Showing the last log read.</Alert> : null}
  </div>
}
