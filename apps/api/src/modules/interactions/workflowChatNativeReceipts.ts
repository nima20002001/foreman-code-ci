import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { WorkflowNativeProofRecord } from '../runs/workflowNativeProof.js'
import { CONTROL_COMMAND_COLUMNS, captureWorkflowControlNativeLocked, markWorkflowControlCommandLocked,
  type ControlCommandRow } from '../collaboration/workflowControlRecords.js'
import type { WorkflowChatNativeTarget } from '../collaboration/workflowControlTypes.js'

/** Called only after the original-source verifier has checked its live writer,
 * persisted physical evidence and canonical publication on THIS transaction. */
export async function projectWorkflowChatNativeReceiptsLocked(sql: GraphTransactionSql,
  proof: WorkflowNativeProofRecord): Promise<void> {
  const providerId = proof.lane?.providerId
  if (!providerId || proof.original.type === 'session_created' || proof.original.type === 'boundary') return
  const terminal = proof.original.type === 'history' ? proof.original.history.terminalTurn : undefined
  const rows = (await sql.query<ControlCommandRow>(`select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands
    where run_id=$1 and state not in ('completed','failed','canceled') and (
      delivered_execution->>'executionId'=$2
      or target #>> '{execution,executionId}'=$2 and operation in ('steer','stop'))
    order by sequence`, [proof.scope.runId, proof.execution.executionId])).rows
  for (const row of rows) {
    const captured = row.native_target as WorkflowChatNativeTarget | null
    const delivered = row.delivered_execution as { executionId?: string } | null
    if (delivered?.executionId === proof.execution.executionId && row.kind === 'delivery') {
      if (row.state === 'accepted' && !terminal) continue
      if (!captured) await captureWorkflowControlNativeLocked(sql, {
        runId: row.run_id, commandId: row.id, now: proof.observedAt,
        nativeTarget: { nativeSessionId: proof.session.nativeSessionId, ownerRequestId: proof.commandId,
          ...(proof.session.harness === 'codex' ? { nativeTurnId: providerId } : { inputMessageId: providerId }),
          providerId, sessionMode: (row.request as { sessionMode?: 'regular' | 'plan' }).sessionMode ?? 'regular',
          steer: proof.session.harness === 'codex', interruptAndSend: true },
      })
      await markWorkflowControlCommandLocked(sql, { runId: row.run_id, commandId: row.id,
        state: terminal ? 'completed' : 'accepted',
        ...(proof.session.harness === 'codex' ? { nativeTurnId: providerId } : {}), now: proof.observedAt })
      continue
    }
    if (!captured || captured.nativeSessionId !== proof.session.nativeSessionId
      || captured.ownerRequestId !== proof.commandId
      || (captured.nativeTurnId ?? captured.inputMessageId) !== providerId || !terminal) continue
    // A pending continuation completes with its actual fixed successor. An
    // interrupt acknowledgement alone never completes that lineage.
    if (row.kind === 'stop' && !row.continuation_id || row.operation === 'steer' && row.state === 'accepted') {
      await markWorkflowControlCommandLocked(sql, { runId: row.run_id, commandId: row.id,
        state: 'completed', now: proof.observedAt })
    }
  }
}
