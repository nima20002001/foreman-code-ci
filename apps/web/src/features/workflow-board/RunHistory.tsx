import { InfoHint } from '../../shared/ui/InfoHint'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { readBoardHistory } from './client'
import { Button } from '../../shared/ui/nocturne'
import { refreshFirstInspectionPage } from './inspect/queries'
import { useInspectionPresentation } from './inspect/presentation'
import { JsonDisclosure } from './inspect/JsonValue'

/** Deliberate authenticated history reads; not part of live graph refresh. */
export function RunHistory({ scope }: { scope: RepeatGraphScopeV3 }) {
  const cache = useQueryClient()
  const key = ['workbench', 'board-history', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId]
  const disclosure = JSON.stringify(key)
  const open = useInspectionPresentation((state) => !!state.open[disclosure])
  const history = useInfiniteQuery({
    meta: { refetchOnApiReconnect: false },
    queryKey: key, enabled: open, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readBoardHistory(scope, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) =>
      page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
    maxPages: 5, staleTime: Infinity, gcTime: 60_000, refetchOnMount: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  const denied = useProtectedAccessError(history)
  const items = history.isError || denied ? [] : [...new Map(history.data?.pages.flatMap((page) =>
    page.items.map((item) => [item.id, item] as const)) ?? []).values()]
  return <details className="board-history" open={open}
    onToggle={(event) => useInspectionPresentation.getState().setOpen(disclosure, event.currentTarget.open)}>
    <summary>Run activity history<InfoHint label="History">Recorded activity for this Run only. History does not refresh with the live canvas. The five most recently loaded pages are retained. Refresh starts at the first page.</InfoHint></summary>
    {open ? denied ? <p role="alert">History access is unavailable.</p> : <>
      {history.isPaused ? <p role="status">History refresh is paused. Loaded pages are recorded history.</p> : history.isPending ? <p role="status">Loading history…</p> : null}
      {history.isError ? <p role="alert">History could not be loaded. Previously loaded activity is withheld.
        <Button size="sm" variant="ghost" onClick={() => void refreshFirstInspectionPage(cache, key)}>Retry history</Button></p> : null}
      <ol>{items.map((item) => <li key={item.id}>
        <strong>{item.kind}</strong> <time dateTime={item.occurredAt}>{item.occurredAt}</time>
        <JsonDisclosure disclosureKey={`${disclosure}:${item.id}`} summary="Activity details" label={`Activity ${item.id}`} value={item.payload} />
      </li>)}</ol>
      {history.data && !history.isError && !items.length ? <p>No recorded activity in this history.</p> : null}
      {history.hasNextPage && !history.isError ? <Button size="sm" disabled={history.isFetching}
        onClick={() => void history.fetchNextPage()}>Load more activity</Button> : null}
      <Button size="sm" variant="ghost" disabled={history.isFetching} onClick={() => void refreshFirstInspectionPage(cache, key)}>Refresh activity</Button>
    </> : null}
  </details>
}
