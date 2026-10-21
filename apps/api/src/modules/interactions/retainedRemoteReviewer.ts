import { NativeSessionReferenceSchema, type HarnessExecution } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql } from '../run-graph/connection.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readExecutionPlacement, readExecutionPlacements } from '../placement/persistence.js'
import { remoteReviewerPolicy, assertRemoteReviewerReceipt } from '../placement/remoteReviewerAuthority.js'
import { requireReviewerCredential } from './reviewerCredential.js'
import { DomainError } from '../errors.js'

/** Resource ownership only: expiry does not prove that the native process released its source. */
export async function hasRetainedRemoteReviewerSource(sql: GraphSqlClient, execution: HarnessExecution): Promise<boolean> {
  if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded' || !execution.nativeSessionId) return false
  const row = (await sql.query<{ owned: boolean }>(`select exists(
    select 1 from remote_execution_receipts r
    join execution_dispatch_intents i using(operation_id)
    join execution_native_closures c on c.execution_id=i.execution_id
    join execution_native_sessions s on s.execution_id=i.execution_id
    where i.execution_id=$1 and r.receipt#>>'{intent,executionId}'=$1
      and r.receipt#>>'{intent,runId}'=$3
      and r.receipt->'retainedReviewer' is not null and r.receipt->'terminal' is null
      and r.receipt#>>'{native,sessionId}'=$2 and s.reference->>'nativeSessionId'=$2
      and r.receipt#>'{retainedReviewer,result}'=$4::jsonb
      and c.closed_at is null and (c.detached_at is null or c.detached_reference=s.reference)
      and (c.expected_reference is null or c.expected_reference=s.reference)
      and not exists(select 1 from execution_native_closures newer
        where newer.execution_id=c.execution_id and newer.generation>c.generation)
    ) as owned`, [execution.id, execution.nativeSessionId, execution.runId, JSON.stringify(execution.result)])).rows[0]
  return row?.owned === true
}

export async function readRetainedRemoteReviewer(sql: GraphSqlClient, execution: HarnessExecution) {
  const retained = await readRemoteReviewer(sql, execution, 'live')
  if (!retained) return undefined
  return { generation: retained.generation, principalId: retained.principalId, session: retained.session }
}

export async function readRetainedRemoteReviewers(sql: GraphSqlClient, executions: readonly HarnessExecution[]) {
  const placements = await readExecutionPlacements(sql, executions.map(execution => execution.id))
  const retained = []
  for (const execution of executions) {
    const reviewer = await readRemoteReviewerWithPlacement(sql, execution, 'live', placements.get(execution.id))
    if (reviewer) retained.push(reviewer)
  }
  return retained
}

/** A saved candidate grants no review access until authenticated Worker attachment refreshes its lease. */
export function readRecoverableRemoteReviewer(sql: GraphSqlClient, execution: HarnessExecution) {
  return readRemoteReviewer(sql, execution, 'recovery')
}

async function readRemoteReviewer(sql: GraphSqlClient, execution: HarnessExecution, purpose: 'live' | 'recovery') {
  const placement = await readExecutionPlacement(sql, execution.id)
  return readRemoteReviewerWithPlacement(sql, execution, purpose, placement)
}

