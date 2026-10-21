import type { InfiniteData } from '@tanstack/react-query'
import type { OperatorActivity, OperatorActivityPage, OperatorConversationState } from '@foreman-code/contracts'
import { getOperatorActivity, mergeOperatorActivity } from '../../shared/api/operatorActivity'

export type OperatorActivityHistory = InfiniteData<OperatorActivityPage, string | undefined>

/** Chronological windows can omit a previously observed item after it finishes. */
export async function readObservedOperatorActivity(current: OperatorConversationState | undefined,
  incoming: OperatorConversationState, history: OperatorActivityHistory | undefined, signal: AbortSignal) {
  const observed = mergeOperatorActivity(current?.activities ?? [],
    ...(history?.pages.map(page => page.activities) ?? []))
  const recent = new Map(incoming.activities?.map(item => [`${item.requestId}:${item.id}`, item]))
  const mutable = observed.filter(item => ['pending', 'running'].includes(item.status)
    && (recent.get(`${item.requestId}:${item.id}`)?.revision ?? 0) <= item.revision)
  const pages = await Promise.all(mutable.map(item => getOperatorActivity(incoming.conversation.id, {
    requestId: item.requestId, activityId: item.id, limit: 1,
  }, { signal })))
  signal.throwIfAborted()
  return pages.flatMap(page => page.activities)
}

export function updateObservedOperatorActivity(history: OperatorActivityHistory | undefined, updates: OperatorActivity[]) {
  if (!history) return history
  return { ...history, pages: history.pages.map(page => {
    const keys = new Set(page.activities.map(item => `${item.requestId}:${item.id}`))
    return { ...page, activities: mergeOperatorActivity(page.activities,
      updates.filter(item => keys.has(`${item.requestId}:${item.id}`))) }
  }) }
}
