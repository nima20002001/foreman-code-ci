import type { LogicalWorkRef } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { Operation } from './types.js'

/** Linking shares this boundary; Run settlement excludes links until it commits. */
export async function lockMemoryRun(tx: GraphTransactionSql, runId: string, mode: 'link' | 'settle'): Promise<void> {
  const lock = mode === 'link' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
  await tx.query(`select ${lock}(hashtextextended($1,0))`, [`memory-run:${runId}`])
}

export async function lockSelectionRuns(tx: GraphTransactionSql, operations: readonly Operation[],
  current: readonly LogicalWorkRef[]): Promise<void> {
  const runs = new Set(current.map(work => work.runId))
  for (const operation of operations) {
    if (!('workSelections' in operation)) continue
    for (const selection of operation.workSelections ?? []) {
      if (selection.kind === 'current') runs.add(selection.work.runId)
    }
  }
  for (const runId of [...runs].sort()) await lockMemoryRun(tx, runId, 'link')
}
