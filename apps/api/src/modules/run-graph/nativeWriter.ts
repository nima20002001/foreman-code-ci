import {
  NativeGraphActivityRecordSchema, NativeGraphCorrelationRecordSchema, GraphSequenceSchema,
  assertNativeGraphProjectionAuthority, canonicalGraphJson, sameGraphScope,
  type NativeGraphActivityRecord, type NativeGraphCorrelationRecord, type NativeGraphProjectionKey,
  type RunGraphScope,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, poisonGraphTransaction, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'
import { assertRunGraphPublication } from './publication.js'
import {
  readNativeGraphActivity, readNativeGraphCorrelation, stagedNativeRecordId,
  type NativeGraphProjectionGuard,
} from './records.js'
import { activeNativeBatch, memoizeNativeRead, stageNativeRow, WORKFLOW_CORRELATION_READ_PREFIX,
  type NativeBatch, type StagedNativeRow } from './nativeBatch.js'

/** The G1 writer port. All methods require the caller's Run -> head -> domain lock order. */
export class PostgresNativeGraphProjectionWriter {
  private async authorize(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey, guard: NativeGraphProjectionGuard): Promise<void> {
    assertGraphTransaction(sql)
    assertRunGraphPublication(sql, scope)
    if (!guard || typeof guard.readCurrentLocked !== 'function' || !sameGraphScope(guard.expected.scope, scope)
      || canonicalGraphJson(guard.expected.key) !== canonicalGraphJson(key)) throw new RunGraphError('GRAPH_AUTHORITY_INVALID')
    assertNativeGraphProjectionAuthority(guard.expected, await guard.readCurrentLocked(sql, scope, key))
  }
  async persistActivity(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null,
    input: NativeGraphActivityRecord, guard: NativeGraphProjectionGuard): Promise<void> {
    try {
      const next = NativeGraphActivityRecordSchema.parse(input)
      await this.authorize(sql, scope, next.key, guard)
      const previous = await readNativeGraphActivity(sql, scope, next.key)
      assertRevision(previousRevision, previous?.projectionRevision, next.projectionRevision)
      if (next.activity.execution && canonicalGraphJson(next.activity.execution) !== canonicalGraphJson(next.key.execution)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      if (previous?.lastNativeSequence !== undefined && previous.lastNativeSequence !== null
        && (next.lastNativeSequence === null || BigInt(next.lastNativeSequence) < BigInt(previous.lastNativeSequence))) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      if (previous?.terminalNativeSequence !== undefined && previous.terminalNativeSequence !== null
        && (next.terminalNativeSequence !== previous.terminalNativeSequence || ['active', 'stale'].includes(next.activity.status))) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      if (['active', 'stale'].includes(next.activity.status)) {
        const row = await memoizeNativeRead(sql, `closed:${canonicalGraphJson(next.key)}`, async () => (await sql.query<{
          stopped: boolean; execution_state: string; work_closed: boolean }>(
          `select r.stop_requested_at is not null as stopped,r.execution_state,
            case when $3='workflow' then e.record->>'state'='completed'
              else exists(select 1 from review_jobs j where j.id=$4 and j.execution_id=e.id
                and (j.record->>'state'='completed' or j.record->'cleanup'->>'completedAt' is not null)) end as work_closed
           from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`,
          [scope.runId, next.key.execution.executionId, next.key.workKind, next.key.workId])).rows[0])
        if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        if (row.stopped) throw new RunGraphError('GRAPH_STOP_CONFLICT')
        // Settlement may continue after a Run outcome; it must not be advertised as fresh native work.
        if (row.work_closed || ['completed', 'interrupted'].includes(row.execution_state)) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      }
      const batch = activeNativeBatch(sql)
      if (batch) {
        stageNativeRow(batch, stagedNativeRecordId('activity', next.key), { kind: 'activity', expected: previousRevision, value: next })
        return
      }
      const values = [scope.runId, next.key.execution.executionId, next.key.execution.workflowNodeId,
        next.key.execution.attempt, next.key.workKind, next.key.workId, next.lastNativeSequence,
        next.terminalNativeSequence, next.projectionRevision, canonicalGraphJson(next.activity)]
      const result = previousRevision === null
        ? await sql.query(`insert into run_native_activity(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
            last_native_sequence,terminal_native_sequence,projection_revision,activity)
          values($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::bigint,$10::jsonb)
          on conflict(run_id,execution_id,work_kind,work_id) do nothing returning execution_id`, values)
        : await sql.query(`update run_native_activity set last_native_sequence=$7::bigint,terminal_native_sequence=$8::bigint,
            projection_revision=$9::bigint,activity=$10::jsonb
          where run_id=$1 and execution_id=$2 and workflow_node_id=$3 and attempt=$4 and work_kind=$5 and work_id=$6
            and projection_revision=$11::bigint returning execution_id`, [...values, previousRevision])
      if (result.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
  async persistCorrelation(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null,
    input: NativeGraphCorrelationRecord, guard: NativeGraphProjectionGuard): Promise<void> {
    try {
      const next = NativeGraphCorrelationRecordSchema.parse(input)
      await this.authorize(sql, scope, next.key, guard)
      if (String(next.connectionGeneration) !== guard.expected.connectionGeneration) throw new RunGraphError('GRAPH_STALE_GENERATION')
      const previous = await readNativeGraphCorrelation(sql, scope, next.key, next.correlationKey)
      assertRevision(previousRevision, previous?.metadataRevision, next.metadataRevision)
      const row = await memoizeNativeRead(sql, `host-correlation:${canonicalGraphJson(scope)}:${canonicalGraphJson(next.key)}`,
        async () => (await sql.query<{ session: string | null; provider: string | null; interaction_id: string | null; turn_id: string | null }>(
        `select case when $3='review' then j.record->>'nativeSessionId' else e.record->>'nativeSessionId' end as session,
          case when $3='review' then j.record->>'provider' else c.record->'harness'->>'harness' end as provider,
          j.interaction_id, j.record->>'providerTurnOrMessageId' as turn_id
         from harness_executions e join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
         left join review_jobs j on $3='review' and j.id=$4 and j.execution_id=e.id
         where e.run_id=$1 and e.id=$2`, [scope.runId, next.key.execution.executionId, next.key.workKind, next.key.workId])).rows[0])
      if (!row || row.session !== next.nativeSessionId || row.provider !== next.provider
        || (next.key.workKind === 'review' && (row.interaction_id !== next.interactionId
          || (row.turn_id !== null && next.nativeTurnId !== row.turn_id)))) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      if (previous) {
        if (next.connectionGeneration !== previous.connectionGeneration) {
          const activity = await readNativeGraphActivity(sql, scope, next.key)
          // The owner must publish an unknown/none activity fence BEFORE rotating
          // the correlation. A transport-open or reconnect cannot preserve old work.
          if (activity && ['active', 'stale'].includes(activity.activity.status)) throw new RunGraphError('GRAPH_STALE_GENERATION')
        }
        if (previous.nativeSessionId !== next.nativeSessionId || previous.provider !== next.provider
          || previous.interactionId !== next.interactionId || previous.reviewJobId !== next.reviewJobId
          || (previous.nativeTurnId !== null && previous.nativeTurnId !== next.nativeTurnId)
          || (previous.nativeRequestId !== null && previous.nativeRequestId !== next.nativeRequestId)
          || BigInt(next.firstNativeSequence) > BigInt(previous.firstNativeSequence)
          || BigInt(next.lastNativeSequence) < BigInt(previous.lastNativeSequence)
          || next.connectionGeneration < previous.connectionGeneration) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        if (previous.terminalNativeSequence !== null && previous.terminalNativeSequence !== next.terminalNativeSequence) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      }
      const batch = activeNativeBatch(sql)
      if (batch) {
        stageNativeRow(batch, stagedNativeRecordId('correlation', next.key, next.correlationKey),
          { kind: 'correlation', expected: previousRevision, value: next })
        return
      }
      const values = [scope.runId, next.key.execution.executionId, next.key.execution.workflowNodeId, next.key.execution.attempt,
        next.key.workKind, next.key.workId, next.correlationKey, next.provider, next.nativeSessionId, next.connectionId,
        next.connectionGeneration, next.nativeTurnId, next.nativeRequestId, next.interactionId, next.reviewJobId,
        next.firstNativeSequence, next.lastNativeSequence, next.terminalNativeSequence, next.metadataRevision]
      const result = previousRevision === null
        ? await sql.query(`insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
            correlation_key,provider,native_session_id,connection_id,connection_generation,native_turn_id,native_request_id,
            interaction_id,review_job_id,first_native_sequence,last_native_sequence,terminal_native_sequence,metadata_revision)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::bigint,$17::bigint,$18::bigint,$19::bigint)
          on conflict(run_id,execution_id,work_kind,work_id,correlation_key) do nothing returning execution_id`, values)
        : await sql.query(`update run_native_correlations set connection_id=$10,connection_generation=$11,native_turn_id=$12,
            native_request_id=$13,first_native_sequence=$16::bigint,last_native_sequence=$17::bigint,
            terminal_native_sequence=$18::bigint,metadata_revision=$19::bigint
          where run_id=$1 and execution_id=$2 and workflow_node_id=$3 and attempt=$4 and work_kind=$5 and work_id=$6
            and correlation_key=$7 and provider=$8 and native_session_id=$9 and interaction_id is not distinct from $14
            and review_job_id is not distinct from $15 and metadata_revision=$20::bigint returning execution_id`, [...values, previousRevision])
      if (result.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
function assertRevision(expected: string | null, actual: string | undefined, next: string): void {
  if ((actual ?? null) !== expected || (expected !== null && !GraphSequenceSchema.safeParse(expected).success)
    || BigInt(next) !== (expected === null ? 0n : BigInt(expected) + 1n)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
}

/** Writes staged rows of the requested kinds as one multi-row statement per kind. Each row still
 * requires the revision it was based on; a lost race fails the batch instead of overwriting. */
export async function flushNativeGraphRows(batch: NativeBatch, kinds: readonly StagedNativeRow['kind'][]): Promise<void> {
  for (const kind of kinds) {
    if (kind === 'correlation') {
      for (const key of batch.reads.keys()) {
        if (key.startsWith(WORKFLOW_CORRELATION_READ_PREFIX)) batch.reads.delete(key)
      }
    }
    const dirty = [...batch.staged.entries()].filter(([, row]) => row.dirty && row.kind === kind)
    if (!dirty.length) continue
    const rows = dirty.map(([, row]) => row)
    const inserts = rows.filter((row) => row.expected === null)
    const updates = rows.filter((row) => row.expected !== null)
    if (inserts.length) expectRows(await batch.sql.query(INSERT_SQL[kind], [JSON.stringify(inserts.map((row) => flushJson(batch.runId, row)))]), inserts.length)
    if (updates.length) expectRows(await batch.sql.query(UPDATE_SQL[kind], [JSON.stringify(updates.map((row) => flushJson(batch.runId, row)))]), updates.length)
    for (const [id, row] of dirty) {
      const entry = batch.staged.get(id)!
      entry.dirty = false
      entry.expected = revisionOf(row.kind, row.value)
    }
  }
}

function revisionOf(kind: StagedNativeRow['kind'], value: unknown): string {
  if (kind === 'correlation') return (value as NativeGraphCorrelationRecord).metadataRevision
  if (kind === 'activity') return (value as NativeGraphActivityRecord).projectionRevision
  return (value as { revision: string }).revision
}

function expectRows(result: { rowCount: number | null }, expected: number): void {
  if (result.rowCount !== expected) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
}

function flushJson(runId: string, row: StagedNativeRow): Record<string, unknown> {
  const { key } = row.value as { key: NativeGraphProjectionKey }
  const base = { run_id: runId, execution_id: key.execution.executionId, workflow_node_id: key.execution.workflowNodeId,
    attempt: key.execution.attempt, work_kind: key.workKind, work_id: key.workId, expected_revision: row.expected }
  if (row.kind === 'correlation') {
    const next = row.value as NativeGraphCorrelationRecord
    return { ...base, correlation_key: next.correlationKey, provider: next.provider, native_session_id: next.nativeSessionId,
      connection_id: next.connectionId, connection_generation: next.connectionGeneration, native_turn_id: next.nativeTurnId,
      native_request_id: next.nativeRequestId, interaction_id: next.interactionId, review_job_id: next.reviewJobId,
      first_native_sequence: next.firstNativeSequence, last_native_sequence: next.lastNativeSequence,
      terminal_native_sequence: next.terminalNativeSequence, metadata_revision: next.metadataRevision }
  }
  if (row.kind === 'activity') {
    const next = row.value as NativeGraphActivityRecord
    return { ...base, last_native_sequence: next.lastNativeSequence, terminal_native_sequence: next.terminalNativeSequence,
      projection_revision: next.projectionRevision, activity: next.activity }
  }
  const next = row.value as { revision: string; checkpoint: unknown }
  return { ...base, revision: next.revision, checkpoint: next.checkpoint }
}

const CORRELATION_COLUMNS = `run_id text,execution_id text,workflow_node_id text,attempt integer,work_kind text,work_id text,
  correlation_key text,provider text,native_session_id text,connection_id text,connection_generation bigint,native_turn_id text,
  native_request_id text,interaction_id text,review_job_id text,first_native_sequence bigint,last_native_sequence bigint,
  terminal_native_sequence bigint,metadata_revision bigint,expected_revision bigint`
const ACTIVITY_COLUMNS = `run_id text,execution_id text,workflow_node_id text,attempt integer,work_kind text,work_id text,
  last_native_sequence bigint,terminal_native_sequence bigint,projection_revision bigint,activity jsonb,expected_revision bigint`
const CHECKPOINT_COLUMNS = `run_id text,execution_id text,workflow_node_id text,attempt integer,work_kind text,work_id text,
  revision bigint,checkpoint jsonb,expected_revision bigint`

const INSERT_SQL: Record<StagedNativeRow['kind'], string> = {
  correlation: `insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,correlation_key,
      provider,native_session_id,connection_id,connection_generation,native_turn_id,native_request_id,interaction_id,review_job_id,
      first_native_sequence,last_native_sequence,terminal_native_sequence,metadata_revision)
    select run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,correlation_key,provider,native_session_id,connection_id,
      connection_generation,native_turn_id,native_request_id,interaction_id,review_job_id,first_native_sequence,last_native_sequence,
      terminal_native_sequence,metadata_revision
    from jsonb_to_recordset($1::jsonb) as r(${CORRELATION_COLUMNS})
    on conflict(run_id,execution_id,work_kind,work_id,correlation_key) do nothing returning execution_id`,
  activity: `insert into run_native_activity(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,last_native_sequence,
      terminal_native_sequence,projection_revision,activity)
    select run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,last_native_sequence,terminal_native_sequence,
      projection_revision,activity
    from jsonb_to_recordset($1::jsonb) as r(${ACTIVITY_COLUMNS})
    on conflict(run_id,execution_id,work_kind,work_id) do nothing returning execution_id`,
  checkpoint: `insert into run_native_projection_checkpoints(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,revision,checkpoint)
    select run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,revision,checkpoint
    from jsonb_to_recordset($1::jsonb) as r(${CHECKPOINT_COLUMNS})
    on conflict(run_id,execution_id,work_kind,work_id) do nothing returning execution_id`,
}
const UPDATE_SQL: Record<StagedNativeRow['kind'], string> = {
  correlation: `update run_native_correlations c set connection_id=r.connection_id,connection_generation=r.connection_generation,
      native_turn_id=r.native_turn_id,native_request_id=r.native_request_id,first_native_sequence=r.first_native_sequence,
      last_native_sequence=r.last_native_sequence,terminal_native_sequence=r.terminal_native_sequence,metadata_revision=r.metadata_revision
    from jsonb_to_recordset($1::jsonb) as r(${CORRELATION_COLUMNS})
    where c.run_id=r.run_id and c.execution_id=r.execution_id and c.workflow_node_id=r.workflow_node_id and c.attempt=r.attempt
      and c.work_kind=r.work_kind and c.work_id=r.work_id and c.correlation_key=r.correlation_key and c.provider=r.provider
      and c.native_session_id=r.native_session_id and c.interaction_id is not distinct from r.interaction_id
      and c.review_job_id is not distinct from r.review_job_id and c.metadata_revision=r.expected_revision
    returning c.execution_id`,
  activity: `update run_native_activity a set last_native_sequence=r.last_native_sequence,terminal_native_sequence=r.terminal_native_sequence,
      projection_revision=r.projection_revision,activity=r.activity
    from jsonb_to_recordset($1::jsonb) as r(${ACTIVITY_COLUMNS})
    where a.run_id=r.run_id and a.execution_id=r.execution_id and a.workflow_node_id=r.workflow_node_id and a.attempt=r.attempt
      and a.work_kind=r.work_kind and a.work_id=r.work_id and a.projection_revision=r.expected_revision
    returning a.execution_id`,
  checkpoint: `update run_native_projection_checkpoints c set revision=r.revision,checkpoint=r.checkpoint
    from jsonb_to_recordset($1::jsonb) as r(${CHECKPOINT_COLUMNS})
    where c.run_id=r.run_id and c.execution_id=r.execution_id and c.work_kind=r.work_kind and c.work_id=r.work_id
      and c.revision=r.expected_revision
    returning c.execution_id`,
}
