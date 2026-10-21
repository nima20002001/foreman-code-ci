import {
  NativeGraphProjectionKeySchema, NativeGraphActivityRecordSchema, NativeGraphCorrelationRecordSchema, canonicalGraphJson,
  type NativeGraphProjectionKey, type NativeGraphActivityRecord,
  type NativeGraphCorrelationRecord, type RunGraphScope, type NativeGraphProjectionFence,
  type NativeGraphProjectionAccessState,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { RunGraphError } from './errors.js'
import { activeNativeBatch, memoizeNativeRead } from './nativeBatch.js'

/** Staged batch state (latest write) wins over the database row; absent rows are read once. */
export function stagedNativeRecordId(kind: 'activity' | 'correlation' | 'checkpoint', key: NativeGraphProjectionKey, correlationKey = ''): string {
  return `${kind}:${canonicalGraphJson(key)}:${correlationKey}`
}

export interface NativeCheckpointRow { key: NativeGraphProjectionKey; revision: string; checkpoint: unknown }
/** Latest checkpoint of one work item: staged batch state first, then one memoized database read. */
export async function readNativeCheckpoint(sql: GraphTransactionSql, scope: RunGraphScope,
  input: NativeGraphProjectionKey): Promise<NativeCheckpointRow | undefined> {
  assertGraphTransaction(sql)
  const key = NativeGraphProjectionKeySchema.parse(input)
  const id = stagedNativeRecordId('checkpoint', key)
  const staged = activeNativeBatch(sql)?.staged.get(id)
  if (staged) return staged.value as NativeCheckpointRow
  return memoizeNativeRead(sql, `row:${id}`, async () => {
    const result = await sql.query<{ revision: string; checkpoint: unknown }>(
      `select revision::text,checkpoint from run_native_projection_checkpoints
       where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4`,
      [scope.runId, key.execution.executionId, key.workKind, key.workId])
    const row = result.rows[0]
    return row ? { key, revision: row.revision, checkpoint: row.checkpoint } : undefined
  })
}

export async function readNativeGraphActivity(
  sql: GraphTransactionSql, scope: RunGraphScope, input: NativeGraphProjectionKey,
): Promise<NativeGraphActivityRecord | undefined> {
  assertGraphTransaction(sql)
  const key = NativeGraphProjectionKeySchema.parse(input)
  await assertNativeProjectionHost(sql, scope, key)
  const id = stagedNativeRecordId('activity', key)
  const staged = activeNativeBatch(sql)?.staged.get(id)
  if (staged) return staged.value as NativeGraphActivityRecord
  return memoizeNativeRead(sql, `row:${id}`, async () => {
    const result = await sql.query<{
      projection_revision: string; last_native_sequence: string | null; terminal_native_sequence: string | null; activity: unknown
    }>(
      `select projection_revision::text,last_native_sequence::text,terminal_native_sequence::text,activity
       from run_native_activity where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4
         and workflow_node_id=$5 and attempt=$6`,
      [scope.runId, key.execution.executionId, key.workKind, key.workId, key.execution.workflowNodeId, key.execution.attempt],
    )
    const row = result.rows[0]
    return row ? NativeGraphActivityRecordSchema.parse({
      key, projectionRevision: row.projection_revision, lastNativeSequence: row.last_native_sequence,
      terminalNativeSequence: row.terminal_native_sequence, activity: row.activity,
    }) : undefined
  })
}
export async function readNativeGraphCorrelation(
  sql: GraphTransactionSql, scope: RunGraphScope, input: NativeGraphProjectionKey, correlationKey: string,
): Promise<NativeGraphCorrelationRecord | undefined> {
  assertGraphTransaction(sql)
  const key = NativeGraphProjectionKeySchema.parse(input)
  await assertNativeProjectionHost(sql, scope, key)
  const id = stagedNativeRecordId('correlation', key, correlationKey)
  const staged = activeNativeBatch(sql)?.staged.get(id)
  if (staged) return staged.value as NativeGraphCorrelationRecord
  return memoizeNativeRead(sql, `row:${id}`, async () => {
    const result = await sql.query<{
      provider: string; native_session_id: string; connection_id: string | null; connection_generation: number;
      native_turn_id: string | null; native_request_id: string | null; interaction_id: string | null; review_job_id: string | null;
      first_native_sequence: string; last_native_sequence: string; terminal_native_sequence: string | null; metadata_revision: string
    }>(
      `select provider,native_session_id,connection_id,connection_generation,native_turn_id,native_request_id,
         interaction_id,review_job_id,first_native_sequence::text,last_native_sequence::text,terminal_native_sequence::text,metadata_revision::text
       from run_native_correlations where run_id=$1 and execution_id=$2 and work_kind=$3 and work_id=$4
         and correlation_key=$5 and workflow_node_id=$6 and attempt=$7`,
      [scope.runId, key.execution.executionId, key.workKind, key.workId, correlationKey, key.execution.workflowNodeId, key.execution.attempt],
    )
    const row = result.rows[0]
    return row ? NativeGraphCorrelationRecordSchema.parse({
      key, correlationKey, provider: row.provider, nativeSessionId: row.native_session_id,
      connectionId: row.connection_id, connectionGeneration: row.connection_generation,
      nativeTurnId: row.native_turn_id, nativeRequestId: row.native_request_id,
      interactionId: row.interaction_id, reviewJobId: row.review_job_id,
      firstNativeSequence: row.first_native_sequence, lastNativeSequence: row.last_native_sequence,
      terminalNativeSequence: row.terminal_native_sequence, metadataRevision: row.metadata_revision,
    }) : undefined
  })
}

/** Read actual locked authority in the publication transaction; never return an echo of expected. */
export interface NativeGraphProjectionGuard {
  expected: NativeGraphProjectionFence
  readCurrentLocked(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey): Promise<NativeGraphProjectionAccessState>
}

async function assertNativeProjectionHost(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey): Promise<void> {
  await memoizeNativeRead(sql, `host:${canonicalGraphJson(scope)}:${canonicalGraphJson(key)}`, () => assertHostRow(sql, scope, key))
}

async function assertHostRow(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey): Promise<void> {
  const found = await sql.query(
    `select 1 from harness_executions e join runs r on r.id=e.run_id
     join workflow_versions v on v.id=r.workflow_version_id
     where e.id=$1 and e.run_id=$2 and e.workflow_node_id=$3 and e.attempt=$4
       and e.record->>'agentId'=$5 and e.record->>'agentConfigurationVersionId'=$6
       and r.workspace_id=$7 and r.workflow_id=$8 and r.workflow_version_id=$9
       and v.execution_semantics_version=$10
       and ($11::text='workflow' or exists(select 1 from review_jobs j
         join durable_interactions i on i.id=j.interaction_id
         where j.id=$12 and j.execution_id=e.id and i.run_id=e.run_id))`,
    [key.execution.executionId, scope.runId, key.execution.workflowNodeId, key.execution.attempt,
      key.execution.agentId, key.execution.agentConfigurationVersionId, scope.workspaceId, scope.workflowId,
      scope.workflowVersionId, scope.executionSemanticsVersion, key.workKind, key.workId],
  )
  if (found.rowCount !== 1) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
}
