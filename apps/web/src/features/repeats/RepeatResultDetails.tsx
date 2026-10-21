import { useInfiniteQuery } from '@tanstack/react-query'
import { sameWorkflowValue, type RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import { Alert, Button } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { ApiError } from '../../shared/api/client'
import { repeatClient } from './client'

const renderJson = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)

/** Explicit private result access AFTER a qualified canonical read. It never
 * supplies Run status. Every result must match that cut's exact decision/digest. */
export function RepeatResultDetails({ snapshot }: { snapshot: RepeatGraphCurrentV3 }) {
  const { scope } = snapshot
  const query = useInfiniteQuery({
    queryKey: ['workbench', 'repeat-accepted-results', sessionGeneration(), scope,
      snapshot.state.decisions.map((item) => [item.decisionId, item.acceptedResultDigest])],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const page = await repeatClient.run({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
        ...(pageParam ? { cursor: pageParam } : {}), limit: 100, includeResultData: true }, { signal })
      for (const item of page.items) {
        const occurrence = snapshot.state.occurrences.find((value) => value.identity.occurrenceId === item.occurrence.identity.occurrenceId)
        const decision = snapshot.state.decisions.find((value) => value.decisionId === item.decision?.decisionId)
        if (!occurrence || !sameWorkflowValue(occurrence, item.occurrence)) {
          throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Result detail does not match the selected canonical occurrence.' })
        }
        if (item.decision) {
          const metadata = 'resultData' in item.decision
            ? (({ resultData: _content, ...value }) => { void _content; return value })(item.decision) : item.decision
          if (!decision || !sameWorkflowValue(decision, metadata)) {
            throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Result detail changed the exact accepted decision or result digest. Refresh the canonical cut.' })
          }
        }
      }
      return page
    },
    getNextPageParam: (page) => page.pageInfo.nextCursor ?? undefined,
    retry: false, refetchOnWindowFocus: false,
  })
  const denied = useProtectedAccessError(query)
  if (denied || query.isError) return <Alert tone="warning" title="Accepted result details are unavailable.">
    No private result is substituted for canonical Run status.</Alert>
  if (!query.data) return <p role="status">Loading accepted result details…</p>
  const items = query.data.pages.flatMap((page) => page.items).flatMap(({ occurrence, decision }) =>
    decision && 'resultData' in decision ? [{ occurrence, detail: decision.resultData }] : [])
  return <section aria-label="Accepted repeat results">
    {!items.length ? <p>No authorized result detail is present in the loaded pages.</p> : <ul>
      {items.map(({ occurrence, detail }) => <li key={occurrence.identity.occurrenceId}>
        <strong>{occurrence.identity.blockId} · business occurrence {occurrence.identity.occurrenceIndex}</strong>
        <dl><dt>Latest deliverable</dt><dd className="repeat-result"><code>{renderJson(detail.latestDeliverable)}</code></dd>
          <dt>Remaining findings</dt><dd>{detail.remainingFindings.length ? <ul>
            {detail.remainingFindings.map((finding, index) => <li key={index}><code>{renderJson(finding)}</code></li>)}
          </ul> : 'None recorded'}</dd></dl>
      </li>)}
    </ul>}
    {query.hasNextPage ? <Button size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more accepted results</Button> : null}
  </section>
}
