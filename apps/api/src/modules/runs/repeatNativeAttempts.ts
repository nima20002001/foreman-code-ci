import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatNativePending } from '../interactions/repeatNativeEvidence.js'

export type RepeatNativeAttemptSelection = { kind: 'occurrence'; id: string }
  | { kind: 'slot'; id: string; throughAttempt: number } | { kind: 'run' }

/** Caller holds the existing Run/head/owner transaction. Page ACTUAL executions,
 * including old technical attempts, instead of only the last node resolutions.
 * A completed attempt's replay must not try to settle its queued retry. A Run
 * scan deliberately includes unmapped executions so the visitor fails closed on
 * a missing occurrence/slot/input receipt rather than silently dropping work.
 */
export async function visitRepeatNativeAttemptsLocked(sql: GraphTransactionSql, runId: string,
  selected: RepeatNativeAttemptSelection, visit: (ids: readonly string[]) => Promise<void>): Promise<void> {
  if (!runId || selected.kind !== 'run' && !selected.id
    || selected.kind === 'slot' && (!Number.isSafeInteger(selected.throughAttempt)
      || selected.throughAttempt < 1 || selected.throughAttempt > 2147483647)) {
    return repeatNativePending('REPEAT_EXECUTION_SCAN_CONFLICT')
  }
  let after = ''
  for (;;) {
    const rows = await sql.query<{ id: string }>(`select e.id from harness_executions e
      left join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
      where e.run_id=$1 and e.id>$2 and ($3::text='run'
        or ($3::text='occurrence' and e.repeat_occurrence_id=$4)
        or ($3::text='slot' and x.slot_id=$4 and x.technical_attempt<=$5::integer)) order by e.id limit 100 for update of e`,
    [runId, after, selected.kind, selected.kind === 'run' ? null : selected.id,
      selected.kind === 'slot' ? selected.throughAttempt : null])
    const ids = rows.rows.map((row) => row.id)
    if (ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id || id === after)
      || new Set(ids).size !== ids.length) return repeatNativePending('REPEAT_EXECUTION_SCAN_CONFLICT')
    if (ids.length) await visit(ids)
    if (ids.length < 100) return
    after = ids[ids.length - 1]!
  }
}
