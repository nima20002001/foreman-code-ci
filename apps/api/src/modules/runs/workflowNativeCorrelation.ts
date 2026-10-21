import type { NativeGraphCorrelationRecord } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { activeNativeBatch, memoizeNativeRead, WORKFLOW_CORRELATION_READ_PREFIX } from '../run-graph/nativeBatch.js'

/** Native writes hold the Run/head locks; include this batch's pending rows in the latest-turn selection. */
export async function latestWorkflowCorrelation(sql: GraphTransactionSql, runId: string,
  executionId: string, turnCorrelation: string): Promise<string> {
  const rows = await memoizeNativeRead(sql, `${WORKFLOW_CORRELATION_READ_PREFIX}${executionId}:${turnCorrelation}`, async () =>
    (await sql.query<{ correlation_key: string; first_native_sequence: string }>(
      `select correlation_key,first_native_sequence::text from run_native_correlations
       where run_id=$1 and execution_id=$2 and work_kind='workflow' and work_id=$2
         and native_request_id is null and interaction_id is null
         and (correlation_key=$3 or starts_with(correlation_key,$3 || ':retry:'))
       order by first_native_sequence desc`, [runId, executionId, turnCorrelation])).rows)
  const candidates = new Map(rows.map(row => [row.correlation_key, row.first_native_sequence]))
  for (const staged of activeNativeBatch(sql)?.staged.values() ?? []) {
    if (staged.kind !== 'correlation') continue
    const row = staged.value as NativeGraphCorrelationRecord
    if (row.key.execution.executionId === executionId && row.key.workKind === 'workflow'
      && row.key.workId === executionId && row.nativeRequestId === null && row.interactionId === null
      && (row.correlationKey === turnCorrelation || row.correlationKey.startsWith(`${turnCorrelation}:retry:`))) {
      candidates.set(row.correlationKey, row.firstNativeSequence)
    }
  }
  let latest = turnCorrelation
  let first: bigint | undefined
  for (const [key, sequence] of candidates) {
    if (first === undefined || BigInt(sequence) > first) {
      latest = key
      first = BigInt(sequence)
    }
  }
  return latest
}
