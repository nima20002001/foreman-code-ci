import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultStringifySearch, useLocation, useRouter } from '@tanstack/react-router'
import type { RepeatGraphScopeV3, RunActivityPublic } from '@foreman-code/contracts/wave25'
import { Alert, Button, Select } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { runReadErrorLabel, useSelectedRunSnapshot } from '../runs-selector/query'
import { createChatVisit } from '../conversations/agentChat/selectedRunChatModel'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { readRunActivities, readRunActivityFeed, mergeOlderRunActivities, isTransientRunActivityError,
  runActivitiesKey, runActivitiesRefetchInterval, type RunActivityFeed, type RunActivityScope } from './runActivitiesQuery'
import './activities.css'

/** focusAgentId pins the feed to one Agent: its filter controls and per-row Agent names are dropped. */
type ActivitiesProps = { scope: RepeatGraphScopeV3; focusAgentId?: string; selection?: never }
  | { scope?: never; selection: SelectedRunState }

type OlderActivityRequest = {
  cursor: string
  generation: number
  controller: AbortController
  done: Promise<void>
  finish(): void
}

/** Run selection changes reset feed, scroll and older-page requests together. */
export function Activities(props: ActivitiesProps) {
  return props.selection ? <SelectedActivities selection={props.selection} />
    : <ActivityFeed key={JSON.stringify(props.scope)} scope={props.scope!} focusAgentId={props.focusAgentId} />
}

function SelectedActivities({ selection }: { selection: SelectedRunState }) {
  const query = useSelectedRunSnapshot(selection)
  if (!selection.active) return null
  if (selection.invalid) return <p role="status">Invalid Run</p>
  if (!selection.isCurrent(selection.generation)) return null
  if (selection.identity.runId === null) return null
  if (query.isError) return <p role="status">{runReadErrorLabel(query.error)}</p>
  const snapshot = query.snapshot
  if (!snapshot) return <p role="status">Loading Activities…</p>
  if (snapshot.kind === 'unavailable') return <p role="status">Activities unavailable</p>
  const scope = { workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId,
    runId: snapshot.runId, workflowVersionId: snapshot.workflowVersionId }
  const address = JSON.stringify([scope, selection.generation.id])
  return <ActivityFeed key={address} scope={scope} selection={selection} address={address} />
}