async function readRemoteReviewerWithPlacement(sql: GraphSqlClient, execution: HarnessExecution,
  purpose: 'live' | 'recovery', placement: AcceptedNodePlacement | undefined) {
  if (placement?.hostRef.kind !== 'device') return undefined
  const row = (await sql.query<{ receipt: unknown }>(`select r.receipt from remote_execution_receipts r
    join execution_dispatch_intents i using(operation_id) where i.execution_id=$1`, [execution.id])).rows[0]
  if (!row) return undefined
  const receipt = RemoteOperationReceiptSchema.parse(row.receipt)
  const policy = await remoteReviewerPolicy(sql, receipt.intent)
  if (!receipt.retainedReviewer || receipt.terminal || receipt.stopFence || !policy) return undefined
  const active = ['running', 'waiting'].includes(policy.run.executionState) && policy.run.outcome === 'pending'
  if (!active) {
    if (purpose !== 'live' || policy.run.executionState !== 'completed' || policy.run.outcome !== 'succeeded') {
      return undefined
    }
    // A completed Run retains resource ownership until its cleanup closes the original process.
    const cleanup = await sql.query(`select 1 from runs r join run_cleanup_intents c on c.run_id=r.id
      where r.id=$1 and r.stop_requested_at is null and c.pending`, [execution.runId])
    if (cleanup.rowCount !== 1) return undefined
  }
  const current = await readReconciledDispatchIntent(sql, receipt.intent.operationId)
  await assertRemoteReviewerReceipt(sql, receipt)
  if (!sameWorkflowValue(current, receipt.intent) || placement.bindingHash !== receipt.intent.bindingHash
    || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded'
    || !sameWorkflowValue(execution.result, receipt.retainedReviewer.result)
    || !policy.session || policy.session.nativeSessionId !== execution.nativeSessionId)
    throw new DomainError('REMOTE_REVIEWER_DENIED', 'The retained reviewer result does not match its execution.', 409)
  const lifetime = (await sql.query<{ generation: string; live: boolean; detached: boolean; reference: unknown }>(`select
    c.generation::text,c.detached_at is not null as detached,
    c.closed_at is null and not c.closed_without_session
      and (c.expected_reference is null or c.expected_reference=s.reference)
      and (c.detached_at is null or ($3::boolean and c.detached_reference=s.reference))
      and ($3::boolean or clock_timestamp()<$2::timestamptz)
      and not exists(select 1 from execution_native_closures p where p.execution_id=c.execution_id
        and p.generation<c.generation and p.closed_at is null and p.detached_at is null) as live,
      s.reference from execution_native_closures c join execution_native_sessions s using(execution_id)
      where c.execution_id=$1 order by c.generation desc limit 1 for share of c,s`,
  [execution.id, receipt.retainedReviewer.expiresAt, purpose === 'recovery'])).rows[0]
  if (!lifetime?.live || !sameWorkflowValue(NativeSessionReferenceSchema.parse(lifetime.reference), policy.session))
    return undefined
  const terminal = await sql.query(`select 1 from workflow_native_proofs where execution_id=$1 and run_id=$2
    and record#>>'{original,type}'='history' and record#>>'{original,history,terminalTurn,correlationId}'=$3
    and record#>>'{original,history,terminalTurn,providerId}'=$4
    and record#>'{original,history,terminalTurn,result}'=$5::jsonb limit 1`,
  [execution.id, execution.runId, receipt.turnInput?.correlationId ?? `execution:${execution.id}`,
    receipt.retainedReviewer.workflowTurnId, JSON.stringify(execution.result)])
  if (terminal.rowCount !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'Original reviewer terminal proof is required.', 409)
  const credentials = (await sql.query<{ principal_id: string }>(`select b.principal_id from worker_credential_bindings b
    join management_principals p on p.id=b.principal_id where b.execution_id=$1 and b.run_id=$2
    and b.agent_id=$3 and b.purpose in ('workflow','reviewer') and b.revoked_at is null and p.revoked_at is null and p.expires_at>clock_timestamp()
    and p.audience='worker' and p.agent_id=b.agent_id order by b.principal_id limit 2`,
  [execution.id, execution.runId, execution.agentId])).rows
  if (purpose === 'recovery' && credentials.length === 0) return undefined
  if (credentials.length !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer process lease is required.', 409)
  const principalId = credentials[0]!.principal_id
  await requireReviewerCredential(sql, principalId, { agentId: execution.agentId,
    workspaceId: policy.run.workspaceId, workflowId: policy.run.workflowId, runId: policy.run.id })
  return { generation: lifetime.generation, principalId, session: policy.session, detached: lifetime.detached }
}

/** Completion and credential retention commit together so terminal cleanup cannot revoke the original token. */
export async function finalizeRetainedRemoteReviewerLocked(sql: GraphTransactionSql,
  execution: HarnessExecution): Promise<void> {
  const retained = await readRetainedRemoteReviewer(sql, execution)
  if (!retained) return
  const finalized = await sql.query(`update execution_native_sessions
    set workflow_finalized_at=coalesce(workflow_finalized_at,clock_timestamp())
    where execution_id=$1 and reference=$2::jsonb returning execution_id`,
  [execution.id, JSON.stringify(retained.session)])
  if (finalized.rowCount !== 1) {
    throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer session changed during retention.', 409)
  }
  await retainRemoteReviewerCredential(sql, execution, retained)
  beforeGraphCommit(sql, async () => {
    if (!sameWorkflowValue(await readRetainedRemoteReviewer(sql, execution), retained)) {
      throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer lifetime changed before retention committed.', 409)
    }
  })
}

export async function retainRemoteReviewerCredential(sql: GraphSqlClient, execution: HarnessExecution,
  retained: NonNullable<Awaited<ReturnType<typeof readRetainedRemoteReviewer>>>) {
  const lane = (await sql.query<{ generation: string }>(`select record->>'connectionGeneration' as generation
    from native_session_lanes where harness=$1 and native_session_id=$2 and owner_agent_id=$3 for share`,
  [retained.session.harness, retained.session.nativeSessionId, execution.agentId])).rows[0]
  if (!lane) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer writer lane is required.', 409)
  // Process recovery precedes the dispatcher's binding to a claimed review job.
  const result = await sql.query(`with retained_job as (
    select j.id,j.lease_fence from worker_credential_bindings b join review_jobs j
      on j.id=b.approval_review_job_id and j.lease_fence=b.approval_review_lease_fence
    where b.principal_id=$1 and b.approval_connection_generation=$5::bigint
      and j.execution_id=$2 and j.record->>'nativeSessionId'=$4
  ) update worker_credential_bindings set purpose='reviewer',
    approval_native_session_id=$4,approval_connection_generation=$5::bigint,
    approval_review_job_id=(select id from retained_job),
    approval_review_lease_fence=(select lease_fence from retained_job)
    where principal_id=$1 and execution_id=$2 and agent_id=$3 and purpose in ('workflow','reviewer') and revoked_at is null`,
  [retained.principalId, execution.id, execution.agentId, retained.session.nativeSessionId, lane.generation])
  if (result.rowCount !== 1) throw new DomainError('REMOTE_REVIEWER_DENIED', 'The process lease changed during retention.', 409)
}
