import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { readRepeatExecutionsLocked, type StoredRepeatExecution } from './repeatExecutionRead.js'
import { assertWorkflowNativeEntryRow, workflowNativeReservation, type NativeEntryRow } from './workflowNativeEntry.js'
import { sameRepeatValue } from './repeatResolution.js'
import { readWorkflowTerminalReceiptLocked } from './workflowTerminalReceipt.js'
import { assertSettlementLocked } from './repeatSettlementServices.js'
import { assertApprovalTerminalSettlement } from '../interactions/wave25/resume.js'
import { repeatNativePending } from '../interactions/repeatNativeEvidence.js'
import type { RunOwnership } from './ownership.js'

async function assertUnsubmitted(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
  executions: readonly StoredRepeatExecution[]): Promise<void> {
  if (!executions.length) return
  const rows = await sql.query<NativeEntryRow & { execution_id: string; launched: boolean }>(`
    select n.execution_id,n.phase,n.reservation,n.reservation_digest,n.transition,n.source_id,n.source_digest,
      exists(select 1 from run_graph_effects f where f.run_id=$1 and f.effect_kind='execution.launch'
        and f.entity_id=n.execution_id) as launched
    from workflow_native_entries n where n.run_id=$1 and n.execution_id=any($2::text[]) order by n.execution_id for update`,
  [run.id, executions.map(stored => stored.execution.id)])
  const entries = new Map(rows.rows.map(row => [row.execution_id, row]))
  const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 as const }
  for (const stored of executions) {
    const entry = assertWorkflowNativeEntryRow(entries.get(stored.execution.id),
      workflowNativeReservation(scope, stored.ref, stored.execution, stored.inputDigest))
    if (entry.phase !== 'reserved' || entry.transition !== null || entry.source_id !== null
      || entry.source_digest !== null || entries.get(stored.execution.id)!.launched
      || stored.execution.nativeSessionId || stored.accepted) return repeatNativePending()
  }
}

export async function assertRestartAttemptsLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
  owner: RunOwnership, retained: readonly string[]): Promise<void> {
  const ids = (await sql.query<{ id: string }>(
    'select id from harness_executions where run_id=$1 order by id for update', [run.id])).rows.map(row => row.id)
  const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
  const attempts = await readRepeatExecutionsLocked(sql, snapshot, ids)
  const queued = attempts.filter(stored => !retained.includes(stored.execution.id) && stored.execution.state === 'queued')
  const settled = attempts.filter(stored => !retained.includes(stored.execution.id) && stored.execution.state !== 'queued')
  for (const stored of settled) {
    if (stored.execution.result?.outcome === 'succeeded' && !stored.accepted) {
      await readWorkflowTerminalReceiptLocked(sql, snapshot, stored)
    }
  }
  await assertUnsubmitted(sql, run, queued)
  if (queued.length) beforeGraphCommit(sql, async () => {
    const final = await readAcceptedRepeatRunLocked(sql, run.id)
    const current = await readRepeatExecutionsLocked(sql, final, queued.map(stored => stored.execution.id))
    if (!sameRepeatValue(current, queued)) return repeatNativePending()
    await assertUnsubmitted(sql, run, current)
  })
  if (settled.length) {
    const settledIds = settled.map(stored => stored.execution.id)
    await assertSettlementLocked(sql, run, settledIds, owner)
    if (retained.length) {
      for (const id of settledIds) await assertApprovalTerminalSettlement(sql, run.id, id)
    }
  }
}
