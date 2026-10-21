import { OperatorActivityPageSchema, OperatorActivityQuerySchema, type OperatorActivity, type OperatorActivityQuery } from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from './client'

export function getOperatorActivity(conversationId: string, query: Partial<OperatorActivityQuery> = {}, options?: RequestOptions) {
  const input = OperatorActivityQuerySchema.parse(query)
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.before) params.set('before', input.before)
  if (input.requestId) params.set('requestId', input.requestId)
  if (input.activityId) params.set('activityId', input.activityId)
  return apiClient.request(`/api/operator/conversations/${encodeURIComponent(conversationId)}/activity?${params}`, OperatorActivityPageSchema, options)
}

/** Merge accepted server projections without letting late polls regress an item. */
export function mergeOperatorActivity(...sources: readonly (readonly OperatorActivity[])[]): OperatorActivity[] {
  const entries = new Map<string, OperatorActivity>()
  for (const source of sources) for (const entry of source) {
    const key = `${entry.requestId}:${entry.id}`
    const prior = entries.get(key)
    if (!prior || entry.revision > prior.revision) entries.set(key, entry)
  }
  return [...entries.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
}

/** Keep the newest contiguous suffix; older records remain available from its server sequence. */
export function retainRecentOperatorActivity(entries: OperatorActivity[]) {
  const encoder = new TextEncoder()
  let bytes = 2
  let start = entries.length
  while (start > 0 && entries.length - start < 100) {
    const size = encoder.encode(JSON.stringify(entries[start - 1])).byteLength + (start < entries.length ? 1 : 0)
    if (bytes + size > 256 * 1024) break
    bytes += size
    start -= 1
  }
  return { activities: entries.slice(start), removed: start > 0 }
}
