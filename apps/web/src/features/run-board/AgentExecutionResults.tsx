import { InfoHint } from '../../shared/ui/InfoHint'
import { useState } from 'react'
import { createStore, useStore } from 'zustand'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import { jobQueueHasExecution, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
import type { RepeatGraphScopeV3, RunExecutionSummary, RunExecutionDetail } from '@foreman-code/contracts/wave25'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { Button } from '../../shared/ui/nocturne'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { isRunAccessError, runReadErrorLabel } from '../runs-selector/query'
import { JsonValue } from '../workflow-board/inspect/JsonValue'
import { jobsClient } from '../jobs/client'
import { JobResult } from '../jobs/JobResult'
import { JobQueueFacts } from '../jobs/JobSpecFacts'
import { readForRunVisit, runNodeInspectionKey } from './inspectionQuery'
import { AgentHostCiResults } from './AgentHostCiResults'

export function AgentExecutionResults({ selection, scope, execution, name, acceptedResult }: {
  selection: SelectedRunState; scope: RepeatGraphScopeV3;
  execution: Exclude<RunExecutionSummary, { kind: 'job' }>; name: string
  acceptedResult: RunExecutionDetail['acceptedResult']
}) {
  useHarnessSessionEpoch()
  const client = useQueryClient()
  const origin: JobInitiatingAgent = { workflowId: scope.workflowId, runId: scope.runId,
    agentId: execution.agentId, executionId: execution.executionId }
  const queryKey = [...runNodeInspectionKey(selection), execution.executionId, 'ci']
  const ci = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readForRunVisit(selection, signal, async () => {
      const page = await jobsClient.queuePage(scope.workspaceId,
        { initiatingExecutionId: execution.executionId, historyBeforeSequence: pageParam }, { signal })
      if (page.tickets.some(ticket => !ticket.initiatingAgent
        || ticket.initiatingAgent.workflowId !== origin.workflowId
        || ticket.initiatingAgent.runId !== origin.runId
        || ticket.initiatingAgent.agentId !== origin.agentId
        || ticket.initiatingAgent.executionId !== origin.executionId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'CI history belongs to another Agent execution.' })
      }
      return page
    }),
    getNextPageParam: page => page.nextHistoryCursor ?? undefined,
    enabled: !sessionIsSwitching(),
    retry: false, staleTime: 0, gcTime: 0, maxPages: 5,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
  })
  if (!selection.isCurrent(selection.generation) || sessionIsSwitching()) return null
  const tickets = new Map((ci.data?.pages.flatMap(page => page.tickets) ?? []).map(ticket => [ticket.id, ticket]))
  return <>
    <section aria-label="Agent output and artifacts"><h3>Agent output and artifacts<InfoHint label="Agent output">Follow-up messages appear in Agent chat. They do not change this execution’s output.</InfoHint></h3>
      {acceptedResult.status === 'accepted'
        ? <JsonValue label={`Accepted output from ${name}`} value={acceptedResult.value.output ?? null} />
        : <p>No accepted Agent output recorded.</p>}
    </section>
    <AgentHostCiResults selection={selection} scope={scope} execution={execution} />
    <section aria-label="Agent Job results"><h3>Job executions</h3>
      {ci.isError ? <p role="status">CI history unavailable. {runReadErrorLabel(ci.error)}</p> : <>
        {ci.isPending ? <p role="status">Reading CI requests…</p> : null}
        {!ci.isPending && !tickets.size ? <p>No CI requests recorded for this Agent execution.</p> : null}
        {[...tickets.values()].map(ticket => <CiRequest key={ticket.id} ticket={ticket}
          workspaceId={scope.workspaceId} origin={origin} />)}
        {ci.hasNextPage ? <Button size="sm" disabled={ci.isFetching}
          onClick={() => void ci.fetchNextPage()}>Load older CI requests</Button> : null}
      </>}
      <Button size="sm" disabled={ci.isFetching} onClick={() => void ci.refetch()}>Refresh CI requests</Button>
      {(ci.data?.pageParams.length ?? 0) > 1 || ci.data?.pageParams[0] !== undefined
        ? <Button size="sm" disabled={ci.isFetching}
          onClick={() => void client.resetQueries({ queryKey, exact: true })}>Newest CI requests</Button> : null}
    </section>
  </>
}

function CiRequest({ ticket, workspaceId, origin }: {
  ticket: JobQueueTicket; workspaceId: string; origin: JobInitiatingAgent
}) {
  const [store] = useState(() => createStore<{ open: boolean }>(() => ({ open: false })))
  const open = useStore(store, state => state.open)
  const accepted = jobQueueHasExecution(ticket)
  return <section aria-label={`CI request ${ticket.id}`}>
    <JobQueueFacts ticket={ticket} />
    {accepted && <Button size="sm" aria-expanded={open}
      onClick={() => store.setState({ open: !open })}>{open ? 'Hide result' : 'View result'}</Button>}
    {accepted && open && <JobResult workspaceId={workspaceId}
      executionId={ticket.executionId} expectedInitiatingAgent={origin}
      expectedDefinitionVersionId={ticket.definition.versionId} />}
  </section>
}
