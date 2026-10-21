import { ChatDeliveryReceiptSchema } from '@foreman-code/contracts'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { CONTROL_COMMAND_SUMMARY_COLUMNS, updateControlCommand, type ControlCommandSummary } from './workflowControlRecords.js'

/** The existing owner closes queued input after final acceptance or proven
 * negative settlement. Native success alone does not close an unaccepted work. */
export async function closeWorkflowControlInputLocked(sql:GraphTransactionSql,
  input:{runId:string;executionId:string;now:string}):Promise<void> {
  assertGraphTransaction(sql)
  const rows=(await sql.query<ControlCommandSummary>(`with recursive lineage(id) as (
      select $2::text union select k.previous_execution_id from run_control_continuations k
      join lineage l on l.id=k.successor_execution_id where k.run_id=$1 and k.successor_execution_id is not null
    ) select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands c
    where c.run_id=$1 and c.kind='delivery' and c.state='queued'
      and c.target #>> '{execution,executionId}' in (select id from lineage) order by c.sequence`,[input.runId,input.executionId])).rows
  for(const row of rows) await updateControlCommand(sql,row,{
    ...ChatDeliveryReceiptSchema.parse(row.receipt),state:'failed',errorCode:'TARGET_SETTLED',updatedAt:input.now,
  },input.now)
}
