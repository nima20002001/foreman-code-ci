import {
  OperatorRunCompactSchema, OperatorRunSummarySchema, OperatorExecutionSummarySchema,
} from '@foreman-code/contracts/operator-mcp'
import type { SavedRunDetails } from '@foreman-code/contracts/wave25'

export function compactRunDetails(details: SavedRunDetails) {
  const activities = [...(details.activitySnapshot?.activities ?? [])]
    .sort((left, right) => {
      const time = (left.source.observedAt ?? '').localeCompare(right.source.observedAt ?? '')
      if (time) return time
      const leftOrder = BigInt(left.order)
      const rightOrder = BigInt(right.order)
      if (leftOrder < rightOrder) return -1
      if (leftOrder > rightOrder) return 1
      return 0
    })
  const recent = activities.slice(-25)
  return OperatorRunCompactSchema.parse({
    detail: 'compact',
    ...(details.worktrees ? { worktrees: details.worktrees.slice(-25) } : {}),
    detailsOmitted: true,
    run: OperatorRunSummarySchema.parse({ ...details.run, failure: details.run.result?.error }),
    executions: details.executions.slice(-25).map(execution => OperatorExecutionSummarySchema.parse({
      ...execution, failure: execution.result?.error,
      continuedFromExecutionId: execution.sessionContinuation?.previousExecutionId,
    })),
    activities: recent.map(item => {
      let title: string = item.kind
      if ('title' in item) title = item.title
      else if ('message' in item) title = item.message
      return {
        id: item.id,
        kind: item.kind,
        title: title.slice(0, 256),
        ...('status' in item ? { status: item.status } : {}),
        order: item.order,
      }
    }),
    executionsOmitted: Math.max(0, details.executions.length - 25),
    activitiesOmitted: activities.length - recent.length,
    activitiesHasMore: activities.length > recent.length || details.activitySnapshot?.page.hasMore === true,
    ...(details.cleanupPending === undefined ? {} : { cleanupPending: details.cleanupPending }),
  })
}
