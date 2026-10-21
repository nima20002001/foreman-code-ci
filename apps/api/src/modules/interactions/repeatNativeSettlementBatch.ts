import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution } from '@foreman-code/contracts'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction,
  type GraphTransactionSql } from '../run-graph/connection.js'
import { readExecutionPlacements } from '../placement/persistence.js'
import { closedWorkflowSession, type ClosureRow } from './workflowClosure.js'
import { assertRepeatNativeClosure, repeatNativePending } from './repeatNativeEvidence.js'
import { settleRepeatNativeExecutionWithProofLocked, type RepeatNativeSettlementCheckpoint } from './repeatNativeSettlement.js'

interface SettlementRow extends ClosureRow {
  id: string; record: unknown; reference: unknown; finalized: boolean; complex: boolean; outstanding: boolean
  configuration: { harness: string; agent_id: string; pinned: boolean } | null
}

async function closedAttempts(sql: GraphTransactionSql, runId: string, executions: readonly HarnessExecution[]) {
  const ids = executions.map(execution => execution.id)
  const placements = await readExecutionPlacements(sql, ids)
  const rows = await sql.query<SettlementRow>(`with sessions as materialized (
      select execution_id,reference,workflow_finalized_at from execution_native_sessions
      where execution_id=any($2::text[]) order by execution_id for update
    ) select e.id,e.record,s.reference,s.workflow_finalized_at is not null as finalized,
      c.generation::text,c.execution_identity,c.expected_reference,c.closed_reference,
      c.closed_at is not null as closed,c.detached_at is not null as detached,c.detached_reference,c.closed_without_session,
      exists(select 1 from execution_native_closures prior where prior.execution_id=e.id
        and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed,
      json_build_object('harness',a.record#>>'{harness,harness}','agent_id',a.agent_id,'pinned',
        a.record->>'id'=a.id and a.record->>'agentId'=a.agent_id and a.record->>'workspaceId'=a.workspace_id
          and r.record->'agentConfigurationVersionIds'->>a.agent_id=a.id) as configuration,
      (exists(select 1 from durable_interactions i where i.run_id=e.run_id and i.execution_id=e.id
          and i.record->>'kind' is distinct from 'work_direction')
        or exists(select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
          where i.execution_id=e.id or j.execution_id=e.id)) as complex,
      (exists(select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
          where b.execution_id=e.id and (b.run_id is distinct from e.run_id or b.revoked_at is null
            or p.id is null or p.revoked_at is null))
        or exists(select 1 from approval_execution_state b where b.execution_id=e.id
          and (b.graph_thread_id is distinct from e.run_id or b.active_started_at is not null
            or b.approval_wait_started_at is not null))) as outstanding
    from harness_executions e join runs r on r.id=e.run_id
    left join sessions s on s.execution_id=e.id
    left join agent_configuration_versions a on a.id=e.record->>'agentConfigurationVersionId' and a.workspace_id=r.workspace_id
    left join lateral (select * from execution_native_closures where execution_id=e.id
      order by generation desc limit 1) c on true
    where e.run_id=$1 and e.id=any($2::text[]) order by e.id for update of e`, [runId, ids])
  if (rows.rows.length !== executions.length) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  const supplied = new Map(executions.map(execution => [execution.id, execution]))
  const closed: Array<RepeatNativeSettlementCheckpoint & { finalized: boolean }> = []
  const other: HarnessExecution[] = []
  for (const row of rows.rows) {
    const execution = HarnessExecutionSchema.parse(row.record)
    if (!isDeepStrictEqual(execution, supplied.get(row.id)) || execution.runId !== runId) {
      return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    }
    if (row.complex || placements.get(row.id)?.hostRef.kind === 'device' || !row.reference
      || !row.closed || row.detached || row.closed_without_session || row.prior_unclosed !== false) {
      other.push(execution)
      continue
    }
    if (row.outstanding !== false) return repeatNativePending()
    const session = NativeSessionReferenceSchema.parse(row.reference)
    if (row.configuration?.pinned !== true || row.configuration.agent_id !== execution.agentId
      || row.configuration.harness !== session.harness) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    const generation = assertRepeatNativeClosure(execution, session, closedWorkflowSession(row, execution))
    closed.push({ execution, session, generation, finalized: row.finalized })
  }
  return { closed, other }
}

/** Ordinary closed attempts share their resource, session, configuration and generation reads. */
export async function settleRepeatNativeExecutionsWithProofLocked(sql: GraphTransactionSql, runId: string,
  executions: readonly HarnessExecution[]): Promise<void> {
  assertGraphTransaction(sql)
  if (!executions.length) return
  try {
    const captured = executions.map(execution => HarnessExecutionSchema.parse(structuredClone(execution)))
    const { closed, other } = await closedAttempts(sql, runId, captured)
    for (const execution of other) await settleRepeatNativeExecutionWithProofLocked(sql, runId, execution)
    const unfinished = closed.filter(item => !item.finalized)
    if (unfinished.length) {
      const updated = await sql.query(`update execution_native_sessions s
        set workflow_finalized_at=coalesce(s.workflow_finalized_at,clock_timestamp())
        from jsonb_to_recordset($1::jsonb) as p(execution_id text,reference jsonb)
        where s.execution_id=p.execution_id and s.reference=p.reference returning s.execution_id`,
      [JSON.stringify(unfinished.map(item => ({ execution_id: item.execution.id, reference: item.session })))])
      if (updated.rowCount !== unfinished.length) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    }
    const retained = closed.map(({ execution, session, generation }) => ({ execution, session, generation }))
    beforeGraphCommit(sql, async () => {
      try {
        const current = await closedAttempts(sql, runId, closed.map(item => item.execution))
        const settled = current.closed.map(({ execution, session, generation }) => ({ execution, session, generation }))
        if (current.other.length || !isDeepStrictEqual(settled, retained)) return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
      } catch (error) { poisonGraphTransaction(sql); throw error }
    })
  } catch (error) { poisonGraphTransaction(sql); throw error }
}
