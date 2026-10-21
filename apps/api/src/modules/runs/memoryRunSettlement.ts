import type { ExecutionResult } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { MemoryBoardPort } from '../collaboration/ports.js'
import { memoryExecution } from '../collaboration/memoryExecution.js'
import { lockSelections } from '../memory-boards/batch.js'
import { lockMemoryRun } from '../memory-boards/runLocks.js'

/** The Run owner settles logical obligations even when no downstream attempt was admitted. */
export async function settleMemoryRunLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  runId: string, result: ExecutionResult): Promise<void> {
  if (result.outcome === 'succeeded') return
  const unresolved = "b.record->'resolution' is null and b.record->>'state' not in ('accepted','failed','canceled')"
  await lockMemoryRun(tx, runId, 'settle')
  const work = (await tx.query<{ work_key: string }>(`select distinct work_key from memory_card_bindings b
    where b.record#>>'{work,runId}'=$1 and ${unresolved} order by work_key`, [runId])).rows
  await lockSelections(tx, [], work.map(row => row.work_key))
  // Acquire the complete board set in one order before applying individual work facts.
  await tx.query(`select id from memory_boards where id in (
    select b.board_id from memory_card_bindings b where b.record#>>'{work,runId}'=$1 and ${unresolved}
  ) order by id for update`, [runId])
  const executions = (await tx.query<{ id: string }>(`select distinct e.id from memory_card_bindings b
    join harness_executions e on e.id=b.record->>'currentExecutionId' and e.run_id=$1
    where b.record#>>'{work,runId}'=$1 and ${unresolved} order by e.id`, [runId])).rows
  for (const { id } of executions) {
    const saved = await memoryExecution(tx, id)
    await service.applyLifecycleLocked(tx, { agent: saved.subject.agent, execution: saved.subject.execution,
      work: saved.work, sourceEventKey: `run:${runId}:${result.outcome}:${id}`, phase: result.outcome,
      reason: result.error?.message ?? 'The workflow was stopped before this work settled.', outstandingRequestIds: [] })
  }
}
