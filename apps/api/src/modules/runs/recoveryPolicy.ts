import type { TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

/** Called under the existing workspace admission lock by both start services. */
export async function assertWorkflowRecovered(client: TransactionSql, workspaceId: string, workflowId: string): Promise<void> {
  const blocked = await client.query(
    `select 1 from runs r where r.workspace_id=$1 and r.workflow_id=$2
       and (r.execution_state='interrupted' or exists (
         select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)) limit 1`,
    [workspaceId, workflowId],
  )
  if (blocked.rowCount) throw new DomainError('RUN_RECOVERY_REQUIRED',
    'Stop the interrupted Run and finish native cleanup before starting this workflow again.', 409)
}
