import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentChatContext, AgentChatExecutionActivityPage, AgentChatExecutionItem, AgentChatExecutionSummary,
} from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { agentChatContextKey } from './model'
import { useExecutionActivityReads, type ActivityRead } from './executionActivityReads'

/** A bounded live window and one explicitly requested history page in the Query cache. */
export interface ExecutionActivityFeed {
  executions: AgentChatExecutionSummary[]
  hasEarlierExecutions: boolean
  items: AgentChatExecutionItem[]
  /** Start of each contiguous live window, independent of updated older entries. */
  before: Record<string, string | undefined>
  history?: ExecutionActivityHistory
  cursor?: string
  hasMoreChanges: boolean
}

interface ExecutionActivityHistory {
  executionId: string
  items: AgentChatExecutionItem[]
  before?: string
  hasEarlierItems: boolean
}

const ITEM_LIMIT = 200
const BYTE_LIMIT = 256 * 1024
const encoder = new TextEncoder()
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'interrupted'])
export const executionIsLive = (execution: AgentChatExecutionSummary) => !TERMINAL.has(execution.state)
const itemKey = (item: AgentChatExecutionItem) => JSON.stringify([item.executionId, item.id])

function keepsExpandedDetails(existing: AgentChatExecutionItem, incoming: AgentChatExecutionItem) {
  if (existing.entry.kind === 'message' && incoming.entry.kind === 'message') {
    const full = existing.entry.message
    const preview = incoming.entry.message
    if (!full.truncation?.truncated && preview.truncation?.truncated) return true
    if (full.truncation?.truncated && !preview.truncation?.truncated) return false
    return full.content.length > preview.content.length
  }
  if (existing.entry.kind !== 'activity' || incoming.entry.kind !== 'activity') return false
  const full = existing.entry.activity
  const preview = incoming.entry.activity
  if (!full.truncated && preview.truncated) return true
  if (full.truncated && !preview.truncated) return false
  return (full.input?.length ?? 0) + (full.output?.length ?? 0)
    > (preview.input?.length ?? 0) + (preview.output?.length ?? 0)
}

function upsertItems(previous: AgentChatExecutionItem[], incoming: AgentChatExecutionItem[]) {
  const items = new Map(previous.map(item => [itemKey(item), item]))
  for (const item of incoming) {
    const existing = items.get(itemKey(item))
    if (existing) {
      const revision = BigInt(item.revision) - BigInt(existing.revision)
      if (revision < 0 || revision === 0n && keepsExpandedDetails(existing, item)) continue
    }
    items.set(itemKey(item), item)
  }
  return [...items.values()]
}

function updateItems(previous: AgentChatExecutionItem[], incoming: AgentChatExecutionItem[]) {
  const retained = new Set(previous.map(itemKey))
  return upsertItems(previous, incoming.filter(item => retained.has(itemKey(item))))
}

function retainItems(items: AgentChatExecutionItem[]) {
  let bytes = 0
  let start = items.length
  while (start > 0 && items.length - start < ITEM_LIMIT) {
    const size = encoder.encode(JSON.stringify(items[start - 1])).byteLength
    if (bytes + size > BYTE_LIMIT) break
    bytes += size
    start -= 1
  }
  return { items: items.slice(start), removed: items.slice(0, start) }
}

function firstSequence(items: AgentChatExecutionItem[], executionId: string) {
  return items.find(item => item.executionId === executionId)?.sequence
}

function historyBoundary(feed: ExecutionActivityFeed | undefined, executionId: string) {
  if (feed?.history?.executionId === executionId) return feed.history.before
  return feed?.before[executionId]
}

function mergeHistory(previous: ExecutionActivityFeed | undefined, page: AgentChatExecutionActivityPage,
  read: ActivityRead | undefined): ExecutionActivityHistory | undefined {
  const history = previous?.history
  const canReplace = page.mode === 'earlier' && read && page.items.length > 0
  if (canReplace) {
    const cached = [...(previous?.items ?? []), ...(history?.items ?? [])]
    const incoming = page.items.filter(item => item.executionId === read.executionId)
    const identities = new Set(incoming.map(itemKey))
    const retained = retainItems(upsertItems(incoming, cached.filter(item => identities.has(itemKey(item)))))
    return {
      executionId: read.executionId,
      items: retained.items,
      before: firstSequence(retained.items, read.executionId),
      hasEarlierItems: retained.removed.length > 0
        || page.executions.find(execution => execution.executionId === read.executionId)?.hasEarlierItems === true,
    }
  }
  if (!history) return undefined
  const retained = retainItems(updateItems(history.items, page.items))
  const hasReachedStart = page.mode === 'earlier' && read?.executionId === history.executionId
    && read.before === history.before && page.items.length === 0
  return {
    ...history,
    items: retained.items,
    before: firstSequence(retained.items, history.executionId),
    hasEarlierItems: !hasReachedStart && (history.hasEarlierItems || retained.removed.length > 0),
  }
}

