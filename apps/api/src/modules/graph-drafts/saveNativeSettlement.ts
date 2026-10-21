import { ZodError } from 'zod'
import { HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { RepeatOccurrenceV1Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { readExecutionPlacement, readNativePlacement } from '../placement/persistence.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readWorkflowClosure, readUnboundWorkflowClosure } from '../interactions/workflowClosure.js'
import { assertRepeatNativeClosure } from '../interactions/repeatNativeEvidence.js'
import { readWorkflowNativeEntry, readWorkflowNativeNotSubmitted, workflowNativeReservation } from '../runs/workflowNativeEntry.js'
import { assertRepeatExecution, assertRepeatScope, repeatDigest, type RepeatNodeRef, type RepeatScope } from '../runs/repeatResolution.js'

const PAGE_SIZE = 16

interface ExecutionRow {
  id: string; run_id: string; workflow_node_id: string; agent_id: string; attempt: number
  record: unknown; repeat_occurrence_id: string | null; occurrence_record: unknown | null
  native_reference: unknown | null
}

/** Read-only native proof facet of Save/Stop-and-save. The caller holds every
 * affected parent Run row until its transaction ends, and separately checks
 * terminal state, finalization, credentials, approvals and review obligations.
 * This performs no recovery, disposal, seal, acknowledgement or native I/O.
 * A launch reservation alone, terminal enum, or absent registry is never proof.
 */
export async function hasSaveNativeSettlement(sql: GraphSqlClient, scope: RepeatScope,
  version: WorkflowVersionV3): Promise<boolean> {
  try {
    assertRepeatScope(version, scope)
    let after = ''
    for (;;) {
      // Bound the private payload working set, not the affected history. Every
      // attempt/occurrence is visited, including those that never got a session.
      const rows = (await sql.query<ExecutionRow>(`select e.id,e.run_id,e.workflow_node_id,e.agent_id,e.attempt,e.record,
          e.repeat_occurrence_id,o.record as occurrence_record,s.reference as native_reference
        from harness_executions e
        left join run_repeat_occurrences o on o.occurrence_id=e.repeat_occurrence_id and o.run_id=e.run_id
        left join execution_native_sessions s on s.execution_id=e.id
        where e.run_id=$1 and e.id>$2 order by e.id limit ${PAGE_SIZE}`, [scope.runId, after])).rows
      for (const row of rows) {
        const execution = HarnessExecutionSchema.parse(row.record)
        if (row.id !== execution.id || row.id === after || row.run_id !== scope.runId || execution.runId !== scope.runId
          || row.workflow_node_id !== execution.workflowNodeId || row.agent_id !== execution.agentId || row.attempt !== execution.attempt
          || execution.state !== 'completed' || !execution.result || !execution.finishedAt) return false
        const occurrence = row.repeat_occurrence_id === null ? null : RepeatOccurrenceV1Schema.parse(row.occurrence_record).identity
        if ((occurrence?.occurrenceId ?? null) !== row.repeat_occurrence_id) return false
        const ref: RepeatNodeRef = { nodeId: execution.workflowNodeId, occurrence }
        assertRepeatExecution(version, scope, ref, execution)
        if (execution.nativeSessionId) {
          const placement = await readNativePlacement(sql, execution.id)
          if (placement) {
            if (execution.workingDirectory !== placement.workingTree.canonicalCwd) return false
          } else if (await readExecutionPlacement(sql, execution.id)) {
            return false
          }
          const session = NativeSessionReferenceSchema.parse(row.native_reference)
          // Includes exact latest generation, previous lifetimes and recovered
          // closure receipts. No timestamp-only shortcut or invented session.
          assertRepeatNativeClosure(execution, session, await readWorkflowClosure(sql, execution))
        } else {
          if (row.native_reference !== null || execution.result.outcome === 'succeeded') return false
          const reservation = workflowNativeReservation(scope, ref, execution, repeatDigest(execution.input, 4 * 1024 * 1024))
          const entry = await readWorkflowNativeEntry(sql, reservation)
          if (entry.phase === 'not_submitted') {
            await readWorkflowNativeNotSubmitted(sql, reservation)
          } else if (entry.phase !== 'entered' || !await readUnboundWorkflowClosure(sql, execution)) {
            // entered may have a positive unbound dispose/recovery receipt,
            // including recovery of a never-dispatched launch reservation.
            return false
          }
        }
        after = row.id
      }
      if (rows.length < PAGE_SIZE) return true
    }
  } catch (error) {
    // Missing/corrupt proof is an obligation, not a public disclosure of private
    // evidence. Unrecognized operational failures propagate to the caller.
    if (error instanceof DomainError || error instanceof ZodError) return false
    throw error
  }
}
