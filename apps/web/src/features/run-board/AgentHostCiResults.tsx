import { useState } from 'react'
import { createStore, useStore } from 'zustand'
import type { RepeatGraphScopeV3, RunExecutionSummary } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { Button } from '../../shared/ui/nocturne'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { runReadErrorLabel } from '../runs-selector/query'
import { CiJobsTable, CiServerDialog } from '../workflow-board/inspect/CiServer'
import { runCiApi } from '../workflow-board/inspect/ciServer'
import { useRunNodeRead } from './inspectionQuery'

export function AgentHostCiResults({ selection, scope, execution }: {
  selection: SelectedRunState; scope: RepeatGraphScopeV3; execution: Exclude<RunExecutionSummary, { kind: 'job' }>
}) {
  const [store] = useState(() => createStore<{ open: boolean; ticketId?: string }>(() => ({ open: false })))
  const open = useStore(store, state => state.open)
  const ticketId = useStore(store, state => state.ticketId)
  const query = useRunNodeRead(selection, [execution.executionId, 'host-ci'], async signal => {
    const result = await runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId,
      executionId: execution.executionId }, { signal })
    if (result.runId !== scope.runId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'CI belongs to another Run.' })
    const jobs = result.jobs.filter(job => job.requester.executionId === execution.executionId)
    if (jobs.some(job => job.requester.agentId !== execution.agentId || job.requester.nodeId !== execution.workflowNodeId)) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'CI belongs to another Agent execution.' })
    }
    return { ...result, jobs }
  })
  if (!selection.isCurrent(selection.generation)) return null
  const jobs = query.isError ? [] : query.data?.jobs ?? []
  return <section aria-label="Agent CI results"><h3>Host CI</h3>
    {query.isError ? <p role="status">CI history unavailable. {runReadErrorLabel(query.error)}</p>
      : query.isPending ? <p role="status">Reading Host CI requests…</p>
      : <CiJobsTable jobs={jobs} agent={job => job.requester.nodeName} truncated={!!query.data?.truncated}
        onShow={job => store.setState({ open: true, ticketId: job.ticketId })} run />}
    <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh Host CI</Button>
    <CiServerDialog open={open && !query.isError} onOpenChange={open => store.setState({ open })}
      scope={scope} jobs={jobs} ticketId={ticketId} names={new Map()} truncated={!!query.data?.truncated}
      error={query.isError} loading={query.isPending} />
  </section>
}