function mergeWindows(previous: ExecutionActivityFeed | undefined, page: AgentChatExecutionActivityPage,
  executions: AgentChatExecutionSummary[], items: AgentChatExecutionItem[],
  retained: ReturnType<typeof retainItems>, read: ActivityRead | undefined) {
  const before: ExecutionActivityFeed['before'] = {}
  for (const execution of executions) {
    const initial = page.mode === 'snapshot'
      || !previous?.executions.some(known => known.executionId === execution.executionId)
    before[execution.executionId] = initial ? firstSequence(items, execution.executionId)
      : previous?.before[execution.executionId]
    if (before[execution.executionId] === undefined && !execution.hasEarlierItems) {
      before[execution.executionId] = firstSequence(items, execution.executionId)
    }
  }
  const summaries = executions.map(execution => {
    const removed = retained.removed.filter(item => item.executionId === execution.executionId)
    const start = before[execution.executionId]
    if (removed.some(item => start === undefined || BigInt(item.sequence) >= BigInt(start))) {
      before[execution.executionId] = firstSequence(retained.items.filter(item =>
        start === undefined || BigInt(item.sequence) >= BigInt(start)), execution.executionId)
    }
    const exhausted = page.mode === 'earlier' && read?.executionId === execution.executionId
      && read.before === before[execution.executionId] && previous?.history?.executionId !== execution.executionId
      && page.items.length === 0
    if (exhausted) return { ...execution, hasEarlierItems: false }
    return removed.length ? { ...execution, hasEarlierItems: true } : execution
  })
  return { executions: summaries, before }
}

/** Detail reads update entries; only live reads replace execution metadata and the incremental cursor. */
export function mergeExecutionActivity(previous: ExecutionActivityFeed | undefined,
  page: AgentChatExecutionActivityPage, read?: ActivityRead): ExecutionActivityFeed {
  const detail = page.mode === 'earlier' || page.mode === 'item'
  const known = new Map(previous?.executions.map(execution => [execution.executionId, execution]))
  const executions = detail && previous ? previous.executions : page.executions.map(execution => {
    const earlier = known.get(execution.executionId)?.hasEarlierItems
    if (page.mode === 'changes' && earlier !== undefined) return { ...execution, hasEarlierItems: earlier }
    return execution
  })
  const order = new Map(executions.map((execution, index) => [execution.executionId, index]))
  let items = detail ? updateItems(previous?.items ?? [], page.items)
    : upsertItems(previous?.items ?? [], page.items)
  if (page.mode === 'snapshot') {
    const incomingIds = new Set(page.items.map(itemKey))
    items = items.filter(item => incomingIds.has(itemKey(item)))
  }
  items = items.filter(item => order.has(item.executionId)).sort((a, b) =>
    order.get(a.executionId)! - order.get(b.executionId)! || Number(BigInt(a.sequence) - BigInt(b.sequence)))
  const retained = retainItems(items)
  const windows = mergeWindows(previous, page, executions, items, retained, read)
  const history = mergeHistory(previous, page, read)
  const cursor = detail ? previous?.cursor : page.cursor
  return {
    ...windows,
    hasEarlierExecutions: detail && previous ? previous.hasEarlierExecutions : page.hasEarlierExecutions,
    items: retained.items,
    ...(history && order.has(history.executionId) ? { history } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    hasMoreChanges: detail ? previous?.hasMoreChanges ?? false : page.hasMoreChanges,
  }
}

/** Polls about once a second while an execution works; slower once every execution has finished. */
export function useExecutionActivity(context: AgentChatContext) {
  const client = useQueryClient()
  const key = useMemo(() => ['agent-chat', sessionGeneration(), agentChatContextKey(context), 'execution-activity'] as const, [context])
  const query = useQuery({
    queryKey: key, enabled: !!context.runId, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const cursor = client.getQueryData<ExecutionActivityFeed>(key)?.cursor
      const page = await agentChatApi.executionActivity(context, cursor ? { cursor } : {}, { signal })
      // Merge into the latest cache, which earlier-page and expand reads may have changed meanwhile.
      return mergeExecutionActivity(client.getQueryData<ExecutionActivityFeed>(key), page)
    },
    refetchInterval: (current) => {
      const data = current.state.data
      if (data?.hasMoreChanges) return 100
      return !data || data.executions.some(executionIsLive) ? 1_000 : 10_000
    },
  })
  const reads = useExecutionActivityReads(context, key, mergeExecutionActivity)
  return {
    query,
    readState: reads.readState,
    loadEarlier: (executionId: string) => {
      const before = historyBoundary(client.getQueryData<ExecutionActivityFeed>(key), executionId)
      return reads.read({ executionId, ...(before !== undefined ? { before } : {}) })
    },
    expand: (executionId: string, itemId: string) => reads.read({ executionId, itemId }),
    backToLatest: () => {
      reads.abandonHistory()
      client.setQueryData<ExecutionActivityFeed>(key, previous => {
        if (!previous) return previous
        const live = { ...previous }
        delete live.history
        return live
      })
    },
  }
}
