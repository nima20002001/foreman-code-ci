import { canonicalGraphJson, type NativeGraphActivityRecord, type RunGraphScope } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { readCurrentNativeActivities, type CurrentNativeActivity } from './currentActivity.js'
import { activeNativeBatch, memoizeNativeRead } from './nativeBatch.js'
import type { PublicNodeInputs } from './publicProjection.js'

/** Compose successive frames from the initial rows and staged writes, without flushing after each frame. */
export async function readBatchNativeActivities(sql: GraphTransactionSql, scope: RunGraphScope,
  inputs: PublicNodeInputs): Promise<CurrentNativeActivity[]> {
  const rows = await memoizeNativeRead(sql, `current-native-activities:${canonicalGraphJson(inputs.nodeIds)}`,
    () => readCurrentNativeActivities(sql, scope, inputs.nodeIds))
  const current = new Map(rows.map(row => [canonicalGraphJson(row.key), row]))
  for (const staged of activeNativeBatch(sql)?.staged.values() ?? []) {
    if (staged.kind !== 'activity') continue
    const row = staged.value as NativeGraphActivityRecord
    const key = row.key
    if (!inputs.nodeIds.includes(key.execution.workflowNodeId)) continue
    if (key.workKind === 'workflow'
      && inputs.executions.get(key.execution.workflowNodeId)?.execution.executionId !== key.execution.executionId) continue
    const id = canonicalGraphJson(key)
    if (key.workKind === 'review' && !['active', 'stale', 'unknown'].includes(row.activity.status)) {
      current.delete(id)
    } else {
      current.set(id, { key, activity: row.activity, lastNativeSequence: row.lastNativeSequence })
    }
  }
  return [...current.values()]
}