function ActivityFeed({ scope, selection, address, focusAgentId }: { scope: RunActivityScope; selection?: SelectedRunState; address?: string; focusAgentId?: string }) {
  const cache = useQueryClient()
  const key = address ? [...runActivitiesKey(scope), address] : runActivitiesKey(scope)
  const isSelected = selection?.isCurrent, ticket = selection?.generation
  const visit = useMemo(() => createChatVisit(() => !isSelected || !ticket || isSelected(ticket)), [isSelected, ticket])
  useEffect(() => visit.mount(), [visit])
  const list = useRef<HTMLOListElement>(null)
  const lastSequence = useRef<string | undefined>(undefined)
  const refreshGeneration = useRef(0)
  const olderRequest = useRef<OlderActivityRequest | undefined>(undefined)
  useEffect(() => () => {
    olderRequest.current?.controller.abort()
    olderRequest.current?.finish()
  }, [])
  const [newCount, setNewCount] = useState(0)
  const location = useLocation(), router = useRouter()
  const search = RunsSelectorSearchSchema.parse(location.search)
  const kind = focusAgentId ? '' : search.activityKind ?? '', agentId = focusAgentId ?? search.activityAgentId ?? ''
  const setFilter = (field: 'activityKind' | 'activityAgentId', value: string) => {
    if (!visit.isCurrent()) return
    const next = RunsSelectorSearchSchema.parse({ ...router.state.location.search, [field]: value || undefined })
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(next)
    void router.navigate({ href: `${router.state.location.pathname}${query}${router.history.location.hash}`, replace: true, resetScroll: false })
  }
  const retry = (count: number, error: unknown) => count < 2 && isTransientRunActivityError(error)
  const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000)
  const older = useMutation({ retry, retryDelay,
    onMutate: () => cache.cancelQueries({ queryKey: key, exact: true }),
    mutationFn: async (request: OlderActivityRequest) => {
      const current = visit.capture()
      if (!current() || request.generation !== refreshGeneration.current) {
        throw new DOMException('Activities refreshed', 'AbortError')
      }
      const page = await readRunActivities(scope, request.cursor, { signal: request.controller.signal })
      if (!current() || request.generation !== refreshGeneration.current) {
        throw new DOMException('Activities refreshed', 'AbortError')
      }
      return page
    },
    onSuccess: (page, request) => {
      if (!visit.isCurrent() || request.generation !== refreshGeneration.current) return
      const height = list.current?.scrollHeight ?? 0, top = list.current?.scrollTop ?? 0
      cache.setQueryData<RunActivityFeed>(key, (current) => current ? mergeOlderRunActivities(current, page) : current)
      requestAnimationFrame(() => {
        if (visit.isCurrent() && request.generation === refreshGeneration.current && list.current) {
          list.current.scrollTop = top + list.current.scrollHeight - height
        }
      })
    },
    onError: (error, request) => {
      if (!visit.isCurrent() || request.generation !== refreshGeneration.current
        || !ApiError.is(error) || error.status !== 410) return
      cache.setQueryData<RunActivityFeed>(key, (current) => current && current.olderCursor === request.cursor
        ? { ...current, olderCursor: null } : current)
    },
    onSettled: (_page, _error, request) => {
      request.finish()
      if (olderRequest.current === request) olderRequest.current = undefined
    },
  })
  const feed = useQuery({ queryKey: key,
    queryFn: async ({ signal }) => {
      const current = visit.capture()
      const generation = refreshGeneration.current
      // Read the cache only after an older page has finished its cache write.
      await olderRequest.current?.done
      signal.throwIfAborted()
      if (!current() || generation !== refreshGeneration.current) {
        throw new DOMException('Activities refreshed', 'AbortError')
      }
      const result = await readRunActivityFeed(scope, cache.getQueryData<RunActivityFeed>(key), { signal })
      if (!current() || signal.aborted || generation !== refreshGeneration.current) {
        throw new DOMException('Activities refreshed', 'AbortError')
      }
      return result
    },
    retry, retryDelay, staleTime: 0, gcTime: address ? 0 : 60_000, refetchOnMount: 'always',
    refetchOnReconnect: true, refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (older.error && !isTransientRunActivityError(older.error)
        && !(ApiError.is(older.error) && older.error.status === 410)) return false
      if (query.state.error && !isTransientRunActivityError(query.state.error)) return false
      return runActivitiesRefetchInterval(query.state.data)
    } })
  const denied = useProtectedAccessError(feed, older.error)
  const scopedItems = feed.data?.items
  const latest = scopedItems?.at(-1)?.sequence
  useEffect(() => {
    if (!latest) return
    if (lastSequence.current && BigInt(latest) > BigInt(lastSequence.current)) {
      const unseen = scopedItems?.filter((item) => BigInt(item.sequence) > BigInt(lastSequence.current!)).length ?? 0
      if (list.current && list.current.scrollTop + list.current.clientHeight < list.current.scrollHeight - 24) {
        setNewCount((current) => current + unseen)
      }
    }
    lastSequence.current = latest
  }, [latest, scopedItems])
  const refresh = async () => {
    if (!visit.isCurrent()) return
    const expired = [feed.error, older.error].some((error) => ApiError.is(error) && error.status === 410)
    refreshGeneration.current++
    olderRequest.current?.controller.abort()
    olderRequest.current?.finish()
    olderRequest.current = undefined
    older.reset()
    setNewCount(0)
    lastSequence.current = undefined
    if (expired) {
      await cache.resetQueries({ queryKey: key, exact: true })
    } else {
      await cache.cancelQueries({ queryKey: key, exact: true })
      if (visit.isCurrent()) await cache.refetchQueries({ queryKey: key, exact: true })
    }
  }
  const loadOlder = () => {
    const cursor = feed.data?.olderCursor
    if (!visit.isCurrent() || !cursor || cache.getQueryState(key)?.fetchStatus === 'fetching'
      || olderRequest.current) return
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const request = { cursor, generation: refreshGeneration.current, controller: new AbortController(), done, finish }
    olderRequest.current = request
    older.mutate(request)
  }
  const olderReadRejected = older.error && !isTransientRunActivityError(older.error)
    && !(ApiError.is(older.error) && older.error.status === 410)
  const error = olderReadRejected ? older.error : feed.error ?? older.error
  const retentionGap = ApiError.is(error) && error.status === 410
  const transient = isTransientRunActivityError(error)
  const olderFailed = !feed.error && !!older.error && transient
  let errorTitle = 'Activities are unavailable.'
  if (retentionGap) errorTitle = 'Activity history has a retention gap.'
  else if (olderFailed) errorTitle = 'Older Activities couldn’t be loaded.'
  else if (transient) errorTitle = 'Activities refresh failed.'
  let errorHint: string | undefined
  if (retentionGap) errorHint = 'Refresh to read the retained history. '
  else if (olderFailed) errorHint = 'Try loading the older page again. '
  else if (transient) errorHint = 'Refresh failed. Retrying automatically. '
  else if (!selection) errorHint = 'Loaded Activities are hidden until this Run is read again. '
  let retryLabel = selection ? 'Retry' : 'Reload this Run’s Activities'
  if (olderFailed) retryLabel = 'Retry older Activities'
  const items = visit.isCurrent() && (!error || retentionGap || transient) && !denied && feed.isFetchedAfterMount
    ? scopedItems : undefined
  const agents = [...new Map(items?.flatMap((item) => [item.actor, item.subject]
    .filter((agent) => agent !== undefined && 'agentId' in agent).map((agent) => [agent.agentId, agent] as const)) ?? []).values()]
    .sort((a, b) => a.agentName.localeCompare(b.agentName))
  const visible = items?.filter((item) => (!kind || item.kind === kind)
    && (!agentId || item.actor && 'agentId' in item.actor && item.actor.agentId === agentId
      || item.subject && 'agentId' in item.subject && item.subject.agentId === agentId))
  return <section className="board-activities" aria-label="Activities" data-run-id={scope.runId}>
    <header><h3>Activities<InfoHint label="Activities">Recorded actions for this Run, in server order. Pending approvals stay in the approval inbox. Latest 1,000 public events at most; earlier events may have expired.</InfoHint></h3><Button size="sm" variant="ghost" disabled={feed.isFetching && !older.isPending}
      onClick={refresh} aria-label="Refresh Activities">{selection ? 'Refresh' : 'Refresh Activities'}</Button></header>
    {denied ? <Alert tone="warning" title="Activities access was withdrawn." /> : error ?
      <Alert tone="warning" title={errorTitle}>
        {errorHint}
        <Button size="sm" disabled={olderFailed && (feed.isFetching || older.isPending)}
          onClick={olderFailed ? loadOlder : refresh}>
          {retryLabel}</Button>
      </Alert> : null}
    {!error && !denied && !items ? <p role="status">{feed.isPaused ? 'Activities refresh is offline or paused.' : 'Loading Activities…'}</p> : null}
    {items ? <>
      {!focusAgentId ? <div className="board-activities-filters">
        <Select label="Activity kind" value={kind} onChange={(event) => setFilter('activityKind', event.currentTarget.value)}
          options={[{ value: '', label: 'All actions' }, ...[...new Set(items.map((item) => item.kind))].sort()
            .map((value) => ({ value, label: value.replaceAll('_', ' ') })),
          ...(kind && !items.some((item) => item.kind === kind) ? [{ value: kind, label: `${kind.replaceAll('_', ' ')} (outside loaded history)` }] : [])]} />
        <Select label="Agent" value={agentId} onChange={(event) => setFilter('activityAgentId', event.currentTarget.value)}
          options={[{ value: '', label: 'All agents' }, ...agents.map((agent) => ({ value: agent.agentId, label: agent.agentName })),
            ...(agentId && !agents.some((agent) => agent.agentId === agentId) ? [{ value: agentId, label: 'Selected Agent (outside loaded history)' }] : [])]} />
      </div> : null}
      {newCount ? <Button size="sm" onClick={() => { list.current?.scrollTo({ top: list.current.scrollHeight }); setNewCount(0) }}>
        {newCount} new {newCount === 1 ? 'activity' : 'activities'}</Button> : null}
      {!visible?.length ? <p>{selection ? 'No activities' : items.length ? 'No Activities match these filters.' : 'No public activities have been recorded for this Run.'}</p> :
        <ol className="board-activities-list" ref={list}>{groupRepeats(visible).map(({ item, count }) =>
          <ActivityRow key={item.id} item={item} count={count} showActor={!focusAgentId} />)}</ol>}
      {feed.data?.olderCursor ? <Button size="sm" disabled={feed.isFetching || older.isPending} onClick={() => void loadOlder()}>
        {older.isPending ? 'Loading…' : selection ? 'More' : 'Load older Activities'}</Button> : null}
    </> : null}
  </section>
}

