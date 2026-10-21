import {
  CANONICAL_RUN_GRAPH_ROUTES, RepeatGraphCurrentV3Schema, RepeatGraphReadRequestV3Schema,
  canonicalGraphJson, sameCanonicalGraphScope, type RepeatGraphCurrentV3, type RepeatGraphScopeV3,
} from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'

/** v3 is not negotiated through, or coerced into, the legacy graph reader. */
export function repeatCurrentPath(scope: RepeatGraphScopeV3): string {
  const request = RepeatGraphReadRequestV3Schema.parse({ protocolVersion: 1, scope })
  const path = CANONICAL_RUN_GRAPH_ROUTES.current
    .replace(':workspaceId', encodeURIComponent(request.scope.workspaceId))
    .replace(':workflowId', encodeURIComponent(request.scope.workflowId))
    .replace(':runId', encodeURIComponent(request.scope.runId))
  return `${path}?${new URLSearchParams({ workflowVersionId: request.scope.workflowVersionId, executionSemanticsVersion: '3' })}`
}

export function assertRepeatCurrentProgress(previous: RepeatGraphCurrentV3 | undefined, next: RepeatGraphCurrentV3): void {
  if (!previous) return
  if (!sameCanonicalGraphScope(previous.scope, next.scope)
    || BigInt(next.asOfSequence) < BigInt(previous.asOfSequence)
    || canonicalGraphJson(previous.topology) !== canonicalGraphJson(next.topology)
    || previous.state.run.stopRequested && !next.state.run.stopRequested
    || previous.asOfSequence === next.asOfSequence && canonicalGraphJson(previous.state) !== canonicalGraphJson(next.state)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The canonical Run read changed immutable pins or regressed its complete cut.' })
  }
}

export function createRepeatGraphClient(client: ApiClient = apiClient) {
  return {
    async current(scope: RepeatGraphScopeV3, options?: RequestOptions): Promise<RepeatGraphCurrentV3> {
      const value = await client.request(repeatCurrentPath(scope), RepeatGraphCurrentV3Schema, options)
      // Check the envelope even when there are ZERO occurrence rows.
      if (!sameCanonicalGraphScope(value.scope, scope)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The canonical graph did not match the selected immutable Run/version.' })
      }
      return value
    },
  }
}
export type RepeatGraphClient = ReturnType<typeof createRepeatGraphClient>
export const repeatGraphClient = createRepeatGraphClient()
