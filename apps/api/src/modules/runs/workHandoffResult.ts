import type { ExecutionResult, HarnessExecutionContext } from '@foreman-code/contracts'
import { WorkActivationInputSchema, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { ZodError } from 'zod'

export function receivedWorkRequestIds(input: unknown, context?: HarnessExecutionContext): string[] {
  const { work, parentRequest } = WorkActivationInputSchema.parse(input)
  if (work.kind === 'work_request') return [work.request.requestId]
  if (work.kind === 'join') return work.sources.map(source => source.request.requestId)
  const continuation = work.kind === 'work_return' || work.kind === 'limit_denial'
  const caller = parentRequest ?? (continuation ? context?.parentRequest : undefined)
  return caller ? [caller.requestId] : []
}

/** Resolve received work without rewriting the original native result. */
export function parseWorkResultForInput(result: ExecutionResult, input?: unknown, context?: HarnessExecutionContext) {
  const parsed = parseWorkHandoffResult(result)
  if (parsed.routing.kind !== 'return' || input === undefined) return parsed
  const requestIds = receivedWorkRequestIds(input, context)
  const requestId = parsed.routing.requestId ?? (requestIds.length === 1 ? requestIds[0] : undefined)
  if (requestId === undefined || !requestIds.includes(requestId)) {
    const reason = parsed.routing.requestId === undefined
      ? 'Return requestId may be omitted only when exactly one received request is open.'
      : 'Return requestId must match an open received request.'
    throw new ZodError([{ code: 'custom', path: ['routing', 'requestId'],
      message: `${reason} Valid open request IDs: ${JSON.stringify(requestIds)}` }])
  }
  return { ...parsed, routing: { ...parsed.routing, requestId } }
}