/** Consecutive identical rows (for example 20 finished shell commands) read as one row with a count. */
function groupRepeats(items: readonly RunActivityPublic[]) {
  const groups: { item: RunActivityPublic; count: number }[] = []
  const same = (a: RunActivityPublic, b: RunActivityPublic) => !a.ci && !b.ci && !a.workResult && !b.workResult && !a.usage && !b.usage
    && a.summary === b.summary && a.detail === b.detail && a.status === b.status && JSON.stringify(a.actor ?? a.subject) === JSON.stringify(b.actor ?? b.subject)
  for (const item of items) {
    const last = groups.at(-1)
    if (last && same(last.item, item)) last.count++
    else groups.push({ item, count: 1 })
  }
  return groups
}

const clock = (value: string) => {
  const date = new Date(value), today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : date.toLocaleString()
}

function ActivityRow({ item, count = 1, showActor = true }: { item: RunActivityPublic; count?: number; showActor?: boolean }) {
  const participant = item.actor ?? item.subject
  const label = participant ? 'agentId' in participant ? participant.agentName : `Job · ${participant.nodeName}` : 'Workflow'
  return <li data-severity={item.severity} data-status={item.status}><span className="board-activity-dot" aria-hidden="true" />
    <time dateTime={item.occurredAt} title={new Date(item.occurredAt).toLocaleString()}>{clock(item.occurredAt)}</time>
    <div>{showActor ? <strong>{label}</strong> : null}
      <div className="board-activity-line"><p>{item.summary}{count > 1 ? <span className="board-activity-count"> ×{count}</span> : null}</p>
        <span className={`board-activity-status is-${item.severity}`}>{item.status.replaceAll('_', ' ')}</span></div>
      {item.detail ? <p className="board-activity-detail">{item.detail}</p> : null}
      {item.ci ? <p className="board-activity-detail">
        {item.ci.part ? `${item.ci.part} · ` : ''}
        {item.ci.partition ? `Partition ${item.ci.partition.index + 1} of ${item.ci.partition.count} · ` : ''}
        {item.ci.computer?.label ?? (item.ci.state === 'queued' ? 'Waiting for a computer' : 'No computer assigned')}
        {item.ci.step ? ` · ${item.ci.step}` : ''}
        {item.ci.exitCode !== null ? ` · Exit code ${item.ci.exitCode}` : ''}
      </p> : null}
      {item.workResult ? <div className="board-activity-work-result">
        <p>Outcome: {item.workResult.outcome}</p>
        <strong>Result summary</strong>
        <pre>{typeof item.workResult.latestDeliverable === 'string'
          ? item.workResult.latestDeliverable : JSON.stringify(item.workResult.latestDeliverable, null, 2)}</pre>
        {item.workResult.remainingFindings.length ? <>
          <strong>Remaining findings</strong>
          <ul>{item.workResult.remainingFindings.map((finding, index) => <li key={index}>
            <pre>{typeof finding === 'string' ? finding : JSON.stringify(finding, null, 2)}</pre>
          </li>)}</ul>
        </> : <p>No remaining findings.</p>}
      </div> : null}
      {item.usage ? <small>{item.usage.used} used · {item.usage.limit === null ? 'no connection cap' : `${item.usage.limit} limit`}</small> : null}
    </div></li>
}
