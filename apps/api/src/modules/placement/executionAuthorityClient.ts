import { ExecutionFactsRequestSchema, ExecutionFactsResultSchema, ExecutionAuthorityRequestSchema, ExecutionAuthorityResultSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { DomainError } from '../errors.js'
import type { RemoteReviewerRequest, RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
const denied = (): never => { throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Exact original execution authority is unavailable or revoked.', 403) }
/** Worker composition supplies the established W07 channel request, not fetch to
 * a public HTTP route. The main's response carries correlation, never a permit. */
export function workerExecutionAuthorizer(request: (namespace: string, payload: unknown, options?: { signal?: AbortSignal }) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, action: 'start' | 'read' | 'control' | 'stop',
    signal?: AbortSignal, workflowControl?: RemoteOwnerControl) => {
    const input = ExecutionAuthorityRequestSchema.parse({ version: 1, intent, placement, action,
      ...(workflowControl ? { workflowControl } : {}) })
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input, signal ? { signal } : undefined)
    if (reply.bytes?.byteLength) denied()
    const { cleanupOnly, ...result } = ExecutionAuthorityResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result, { version: 1, action, operationId: intent.operationId, attemptId: intent.attemptId,
      bindingHash: intent.bindingHash, owner: intent.owner,
      ...(workflowControl ? { workflowControlCommandId: workflowControl.commandId } : {}) })
      || cleanupOnly && action !== 'read' && action !== 'stop') denied()
    return cleanupOnly ? { cleanupOnly: true as const } : undefined
  }
}

export function workerReviewerAuthorizer(request: (namespace: string, payload: unknown) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, review?: RemoteReviewerRequest) => {
    const action = review ? 'review' : 'retain-reviewer'
    const input = ExecutionAuthorityRequestSchema.parse({ version: 1, intent, placement, action,
      ...(review ? { review } : {}) })
    let reply: Awaited<ReturnType<typeof request>>
    try {
      reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input)
    } catch (error) {
      if (review) throw error
      // Main can commit Stop before the worker records its local Stop fence.
      const authority = await workerExecutionAuthorizer(request)(intent, placement, 'read')
      if (authority?.cleanupOnly) return undefined
      throw error
    }
    if (reply.bytes?.byteLength) denied()
    const { reviewer, ...result } = ExecutionAuthorityResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result, { version: 1, action, operationId: intent.operationId,
      attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner })) denied()
    return reviewer
  }
}

export function workerExecutionFactsReader(request: (namespace: string, payload: unknown, options?: { signal?: AbortSignal }) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (intent: DispatchIntent, placement: AcceptedNodePlacement, signal?: AbortSignal) => {
    const input = ExecutionFactsRequestSchema.parse({ method: 'read-facts', authorization: { version: 1, action: 'read', intent, placement } })
    const reply = await request(EXECUTION_AUTHORITY_EXTENSION.namespace, input, signal ? { signal } : undefined)
    if (reply.bytes?.byteLength) denied()
    const result = ExecutionFactsResultSchema.parse(reply.payload)
    if (!sameWorkflowValue(result.intent, intent) || !sameWorkflowValue(result.placement, placement)
      || result.executionPlacement.executionId !== intent.executionId || result.executionPlacement.attemptId !== intent.attemptId
      || result.executionPlacement.operationId !== intent.operationId || result.executionPlacement.acceptedBindingHash !== intent.bindingHash) denied()
    return result
  }
}
