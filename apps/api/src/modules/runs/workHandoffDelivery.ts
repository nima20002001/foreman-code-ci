import { z } from 'zod'
import type { HarnessExecution } from '@foreman-code/contracts'
import {
  WorkReturnSchema, WorkNoticeSchema,
  canonicalGraphJson, type WorkHandoffResult, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict, repeatDigest, repeatId, type RepeatScope } from './repeatResolution.js'
import {
  availableWorkAlternativesLocked, createWorkLimitNotice, type WorkLimitNoticeInput,
} from './workHandoffNotice.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'
import { parseWorkResultLocked, readWorkReturnRequestLocked } from './workReturnValidation.js'

interface DeliveryContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3; now: string
}

async function assertDatabaseEnvelopeFits(sql: GraphTransactionSql, envelope: unknown): Promise<void> {
  // jsonb expands exponent numbers; measure with the same function as the persisted constraints.
  const result = await sql.query<{ bytes: number }>('select work_json_bytes($1::jsonb) as bytes',
    [canonicalGraphJson(envelope, 64 * 1024)])
  if (result.rows[0]!.bytes > 64 * 1024) return repeatConflict('WORK_HANDOFF_DELIVERY_TOO_LARGE')
}

async function assertNoticeFits(context: DeliveryContext, input: WorkLimitNoticeInput): Promise<void> {
  const alternatives = await availableWorkAlternativesLocked(context, input.requesterNodeId, input.relationshipId)
  const notice = createWorkLimitNotice(context, input, alternatives)
  // After acceptance counters can grow and an acknowledgement adds metadata.
  // Routes can only become exhausted; none can be added to the pinned workflow.
  const delivered = WorkNoticeSchema.parse({ ...notice, delivery: 'delivered', acknowledgementId: 'a'.repeat(200),
    alternatives: alternatives.map((item) => ({ ...item,
      used: item.maxWorkHandoffsPerRun === null ? 2147483647 : item.maxWorkHandoffsPerRun - 1,
    })) })
  await assertDatabaseEnvelopeFits(context.sql, delivered)
}

async function assertReturnFits(context: DeliveryContext, execution: HarnessExecution,
  activationId: string, result: WorkHandoffResult): Promise<void> {
  const routing = (await parseWorkResultLocked(context, execution, activationId)).routing
  if (routing.kind !== 'return') return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
  const request = await readWorkReturnRequestLocked(context, activationId, routing.requestId)
  if (request.destinationNodeId !== execution.workflowNodeId) return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  const returnId = repeatId('work-return', execution.id)
  const continuationActivationId = routing.outcome === 'needs_changes' ? repeatId('work-activation', 'returns', request.requesterActivationId) : undefined
  const returned = WorkReturnSchema.parse({ scope: context.scope, returnId, requestId: request.requestId,
    sourceActivationId: activationId, sourceExecutionId: execution.id,
    requesterActivationId: request.requesterActivationId,
    ...(continuationActivationId ? { continuationActivationId } : {}),
    acceptedResultDigest: repeatDigest(execution.result, 64 * 1024), outcome: routing.outcome,
    latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings,
    returnedAt: context.now })
  await assertDatabaseEnvelopeFits(context.sql, returned)
  const edge = context.version.definition.edges.find((item) => item.id === request.relationshipId)
  if (continuationActivationId && edge?.maxWorkHandoffsPerRun !== undefined) {
    await assertNoticeFits(context, { cause: { kind: 'last_return', returnId },
      requesterActivationId: request.requesterActivationId, requesterNodeId: request.requesterNodeId,
      continuationActivationId, relationshipId: request.relationshipId, destinationNodeId: request.destinationNodeId,
      used: edge.maxWorkHandoffsPerRun, maximum: edge.maxWorkHandoffsPerRun,
      latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings })
  }
}

/** Validate derived envelopes under the Run lock, before committing terminal acceptance. */
export async function assertWorkHandoffDeliveryLocked(context: DeliveryContext, execution: HarnessExecution,
  activationId: string, result: WorkHandoffResult): Promise<void> {
  try {
    if (result.routing.kind === 'return') return await assertReturnFits(context, execution, activationId, result)
    const routes = selectedWorkHandoffRoutes(context.version.definition, execution.workflowNodeId, result)
    for (const relationshipId of routes) {
      const edge = context.version.definition.edges.find((item) => item.id === relationshipId)
      if (!edge || edge.kind !== 'execution') return repeatConflict('WORK_REQUEST_ROUTE_FORBIDDEN')
      if (edge.maxWorkHandoffsPerRun === undefined) continue
      const destinationNodeId = edge.source === execution.workflowNodeId ? edge.target : edge.source
      const requestId = repeatId('work-request', context.scope.runId, execution.id, edge.id)
      const denialId = repeatId('work-denial', requestId)
      await assertNoticeFits(context, { cause: { kind: 'limit_denial', denialId },
        requesterActivationId: activationId, requesterNodeId: execution.workflowNodeId,
        continuationActivationId: repeatId('work-activation', denialId), relationshipId,
        destinationNodeId, used: edge.maxWorkHandoffsPerRun, maximum: edge.maxWorkHandoffsPerRun,
        latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings })
    }
  } catch (error) {
    if (error instanceof z.ZodError && error.issues.some((issue) =>
      issue.message === 'HANDOFF_RETURN_TOO_LARGE' || issue.message === 'HANDOFF_NOTICE_TOO_LARGE')) {
      return repeatConflict('WORK_HANDOFF_DELIVERY_TOO_LARGE')
    }
    throw error
  }
}
