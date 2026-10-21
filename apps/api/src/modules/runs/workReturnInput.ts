import {
  AcceptedCurrentNodeResultSchema, WorkActivationInputSchema, WorkReturnSchema, canonicalGraphJson,
  type WorkActivationInput, type WorkReturn,
} from '@foreman-code/contracts/wave25'
import { frozenWorkNotice, readWorkLimitNoticeLocked } from './workHandoffNotice.js'
import { repeatConflict, repeatDigest, sameRepeatValue } from './repeatResolution.js'
import { workReturnGroupSettlementsLocked, type WorkReturnContext } from './workReturnContinuation.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'

export async function readWorkReturnFeedbackLocked(context: WorkReturnContext, returned: WorkReturn, nodeId: string) {
  const { sql, scope } = context
  const slot = (await sql.query<{ input_json: string }>(
    'select input_json from run_repeat_slots where run_id=$1 and work_activation_id=$2',
    [scope.runId, returned.continuationActivationId])).rows[0]
  const frozen = slot ? WorkActivationInputSchema.parse(JSON.parse(slot.input_json)).work : undefined
  if (frozen && frozen.kind !== 'work_return') return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  const legacyQueued = !frozen && (await sql.query(`select 1 from run_activity
    where run_id=$1 and kind='work_requester_reactivated' and payload->>'activationId'=$2
      and not (payload ? 'sourceActivationId')`, [scope.runId, returned.continuationActivationId])).rowCount === 1
  const grouped = frozen ? frozen.returns !== undefined : !legacyQueued
  const frozenReturnIds = frozen?.returns?.map(item => item.returned.returnId)
  const rows = (await sql.query<{ record: unknown; result_json: string; result_digest: string;
    requester_activation_id: string; destination_node_id: string }>(
    `select t.record,x.result_json,x.result_digest,q.requester_activation_id,q.destination_node_id from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      join run_work_results x on x.run_id=t.run_id and x.execution_id=t.source_execution_id
      where q.run_id=$1 and q.requester_node_id=$2 and (
        not $3 and t.return_id=$4
        or $3 and ($6::text[] is not null and t.return_id=any($6)
          or $6::text[] is null and (t.requester_continuation_activation_id=$5
            or t.outcome='accepted' and exists(select 1 from run_work_returns member
              join run_work_requests request on request.run_id=member.run_id and request.request_id=member.request_id
              where member.run_id=q.run_id and member.requester_continuation_activation_id=$5
                and request.requester_activation_id=q.requester_activation_id))))
      order by q.request_id`,
    [scope.runId, nodeId, grouped, returned.returnId,
      returned.continuationActivationId, frozenReturnIds ?? null])).rows
  const feedback: NonNullable<Extract<WorkActivationInput['work'], { kind: 'work_return' }>['returns']> = []
  for (const row of rows) {
    const value = WorkReturnSchema.parse(row.record)
    const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
    const response = parseWorkflowWorkResult(acceptedSourceResult, context.version,
      row.destination_node_id, context.hooks.run.resultProtocol)
    if (!sameRepeatValue(value.scope, scope) || value.requesterActivationId !== row.requester_activation_id
      || row.result_digest !== value.acceptedResultDigest
      || repeatDigest(acceptedSourceResult, 64 * 1024) !== row.result_digest
      || response.routing.kind !== 'return'
      || response.routing.requestId !== undefined && response.routing.requestId !== value.requestId
      || response.routing.outcome !== value.outcome
      || !sameRepeatValue(response.data.latestDeliverable, value.latestDeliverable)
      || !sameRepeatValue(response.data.remainingFindings, value.remainingFindings)) {
      return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
    }
    const noticeExists = (await sql.query(`select 1 from run_work_notices
      where run_id=$1 and cause_kind='last_return' and cause_id=$2`, [scope.runId, value.returnId])).rowCount === 1
    const notice = noticeExists ? frozenWorkNotice(await readWorkLimitNoticeLocked(context,
      { kind: 'last_return', returnId: value.returnId })) : undefined
    feedback.push({ returned: value, acceptedSourceResult, ...(notice ? { notice } : {}) })
  }
  const primary = feedback.find(item => item.returned.returnId === returned.returnId)
  if (!primary || canonicalGraphJson(primary.returned) !== canonicalGraphJson(returned)) {
    return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
  }
  // Bound inputs keep their saved single-return shape when read after an upgrade.
  if (!grouped) return primary
  const settled = await workReturnGroupSettlementsLocked(context, returned.continuationActivationId!)
  if (settled.pending) return repeatConflict('WORK_RETURN_PENDING')
  return { ...primary, returns: feedback, failures: settled.failures }
}
