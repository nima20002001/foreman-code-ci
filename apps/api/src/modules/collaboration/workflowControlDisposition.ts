import { ChatSendRequestSchema, WorkflowControlContinuationSchema } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { readControlCommand } from './workflowControlRecords.js'
import type { WorkflowControlDisposition } from './workflowControlTypes.js'

/** Consult BEFORE native effects, negative settlement, acceptance or parent returns.
 * Retained reservations fence late callbacks even after failure or Stop Run. */
export async function readWorkflowControlDispositionLocked(sql: GraphTransactionSql,
  runId: string, executionId: string): Promise<WorkflowControlDisposition> {
  assertGraphTransaction(sql)
  const row = (await sql.query<{ record: unknown; reserved_successor_execution_id: string; delivery_id: string }>(
    `select record,reserved_successor_execution_id,delivery_id from run_control_continuations
      where run_id=$1 and previous_execution_id=$2`, [runId, executionId])).rows[0]
  if (row) {
    const command = await readControlCommand(sql, row.delivery_id)
    if (!command) throw new DomainError('CONTROL_RECEIPT_CONFLICT', 'The continuation has no admitted delivery.', 409)
    return { kind: 'superseded', continuation: WorkflowControlContinuationSchema.parse(row.record),
      reservedSuccessorExecutionId: row.reserved_successor_execution_id, request: ChatSendRequestSchema.parse(command.request) }
  }
  // Physical closure completes the receipt before logical settlement. A completed
  // Stop still fences a racing native success for this exact execution forever.
  const stop = (await sql.query<{ id: string }>(`select id from run_chat_commands where run_id=$1 and kind='stop'
    and target #>> '{execution,executionId}'=$2 and state in ('recorded','settling','submitting','accepted','completed','unknown')
    and native_target is not null
    order by sequence limit 1`, [runId, executionId])).rows[0]
  return stop ? { kind: 'stopping', commandId: stop.id } : { kind: 'ordinary' }
}
