import { InfoHint } from '../../shared/ui/InfoHint'
import { preferRunSummary } from '@foreman-code/contracts/run-snapshots'
import { RunActions } from './actions'
import { useEffect, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import { sameCanonicalGraphScope } from '@foreman-code/contracts/wave25'
import { Alert, Button, EmptyState, Icon, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import { Activities } from './Activities'
import { isActiveRun, runLabel, runTone, shortRunId, when } from './runFacts'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { CurrentRunDetails } from './RunDetails'
import { readBoardRun, readBoardRuns, scopeForBoardRun } from './client'
import { useWorkflowBoard } from './context'
import { boardScope, useBoardUndo } from './boardUndo'

import { boardRunListKey } from './keys'
import { refreshFirstInspectionPage } from './inspect/queries'

async function refreshBoardRuns(client: QueryClient, workspaceId: string, workflowId: string) {
  const key = boardRunListKey(workspaceId, workflowId)
  const cached = client.getQueryData<InfiniteData<Awaited<ReturnType<typeof readBoardRuns>>, string | null>>(key)
  if (cached?.pageParams[0] === null) {
    await client.invalidateQueries({ queryKey: key, exact: true })
  } else {
    // A capped history may have evicted the initial page and its cursor.
    await refreshFirstInspectionPage(client, key)
  }
}

export function RunActivityPanel({ summaries, summariesReadAt = 0 }: {
  summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number
}) {
  const board = useWorkflowBoard()!
  const { workspaceId, workflowId, run: selected, selectRun } = board
  const client = useQueryClient()
  const request = useRef(0)
  const mounted = useRef({ workspaceId, workflowId })
  mounted.current = { workspaceId, workflowId }
  const discovery = useMutation({ retry: false,
    mutationFn: async ({ runId, generation }: { runId: string; generation: number; ticket: number }) => {
      const result = await client.fetchQuery({ queryKey: ['workbench', 'board-run-discovery', generation, workspaceId, workflowId, runId],
        queryFn: ({ signal }) => readBoardRun(workspaceId, workflowId, runId, { signal }), staleTime: 0 })
      assertSession(generation)
      return scopeForBoardRun(result.run)
    },
    onSuccess: (scope, variables) => {
      if (variables.ticket !== request.current || variables.generation !== sessionGeneration()
        || mounted.current.workspaceId !== workspaceId || mounted.current.workflowId !== workflowId) return
      selectRun(scope)
    },
  })
  const resetDiscovery = discovery.reset
  // URL/back navigation invalidates discovery, without mirroring request state.
  useEffect(() => { ++request.current; resetDiscovery() },
    [selected?.runId, selected?.workflowVersionId, selected?.executionSemanticsVersion, resetDiscovery])
  useEffect(() => () => { ++request.current }, [])
  const latestDiscovery = discovery.variables?.ticket === request.current
  const reading = latestDiscovery && discovery.isPending ? discovery.variables?.runId : undefined
  const error = latestDiscovery && discovery.isError ? discovery.error.message : undefined
  const runs = useInfiniteQuery({ queryKey: boardRunListKey(workspaceId, workflowId),
    meta: { refetchOnApiReconnect: false },
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readBoardRuns(workspaceId, workflowId, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) => page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
    maxPages: 5, staleTime: Infinity, refetchOnMount: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  useEffect(() => {
    const key = boardRunListKey(workspaceId, workflowId)
    if (client.getQueryData(key)) void refreshBoardRuns(client, workspaceId, workflowId)
  }, [client, workspaceId, workflowId])
  const denied = useProtectedAccessError(runs)
  const listed = denied || runs.isError ? [] : [...new Map(runs.data?.pages.flatMap((page) => page.items.map((run) => [run.id, run] as const)) ?? []).values()]
  const workspaceSummaries = denied ? [] : summaries.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflowId)
  const summariesById = new Map(workspaceSummaries.map((run) => [run.id, run]))
  const summaryRuns = JSON.stringify([workspaceId, workflowId,
    workspaceSummaries.map((run) => `${run.id}:${isActiveRun(run)}`).sort()])
  const previousSummaryRuns = useRef(summaryRuns)
  useEffect(() => {
    if (previousSummaryRuns.current === summaryRuns) return
    previousSummaryRuns.current = summaryRuns
    if (!denied) void refreshBoardRuns(client, workspaceId, workflowId)
  }, [summaryRuns, client, denied, workspaceId, workflowId])
  const inspect = (runId: string) => discovery.mutate({ runId, generation: sessionGeneration(), ticket: ++request.current })
  const listedIds = new Set(listed.map((item) => item.id))
  const runParts = <>
    <h3>Current and past Runs<InfoHint label="Current and past Runs">Select a Run to show its own immutable topology, even when repeat was added or removed in a later saved version. The five most recently loaded pages are retained. Refresh starts at the first page.</InfoHint></h3>
    {error ? <Alert tone="danger" live title="That run couldn’t be opened.">{error}</Alert> : null}
    {denied ? <Alert tone="warning" title="You don’t have access to this workflow’s runs." /> : runs.isError ? <Alert tone="danger" title="Runs couldn’t be loaded."
      action={<Button size="sm" onClick={() => void refreshFirstInspectionPage(client, boardRunListKey(workspaceId, workflowId))}>Try again</Button>} /> : null}
    {runs.isPending && !denied ? <LoadingState label="Loading runs…" rows={3} /> : null}
    {!runs.isPending && !listed.length && !workspaceSummaries.length && !denied && !runs.isError ? <EmptyState icon="history" title="No runs yet" description="Start a run from the board." /> : null}
    <ul className="board-run-list">
      {workspaceSummaries.filter((run) => !listedIds.has(run.id)).map((run) => <li key={run.id}>
        <button type="button" className="board-run-row" disabled={reading === run.id} onClick={() => void inspect(run.id)} aria-label={`Inspect ${run.id}`}>
          <StatusBadge label={runLabel(run.executionState, run.outcome)} tone={runTone(run.executionState, run.outcome)} busy={run.executionState === 'running'} />
          <code>{shortRunId(run.id)}</code><span>{run.cleanupPending ? 'Cleaning up' : when(run.startedAt)}</span>
        </button></li>)}
      {listed.map((run) => {
        const facts = preferRunSummary(summariesById.get(run.id), run, summariesReadAt, runs.dataUpdatedAt)
        let scope: ReturnType<typeof scopeForBoardRun>
        try { scope = scopeForBoardRun(run) } catch {
          return <li key={run.id}><p className="next-draft-hint">Run {shortRunId(run.id)} can’t be shown on this board.</p></li>
        }
        const current = !!selected && sameCanonicalGraphScope(scope, selected)
        return <li key={run.id}><button type="button" className="board-run-row" aria-pressed={current}
          aria-label={`Open Run ${run.id} · ${facts.executionState} · ${facts.outcome}`}
          onClick={() => { ++request.current; resetDiscovery(); selectRun(current ? undefined : scope) }}>
          <StatusBadge label={runLabel(facts.executionState, facts.outcome)} tone={runTone(facts.executionState, facts.outcome)} busy={facts.executionState === 'running'} />
          <code>{shortRunId(run.id)}</code><span>{when(facts.startedAt)}</span>
          <span>{facts.executionState === 'completed' ? 'Past Run' : 'Current Run'} · saved version <code>{run.workflowVersionId}</code></span>
        </button></li>
      })}
    </ul>
    <div className="n-actions">
      {runs.hasNextPage && !denied && !runs.isError ? <Button size="sm" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>Load more Runs</Button> : null}
      <Button size="sm" variant="ghost" leading={<Icon name="refresh" size={14} />} disabled={runs.isFetching} onClick={() => void refreshFirstInspectionPage(client, boardRunListKey(workspaceId, workflowId))}>Refresh Runs</Button>
    </div>
    {!selected ? <section className="board-activities" aria-label="Activities"><h3>Activities</h3>
      <p>Select a Run to see its recorded Agent actions, outcomes and notices.</p></section> : null}
    {selected ? <section className="board-run-detail" aria-label="Selected run">
      <header><h3>Run {shortRunId(selected.runId)}</h3>
        <Button size="sm" variant="ghost" onClick={() => { ++request.current; resetDiscovery(); selectRun() }}>Clear Run selection</Button></header>
      <CurrentRunDetails key={JSON.stringify(selected)} scope={selected}
        runActions={<RunActions workspaceId={selected.workspaceId} workflowId={selected.workflowId} runId={selected.runId} />} />
    </section> : null}
  </>
  return <div className="workflow-board-run-panel" aria-label="Run activity" data-testid="board-run-activity">
    <BoardChanges scope={boardScope(workspaceId, workflowId)} />
    {selected ? <>
      <Activities key={JSON.stringify(selected)} scope={selected} />
      <details className="board-run-more"><summary>Runs and Run details</summary>{runParts}</details>
    </> : runParts}
  </div>
}

/** Undo and redo steps taken on this Board in this session, newest first. */
function BoardChanges({ scope }: { scope: string }) {
  const changes = useBoardUndo((state) => state.changes[scope])
  if (!changes?.length) return null
  return <section className="board-activities board-changes" aria-label="Board changes"><header><h3>Board changes</h3></header>
    <ol className="board-activities-list">{changes.map((change) => <li key={change.id} data-status="recorded">
      <span className="board-activity-dot" aria-hidden="true" />
      <time dateTime={change.at}>{new Date(change.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
      <div><p>{change.text}</p></div></li>)}</ol>
  </section>
}
