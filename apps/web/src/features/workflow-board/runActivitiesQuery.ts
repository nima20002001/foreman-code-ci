import type { ActivitySnapshotV1 } from '@foreman-code/contracts/activity'
import { reconcileActivitySnapshot } from '../conversations/agentChat/activityMerge'
import { RepeatGraphScopeV3Schema, RunActivitiesPageSchema, RUN_ACTIVITIES_RETAINED,
  type RunActivitiesPage, type RunActivityPublic } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

// A selected snapshot pins these four fields. Do not invent a URL semantics pin:
// the existing response schema independently verifies executionSemanticsVersion=3.
export type RunActivityScope = Pick<RunActivitiesPage['scope'], 'workspaceId' | 'workflowId' | 'runId' | 'workflowVersionId'>

export const runActivitiesKey = (scope: RunActivityScope, generation = sessionGeneration()) =>
  ['workbench', 'run-activities', generation, scope.workspaceId, scope.workflowId,
    scope.runId, scope.workflowVersionId, 3] as const

export function isTransientRunActivityError(error: unknown): boolean {
  if (!ApiError.is(error) || [401, 403, 404].includes(error.status) || error.code === 'INVALID_RESPONSE') return false
  return error.code === 'NETWORK_ERROR' || error.status === 408 || error.status === 429 || error.status >= 500
}

export async function readRunActivities(scope: RunActivityScope, cursor: string | null = null, options?: RequestOptions): Promise<RunActivitiesPage> {
  if ('executionSemanticsVersion' in scope) RepeatGraphScopeV3Schema.parse(scope)
  RunActivitiesPageSchema.shape.scope.omit({ executionSemanticsVersion: true }).parse({
    workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId,
  })
  const generation = sessionGeneration()
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  const page = await apiClient.request(`/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}`
    + `/runs/${encodeURIComponent(scope.runId)}/activities?${query}`, RunActivitiesPageSchema, options)
  if (page.scope.workspaceId !== scope.workspaceId || page.scope.workflowId !== scope.workflowId
    || page.scope.runId !== scope.runId || page.scope.workflowVersionId !== scope.workflowVersionId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Activities belong to a different Run or saved version.' })
  }
  const projection = page.activitySnapshot
  if (projection && (projection.scope.kind !== 'workflow_run' || projection.scope.runId !== scope.runId || projection.scope.workflowVersionId !== scope.workflowVersionId
    || projection.scope.workspaceId !== scope.workspaceId || projection.scope.workflowId !== scope.workflowId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Activity projection belongs to another Run.' })
  options?.signal?.throwIfAborted()
  assertSession(generation)
  return page
}

/** Server sequences are authoritative. Overlapping pages coalesce by that ID,
 * and the UI retains at most the same 1000 public rows as the service. */
export function mergeRunActivities(previous: readonly RunActivityPublic[], next: readonly RunActivityPublic[]): RunActivityPublic[] {
  const bySequence = new Map(previous.map((item) => [item.sequence, item]))
  for (const item of next) {
    const old = bySequence.get(item.sequence)
    if (old && old.id !== item.id) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Activities changed identity at a recorded sequence.' })
    bySequence.set(item.sequence, item)
  }
  return [...bySequence.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1).slice(-1000)
}

export type RunActivityFeed = {
  activitySnapshot?: ActivitySnapshotV1
  items: RunActivityPublic[]
  olderCursor: string | null
  nextCursor: string
  retainedFrom: string
  unchangedReads: number
}

/** Unchanged history backs off without fetching another Run lifecycle projection. */
export function runActivitiesRefetchInterval(feed?: RunActivityFeed): number {
  return Math.min(3000 * 2 ** (feed?.unchangedReads ?? 0), 60_000)
}

export function mergeOlderRunActivities(current: RunActivityFeed, page: RunActivitiesPage): RunActivityFeed {
  const retainedFrom = BigInt(current.retainedFrom) > BigInt(page.retainedFrom)
    ? current.retainedFrom : page.retainedFrom
  return {
    ...current,
    items: mergeRunActivities(current.items, page.items)
      .filter((item) => BigInt(item.sequence) >= BigInt(retainedFrom)),
    olderCursor: page.items[0] && BigInt(page.items[0].sequence) >= BigInt(retainedFrom) ? page.olderCursor : null,
    retainedFrom,
    unchangedReads: retainedFrom === current.retainedFrom ? current.unchangedReads : 0,
  }
}

/** A query refetch catches every new page through its frozen high-water mark.
 * A 410 is surfaced to the UI for an explicit resync, never silently skipped. */
export async function readRunActivityFeed(scope: RunActivityScope, previous?: RunActivityFeed,
  options?: RequestOptions): Promise<RunActivityFeed> {
  if (!previous) {
    const page = await readRunActivities(scope, null, options)
    const activitySnapshot = page.activitySnapshot
      ? reconcileActivitySnapshot(undefined, page.activitySnapshot, page.activitySnapshot.scope) : undefined
    return {
      ...(activitySnapshot ? { activitySnapshot } : {}),
      items: page.items,
      olderCursor: page.olderCursor,
      nextCursor: page.nextCursor,
      retainedFrom: page.retainedFrom,
      unchangedReads: 0,
    }
  }
  let cursor = previous.nextCursor
  let result = previous
  let changed = false
  for (let count = 0; count < RUN_ACTIVITIES_RETAINED; count++) {
    const page = await readRunActivities(scope, cursor, options)
    changed ||= page.items.length > 0 || page.retainedFrom !== previous.retainedFrom
      || page.nextCursor !== previous.nextCursor
    const activitySnapshot = page.activitySnapshot ? reconcileActivitySnapshot(result.activitySnapshot,
      page.activitySnapshot, result.activitySnapshot?.scope ?? page.activitySnapshot.scope) : result.activitySnapshot
    result = {
      ...(activitySnapshot ? { activitySnapshot } : {}),
      items: mergeRunActivities(result.items, page.items)
        .filter((item) => BigInt(item.sequence) >= BigInt(page.retainedFrom)),
      olderCursor: result.items[0] && BigInt(result.items[0].sequence) >= BigInt(page.retainedFrom)
        ? result.olderCursor : null,
      nextCursor: page.nextCursor,
      retainedFrom: page.retainedFrom,
      unchangedReads: 0,
    }
    cursor = page.nextCursor
    if (!page.hasMore) return { ...result, unchangedReads: changed ? 0 : Math.min(previous.unchangedReads + 1, 5) }
  }
  throw new ApiError({ code: 'ACTIVITIES_CATCHUP_TOO_LARGE', message: 'Activities changed faster than this page can safely catch up. Reload this Run.' })
}
