import type { HarnessExecution, HarnessExecutionContext, ResultProtocol } from '@foreman-code/contracts'
import { WorkActivationInputSchema, WorkRequestSchema, parseWorkHandoffResult, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict, sameRepeatValue, type RepeatScope } from './repeatResolution.js'
import { parseWorkResultForInput, resolveWorkResultForInput } from './workHandoffResult.js'
import { isHierarchyWorkflow, parseHierarchyWorkResult } from './hierarchyResults.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'

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
  activationId: string, value: unknown, resultProtocol?: ResultProtocol): Promise<HarnessExecutionContext | undefined> {
  const input = WorkActivationInputSchema.parse(value)
  if (resultProtocol) {
    const request = input.parentRequest ?? await readParentWorkRequestLocked(context, activationId)
    const pending = (await context.sql.query<{ request_id: string }>(
      `select m.request_id from run_hierarchy_group_members m
        where m.run_id=$1 and m.failure_execution_id is null
          and not exists(select 1 from run_work_returns t where t.run_id=m.run_id and t.request_id=m.request_id)
        order by m.request_id limit 1001`, [context.scope.runId])).rows
    if (pending.length > 1000) return repeatConflict('HIERARCHY_CONTEXT_TOO_LARGE')
    return { parentRequest: request ? { requestId: request.requestId, requesterNodeId: request.requesterNodeId } : null,
      outstandingRequestIds: pending.map(row => row.request_id) }
  }
  if (input.parentRequest || !['work_return', 'limit_denial', 'hierarchy_group'].includes(input.work.kind)) return undefined
  const request = await readParentWorkRequestLocked(context, activationId)
  return { parentRequest: request ? { requestId: request.requestId, requesterNodeId: request.requesterNodeId } : null }
}

export async function parseWorkResultLocked(context: { sql: GraphTransactionSql; scope: RepeatScope;
  version?: WorkflowVersionV3; hooks?: Pick<RepeatLockedHooks, 'run'> },
  execution: HarnessExecution, activationId: string) {
  if (context.version && isHierarchyWorkflow(context.version)) {
    const result = parseHierarchyWorkResult(execution.result, context.version, execution.workflowNodeId,
      context.hooks?.run.resultProtocol)
    const executionContext = await readWorkResultContextLocked(context, activationId, execution.input,
      context.hooks?.run.resultProtocol)
    const resolved = resolveWorkResultForInput(result, execution.input, executionContext)
    if (resolved.routing.kind === 'finish') {
      if (await readParentWorkRequestLocked(context, activationId)) return repeatConflict('HIERARCHY_RETURN_REQUIRED')
      const pending = await context.sql.query(`select 1 from run_hierarchy_groups
        where run_id=$1 and state in ('waiting','ready') limit 1`, [context.scope.runId])
      if (pending.rowCount) return repeatConflict('HIERARCHY_WORK_UNRESOLVED')
    }
    return resolved
  }
  if (context.version && context.hooks?.run.resultProtocol) {
    const executionContext = await readWorkResultContextLocked(context, activationId, execution.input)
    return parseWorkflowWorkResult(execution.result!, context.version, execution.workflowNodeId,
      context.hooks.run.resultProtocol, execution.input, executionContext)
  }
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
