import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict } from './repeatResolution.js'

/** Call while holding the Run lock. Starting an unissued activation consumes
 * its reservation; retries and new activations require additional capacity,
 * except that an attempt abandoned for an infrastructure cause (a recorded
 * retryable failure) gives its capacity to its replacement.
 * Interval checks are bounded by their interval and the Run's lifetime, not this budget. */
export async function hasWorkflowExecutionCapacityLocked(sql: GraphTransactionSql, runId: string,
  version: WorkflowVersionV3, activationId: string | null = null, additionalExecutions = 1,
  controlContinuationId: string | null = null): Promise<boolean> {
  assertGraphTransaction(sql)
  if (!Number.isSafeInteger(additionalExecutions) || additionalExecutions < 1) {
    return repeatConflict('REPEAT_EXECUTION_BUDGET_INVALID')
  }
  const maximum = version.definition.executionPolicy!.maxNodeExecutions
  const row = (await sql.query<{ total: string }>(`select (
    (select count(*) from harness_executions e where e.run_id=$1 and e.record #> '{input,tick}' is null
      and not exists (select 1 from workflow_native_entries n
        where n.execution_id=e.id and n.run_id=e.run_id and n.phase='not_submitted')
      and not exists (select 1 from approval_execution_state b
        where b.execution_id=e.id and b.failure_result->'error'->>'retryable'='true'))
    + (select count(*) from run_repeat_executions where run_id=$1 and identity->>'kind'='job')
    + (select count(*) from workflow_job_preparations p where p.run_id=$1
      and not exists (select 1 from run_repeat_executions e
        where e.run_id=p.run_id and e.slot_id=p.slot_id))
    + (select count(*) from run_work_activations a where a.run_id=$1
      and a.state in ('queued','waiting','running')
      and ($2::text is null or a.activation_id<>$2)
      and not exists (select 1 from harness_executions e
        where e.run_id=a.run_id and e.work_activation_id=a.activation_id))
    + (select count(*) from run_control_continuations c where c.run_id=$1
      and c.state in ('reserved','waiting_settlement','unknown')
      and ($3::text is null or c.id<>$3)
      and not exists (select 1 from harness_executions e where e.id=c.reserved_successor_execution_id))
    )::text as total`, [runId, activationId, controlContinuationId])).rows[0]
  if (!row || !/^[0-9]+$/.test(row.total)) return repeatConflict('REPEAT_EXECUTION_BUDGET_INVALID')
  return BigInt(row.total) + BigInt(additionalExecutions) <= BigInt(maximum)
}

export async function assertWorkflowExecutionCapacityLocked(sql: GraphTransactionSql, runId: string,
  version: WorkflowVersionV3, activationId: string | null = null, additionalExecutions = 1,
  controlContinuationId: string | null = null): Promise<void> {
  if (!await hasWorkflowExecutionCapacityLocked(sql, runId, version, activationId, additionalExecutions, controlContinuationId)) {
    if (version.definition.handoffs) {
      throw new DomainError('WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
        'The Run reached its execution limit and cannot start more work.', 409)
    }
    return repeatConflict('REPEAT_EXECUTION_BUDGET_EXHAUSTED')
  }
}
