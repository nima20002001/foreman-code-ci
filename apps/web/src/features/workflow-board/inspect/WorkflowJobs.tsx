import { useState } from 'react'
import { createStore, useStore } from 'zustand'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { jobQueueHasExecution } from '@foreman-code/contracts/job-admission'
import { Button, Icon, type IconName } from '../../../shared/ui/nocturne'
import { JobResult } from '../../jobs/JobResult'
import { JobQueueFacts } from '../../jobs/JobSpecFacts'
import { jobError } from '../../jobs/model'
import { useWorkflowJobHistory, useWorkflowJobQueue } from '../../jobs/query'
import { formatDuration } from '../../resource-telemetry/telemetryView'

function createJobsPanelStore() {
  type SelectedJob = Pick<JobExecutionRecord, 'id' | 'initiatingAgent'> & { definitionVersionId: string }
  return createStore<{
    selected: SelectedJob | null
    select(execution: JobExecutionRecord | null): void
  }>(set => ({
    selected: null,
    select: execution => set({ selected: execution ? {
      id: execution.id,
      definitionVersionId: execution.acceptedSpec.definitionVersionId,
      ...(execution.initiatingAgent ? { initiatingAgent: execution.initiatingAgent } : {}),
    } : null }),
  }))
}

export function WorkflowJobs({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const [store] = useState(createJobsPanelStore)
  const selected = useStore(store, state => state.selected)
  const history = useWorkflowJobHistory(workspaceId, workflowId, true)
  const queue = useWorkflowJobQueue(workspaceId, workflowId, true)
  const requests = queue.tickets.filter(ticket => !jobQueueHasExecution(ticket))
  return <div className="workflow-board-run-panel">
        {history.isError ? <p role="alert">{jobError(history.error)}
          <Button size="sm" variant="ghost" onClick={() => void history.refetch()}>Retry</Button>
        </p> : <>
          {selected ? <>
            <Button size="sm" variant="ghost" onClick={() => store.getState().select(null)}>Back to jobs</Button>
            <JobResult key={selected.id} workspaceId={workspaceId} executionId={selected.id}
              expectedDefinitionVersionId={selected.definitionVersionId}
              {...(selected.initiatingAgent ? { expectedInitiatingAgent: selected.initiatingAgent } : {})} />
          </> : <>
            {queue.isError ? <p role="alert">Job requests unavailable. {jobError(queue.error)}
              <Button size="sm" variant="ghost" onClick={() => void queue.refetch()}>Retry requests</Button>
            </p> : null}
            {history.isPending || queue.isPending ? <p role="status">Loading jobs…</p> : null}
            {!history.isPending && !queue.isPending && !queue.isError
              && !history.items.length && !queue.tickets.length ? <p>No jobs yet.</p> : null}
            {requests.length > 0 && <section aria-label="Job requests"><h3>Job requests</h3>
              {requests.map(ticket => <section key={ticket.id} aria-label={`Job request ${ticket.id}`}>
                <h4>{ticket.definition.name}</h4>
                {ticket.initiatingAgent && <p>Agent: {ticket.initiatingAgent.agentId} · Run: {ticket.initiatingAgent.runId}</p>}
                <JobQueueFacts ticket={ticket} />
              </section>)}
            </section>}
            {queue.hasNextPage ? <Button size="sm" variant="ghost" disabled={queue.isFetching}
              onClick={() => void queue.fetchNextPage()}>Older requests</Button> : null}
            {history.items.length > 0 && <h3>Accepted executions</h3>}
            <ul className="board-job-list" aria-label="Workflow jobs">
              {history.items.map(item => <li key={item.execution.id}>
                <JobRow name={item.name} execution={item.execution}
                  onClick={() => store.getState().select(item.execution)} />
              </li>)}
            </ul>
            {history.hasNextPage ? <Button size="sm" variant="ghost" disabled={history.isFetching}
              onClick={() => void history.fetchNextPage()}>Older jobs</Button> : null}
          </>}
        </>}
  </div>
}

function jobStatus(execution: JobExecutionRecord): { label: string; icon: IconName; tone: string } {
  const { outcome, phase } = execution.process
  if (outcome === 'succeeded') {
    if (execution.publication === 'failed' || execution.resultIssue) {
      return { label: 'Process succeeded · results incomplete', icon: 'close', tone: 'danger' }
    }
    if (execution.publication !== 'complete') {
      return { label: 'Process succeeded · publishing results', icon: 'clock', tone: 'neutral' }
    }
    return { label: 'Process succeeded · publication complete', icon: 'check', tone: 'neutral' }
  }
  if (outcome === 'cancelled') return { label: 'Canceled', icon: 'stop', tone: 'neutral' }
  if (outcome) return { label: 'Failed', icon: 'close', tone: 'danger' }
  if (phase === 'running') return { label: 'Running', icon: 'play', tone: 'neutral' }
  if (phase === 'preparing') return { label: 'Preparing', icon: 'clock', tone: 'neutral' }
  return { label: 'Queued', icon: 'clock', tone: 'neutral' }
}

function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour')
  return formatter.format(-Math.floor(seconds / 86400), 'day')
}

function JobRow({ name, execution, onClick }: { name: string; execution: JobExecutionRecord; onClick(): void }) {
  const status = jobStatus(execution)
  const duration = execution.startedAt
    ? formatDuration(Math.max(0, Date.parse(execution.finishedAt ?? execution.updatedAt) - Date.parse(execution.startedAt)))
    : '—'
  const label = execution.initiatingAgent && !name.startsWith('CI: ') ? `CI: ${name}` : name
  return <Button className="board-job-row" size="sm" variant="ghost" onClick={onClick}>
    <span className="board-job-name" title={label}>{label}</span>
    <span className={`board-job-status board-job-status-${status.tone}`} aria-label={status.label} title={status.label}>
      <Icon name={status.icon} size={15} />
    </span>
    <span title={execution.finishedAt ? 'Duration' : 'Duration through last result update'}>{duration}</span>
    <span className="board-job-computer" title={execution.acceptedSpec.target.labelAtAcceptance}>
      {execution.acceptedSpec.target.labelAtAcceptance}
    </span>
    <time dateTime={execution.createdAt} title={new Date(execution.createdAt).toLocaleString()}>
      {relativeTime(execution.createdAt)}
    </time>
  </Button>
}
