import { useRef } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3, RunExecutionSummary } from '@foreman-code/contracts/wave25'
import { runActionsClient } from './client'
import { actionKey, useDisclosure } from './state'

function ExecutionReport({ scope, row }: { scope: RepeatGraphScopeV3; row: RunExecutionSummary }) {
  const [open, setOpen] = useDisclosure()
  const detail = useQuery({ queryKey: actionKey(scope, 'report', row.executionId), enabled: open,
    queryFn: ({ signal }) => runActionsClient.execution(scope, row.executionId, { signal }, row),
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const value = detail.isError ? undefined : detail.data
  return <li><details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Execution {row.executionId} · {row.workflowNodeId} · attempt {row.attempt} · {row.state}</summary>
    {open ? <div>
      {row.occurrence ? <p>Configured business occurrence <code>{row.occurrence.occurrenceId}</code>, index {row.occurrence.occurrenceIndex}.
        {' '}This is separate from technical attempt {row.attempt}.</p> : <p>No business-repeat occurrence is attached to this execution.</p>}
      <p>Configuration <code>{row.kind==='job'?row.jobDefinitionVersionId:row.agentConfigurationVersionId}</code> · saved version <code>{scope.workflowVersionId}</code>.</p>
      {detail.isPending ? <p role="status">Reading the exact execution report…</p> : null}
      {detail.isError ? <p role="alert">Exact report is unavailable: {detail.error.message}</p> : null}
      <button type="button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>Refresh exact report</button>
      {value ? <>
        <p>Recorded state: {value.execution.state}.</p>
        {value.reportedResult ? <>
          <h5>Recorded execution result — not an accepted predecessor result</h5>
          <pre tabIndex={0} aria-label={`Reported result ${row.executionId}`}>{JSON.stringify(value.reportedResult, null, 2)}</pre>
          {value.reportedResult.outcome === 'failed' && value.reportedResult.error?.retryable ? <p>The recorded error is marked retryable. This is diagnostic information, not a permission or capability to retry this node.</p> : null}
        </> : <p>No execution result is recorded for this execution.</p>}
        {value.acceptedResult.status === 'accepted' ? <>
          <h5>Accepted successful predecessor result</h5>
          <pre tabIndex={0} aria-label={`Accepted result ${row.executionId}`}>{JSON.stringify(value.acceptedResult.value, null, 2)}</pre>
        </> : <p>No successful predecessor result was accepted. A native failure report is not promoted to one.</p>}
      </> : null}
    </div> : null}
  </details></li>
}

function RunResultReport({ scope }: { scope: RepeatGraphScopeV3 }) {
  const [open, setOpen] = useDisclosure()
  const report = useQuery({ queryKey: actionKey(scope, 'run-result'), enabled: open,
    queryFn: ({ signal }) => runActionsClient.runResult(scope, { signal }), retry: false, gcTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false })
  const value = report.isError ? undefined : report.data
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Recorded Run-level result</summary>
    {open ? <div>
      {report.isPending ? <p role="status">Reading the recorded Run result…</p> : null}
      {report.isError ? <p role="alert">Run result is unavailable: {report.error.message}</p> : null}
      {value ? <><p>Recorded {value.executionState} · {value.outcome}. Run-level failure can exist even when individual executions succeeded.</p>
        {value.result ? <pre tabIndex={0} aria-label="Exact recorded Run result">{JSON.stringify(value.result, null, 2)}</pre>
          : <p>No terminal Run result is recorded.</p>}</> : null}
      <button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>Refresh recorded Run result</button>
    </div> : null}
  </details>
}

export function FailureDetails({ scope }: { scope: RepeatGraphScopeV3 }) {
  const [open, setOpen] = useDisclosure(), cache = useQueryClient(), pageHeading = useRef<HTMLHeadingElement>(null)
  const page = useInfiniteQuery({ queryKey: actionKey(scope, 'reports'), enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => runActionsClient.executions(scope, pageParam, 10, { signal }),
    getNextPageParam: (value) => value.pageInfo.nextCursor ?? undefined,
    maxPages: 1, retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const rows = page.isError ? [] : page.data?.pages[0]?.items ?? []
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Failure details and execution reports</summary>
    {open ? <section aria-label="Run execution reports">
      <h4 ref={pageHeading} tabIndex={-1}>Execution report page</h4>
      <p>Read exact recorded failures, cancellations and results by execution. This API pages all executions; this is not a complete failure count or a node-retry control.</p>
      {page.isPending ? <p role="status">Loading one bounded execution page…</p> : null}
      {page.isError ? <p role="alert">Execution reports are unavailable: {page.error.message}</p> : null}
      <button type="button" disabled={page.isFetching} onClick={() => void page.refetch()}>Refresh execution page</button>
      <RunResultReport scope={scope} />
      <ol>{rows.map((row) => <ExecutionReport key={row.executionId} scope={scope} row={row} />)}</ol>
      {!page.isPending && !page.isError && !rows.length ? <p>No executions are recorded on this page.</p> : null}
      {page.hasNextPage ? <button type="button" disabled={page.isFetching} onClick={() => void page.fetchNextPage().then(() => pageHeading.current?.focus())}>Next execution page</button> : null}
      {page.data?.pageParams[0] !== null && page.data?.pageParams[0] !== undefined ? <button type="button" disabled={page.isFetching}
        onClick={() => void cache.resetQueries({ queryKey: actionKey(scope, 'reports'), exact: true }).then(() => pageHeading.current?.focus())}>First execution page</button> : null}
      <p>Up to 10 summaries are retained for this panel. Inputs and reports are never fetched by the current-state polling loop.</p>
    </section> : null}
  </details>
}

export function SavedRepeatPolicy({ scope }: { scope: RepeatGraphScopeV3 }) {
  const [open, setOpen] = useDisclosure()
  const pinned = useQuery({ queryKey: actionKey(scope, 'repeat-policy'), enabled: open,
    queryFn: ({ signal }) => runActionsClient.version(scope, { signal }), retry: false, gcTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false })
  const version = pinned.isError ? undefined : pinned.data?.version
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Saved business-repetition policy</summary>
    {open ? <div>
      {pinned.isPending ? <p role="status">Reading the pinned saved version…</p> : null}
      {pinned.isError ? <p role="alert">The saved policy is unavailable. Current draft configuration is not substituted.</p> : null}
      {version ? version.definition.repeat ? <><p>Business repetition is configured in saved version <code>{version.id}</code>; it is not a user recovery action.</p>
        <pre tabIndex={0}>{JSON.stringify(version.definition.repeat, null, 2)}</pre></> : <p>No business repeat is configured in this saved version. Ordinary executions and technical attempts are not repeat rounds.</p> : null}
    </div> : null}
  </details>
}
