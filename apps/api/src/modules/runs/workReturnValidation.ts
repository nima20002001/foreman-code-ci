import type { HarnessExecution, HarnessExecutionContext } from '@foreman-code/contracts'
import { WorkActivationInputSchema, WorkRequestSchema, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict, sameRepeatValue, type RepeatScope } from './repeatResolution.js'
import { parseWorkResultForInput } from './workHandoffResult.js'

export async function readParentWorkRequestLocked(context: { sql: GraphTransactionSql; scope: RepeatScope },
  activationId: string) {
  const row = (await context.sql.query<{ record: unknown }>(
    `select record from run_work_requests where run_id=$1
      and request_id=work_parent_request($1,$2) for share`,
    [context.scope.runId, activationId])).rows[0]
  if (!row) return undefined
  const request = WorkRequestSchema.parse(row.record)
  if (!sameRepeatValue(request.scope, context.scope)) return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  return request
}

/** Frozen continuation inputs can predate the saved parent-request field. */
export async function readWorkResultContextLocked(context: { sql: GraphTransactionSql; scope: RepeatScope },
  activationId: string, value: unknown): Promise<HarnessExecutionContext | undefined> {
  const input = WorkActivationInputSchema.parse(value)
  if (input.parentRequest || !['work_return', 'limit_denial'].includes(input.work.kind)) return undefined
  const request = await readParentWorkRequestLocked(context, activationId)
  return { parentRequest: request ? { requestId: request.requestId, requesterNodeId: request.requesterNodeId } : null }
}

export async function parseWorkResultLocked(context: { sql: GraphTransactionSql; scope: RepeatScope },
  execution: HarnessExecution, activationId: string) {
  const result = parseWorkHandoffResult(execution.result)
  if (result.routing.kind !== 'return') return result
  const executionContext = await readWorkResultContextLocked(context, activationId, execution.input)
  return parseWorkResultForInput(execution.result!, execution.input, executionContext)
}

/** Recheck the resolved request against persisted activation ancestry. */
export async function readWorkReturnRequestLocked(context: { sql: GraphTransactionSql; scope: RepeatScope },
  activationId: string, requestId: string | undefined) {
  if (requestId === undefined) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const row = (await context.sql.query<{ record: unknown; parent_id: string | null }>(
    `select record,work_parent_request($1,$3) as parent_id
      from run_work_requests where run_id=$1 and request_id=$2 for share`,
    [context.scope.runId, requestId, activationId])).rows[0]
  if (!row) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const request = WorkRequestSchema.parse(row.record)
  if (request.requestId !== requestId || !sameRepeatValue(request.scope, context.scope)
    || request.destinationActivationId !== activationId && row.parent_id !== requestId) {
    return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  }
  return request
}
