import { assertOriginalWorkflowTerminal } from '../interactions/workflowTerminalSource.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import {
  ExecutionResultSchema, HarnessExecutionSchema, type DurableInteraction, type ExecutionResult, type HarnessExecution,
} from '@foreman-code/contracts'
import {
  AcceptedWorkflowRunV3Schema, AcceptedCurrentNodeResultSchema, canonicalGraphJson, RUN_GRAPH_LIMITS,
  type AcceptedWorkflowRunV3, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { openRepeatCanonicalPublicationLocked } from '../run-graph/repeatPublication.js'
import { assertApprovalTerminalSettlement } from '../interactions/wave25/resume.js'
import type { WorkflowNativeVerificationPort } from '../interactions/workflowNativeCapture.js'
import { WorkflowNativeProofServices } from './workflowNativeProof.js'
import { assertSettlementLocked } from './repeatSettlementServices.js'
import { readRepeatExecutionLocked } from './repeatPostgres.js'
import { readRepeatExecutionsLocked } from './repeatExecutionRead.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { assertRepeatSource, repeatDigest, sameRepeatValue, type RepeatSource } from './repeatResolution.js'
import type { RepeatRepositoryServices } from './repeatRepositoryHost.js'
import type { RunOwnership } from './ownership.js'
import { visitRepeatNativeAttemptsLocked } from './repeatNativeAttempts.js'
import { hasWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { assertRestartAttemptsLocked } from './workflowRestartSettlement.js'
import { hasExecutionRetryBudget, isTransientExecutionResult } from './executionRetryPolicy.js'
import type { ApprovalPostgresSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import { lockInteraction } from '../interactions/wave25/context.js'
import { assertSavedPendingApprovalOriginalLocked } from '../interactions/nativeApprovalProof.js'
import { readRetainedRemoteReviewers } from '../interactions/retainedRemoteReviewer.js'

export interface WorkflowRestartApprovals {
  saver: ApprovalPostgresSaver
  interactions: readonly DurableInteraction[]
}

async function assertRestartApprovalsLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
  approval: WorkflowRestartApprovals): Promise<string[]> {
  const expected = structuredClone(approval.interactions)
  if (!expected.length || expected.length > 1000 || new Set(expected.map(item => item.id)).size !== expected.length) {
    return conflict('GRAPH_INTERRUPT_INVALID')
  }
  const check = async () => {
    const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
    const checkpoints: string[] = []
    for (const item of expected) {
      const current = await lockInteraction(sql, item.id)
      const stored = await readRepeatExecutionLocked(sql, snapshot, item.executionId)
      if (!sameRepeatValue(current, item) || item.runId !== run.id || item.graphThreadId !== run.id
        || stored.execution.state !== 'waiting' || stored.execution.nativeSessionId !== item.nativeSessionId
        || stored.execution.agentId !== item.requestingAgentId) return conflict('GRAPH_INTERRUPT_INVALID')
      await assertSavedPendingApprovalOriginalLocked(sql, current)
      checkpoints.push(await approval.saver.inspectApprovalInterrupt(sql, current))
    }
    return checkpoints
  }
  const checkpoints = await check()
  beforeGraphCommit(sql, async () => {
    if (!sameRepeatValue(await check(), checkpoints)) return conflict('GRAPH_INTERRUPT_NOT_CURRENT')
  })
  return [...new Set(expected.map(item => item.executionId))]
}

function conflict(code: string): never {
  throw new DomainError(code, 'The current workflow operation conflicts with its exact durable evidence.', 409)
}

/** Production service family, paired with the same coordinator capture channel.
 * The callbacks are SQL-only and use the existing G1/Run-owner transaction. They
 * are not feature flags, native mocks, or a separate normal/repeat engine. */
export function createWorkflowRepositoryServices(captures: WorkflowNativeVerificationPort, assertAdditionalPhysical?: ConstructorParameters<typeof WorkflowNativeProofServices>[1],
  afterPersistOriginalLocked?: ConstructorParameters<typeof WorkflowNativeProofServices>[2]): {
  services: RepeatRepositoryServices; native: WorkflowNativeProofServices
} {
  const native = new WorkflowNativeProofServices(captures, assertAdditionalPhysical, afterPersistOriginalLocked)
  const services: RepeatRepositoryServices = Object.freeze({
    openPublicationLocked: openRepeatCanonicalPublicationLocked,
    assertNativeBoundaryLocked: native.assertNativeBoundaryLocked.bind(native),
    assertNativeUpdateLocked: native.assertNativeUpdateLocked.bind(native),
    assertSettlementLocked,
    allowTechnicalRetryLocked,
    completeRunLocked,
  })
  return { services, native }
}

/** A failed attempt retries when its provider marked the failure retryable or
 * the shared policy classifies its cause as infrastructure. The repository has
 * already settled the attempt. A canceled/invalid result is not retryable.
 * A retry keeps the same slot, business occurrence and byte-identical input. */
export async function allowTechnicalRetryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
  version: WorkflowVersionV3, supplied: HarnessExecution): Promise<boolean> {
  assertGraphTransaction(sql)
  try {
    const execution = HarnessExecutionSchema.parse(structuredClone(supplied))
    const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
    if (!sameRepeatValue(snapshot.run, run) || !sameRepeatValue(snapshot.version, version)) return conflict('RUN_PIN_CONFLICT')
    if (snapshot.stopRequested || snapshot.cleanupPending || !['running', 'waiting'].includes(run.executionState)) return false
    const stored = await readRepeatExecutionLocked(sql, snapshot, execution.id)
    if (!sameRepeatValue(stored.execution, execution) || stored.accepted) return conflict('REPEAT_RETRY_NOT_ALLOWED')
    if (execution.state !== 'completed' || execution.result?.outcome !== 'failed' || !execution.result.error?.retryable) return false
    const budget = version.definition.executionPolicy?.maxNodeExecutions
    if (!budget) return false
    // Slot history survives restart and keeps repeat occurrences and handoff activations independent.
    const attempts = (await sql.query<{ record: unknown; failure_result: unknown }>(`
      select e.record,b.failure_result from run_repeat_executions x
        join harness_executions e on e.id=x.execution_id and e.run_id=x.run_id
        left join approval_execution_state b on b.execution_id=e.id
      where x.run_id=$1 and x.slot_id=$2 and x.technical_attempt<=$3
      order by x.technical_attempt`, [run.id, stored.slotId, execution.attempt])).rows.map(row => ({
      execution: HarnessExecutionSchema.parse(row.record),
      infrastructureFailure: isTransientExecutionResult(
        row.failure_result ? ExecutionResultSchema.parse(row.failure_result) : undefined),
    }))
    if (!hasExecutionRetryBudget(execution, attempts)) return false
    if (!await hasWorkflowExecutionCapacityLocked(sql, run.id, version)) return false
    // An abandoned attempt carries its recorded infrastructure cause, not a provider terminal.
    if (isTransientExecutionResult(execution.result)) return true
    // A result-bearing source receipt, not a terminal enum, distinguishes a real
    // provider failure from Stop/disposal/first-result validation failure.
    const row = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(`select p.record,p.source_digest from workflow_native_proofs p
      where p.run_id=$1 and p.execution_id=$2 and p.record#>>'{original,type}'='history'
        and p.record#>>'{original,history,terminalTurn,result,outcome}'='failed'
      order by p.proof_id`, [run.id, execution.id])).rows
    const exact = row.filter(({ record }) => {
      if (!record || typeof record !== 'object') return false
      const proof = record as { inputDigest?: unknown; original?: { history?: { terminalTurn?: { result?: unknown } } } }
      return proof.inputDigest === stored.inputDigest && sameRepeatValue(proof.original?.history?.terminalTurn?.result, execution.result)
    })
    if (!exact.length) return false
    for (const { record, source_digest } of exact) {
      if (repeatDigest(record, 4 * 1024 * 1024) !== source_digest || record.original.type !== 'history'
        || record.execution.executionId !== execution.id || record.scope.runId !== run.id) return conflict('NATIVE_SOURCE_CONFLICT')
      assertOriginalWorkflowTerminal(execution, record.session, record.original.history)
      const expected = { scope: record.scope,
        evidence: { sourceKind: 'native_event' as const, sourceId: record.proofId, sourceRevision: '1' },
        sourceDigest: source_digest, effect: null }
      await assertRepeatCanonicalReceiptLocked(sql, expected)
      requireRepeatCanonicalReceiptBeforeCommit(sql, expected)
    }
    return true
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

/** Cleanup requires native closure for every attempt. Restart can also retain
 * waiting executions verified against their original approval checkpoint. */
export async function assertWorkflowRunSettlementLocked(sql: GraphTransactionSql,
  run: AcceptedWorkflowRunV3, owner: RunOwnership, intent: 'success' | 'cleanup' | 'restart' = 'success',
  approvals?: WorkflowRestartApprovals): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  if (owner.runId !== run.id) return conflict('RUN_OWNERSHIP_LOST')
  if (approvals && intent !== 'restart') return conflict('GRAPH_INTERRUPT_INVALID')
  const retained = approvals ? await assertRestartApprovalsLocked(sql, run, approvals) : []
  const retainedPrincipals: string[] = []
  if (intent === 'restart') {
    await assertRestartAttemptsLocked(sql, run, owner, retained)
    const consultations = (await sql.query<{ principal_id: string }>(`select b.principal_id
      from worker_credential_bindings b join run_coordinator_consultations c
        on c.run_id=b.run_id and c.id=b.consultation_id and c.binding=b.consultation_binding
      join run_coordinator_mailboxes m on m.run_id=c.run_id and m.active_consultation_id=c.id
      where b.run_id=$1 and b.purpose='consultation' and c.native_target is not null
        and c.state in ('active','unknown','settling') and m.state='consultation'`, [run.id])).rows
    retainedPrincipals.push(...consultations.map(row => row.principal_id))
  } else {
    await visitRepeatNativeAttemptsLocked(sql, run.id, { kind: 'run' }, async ids => {
      await assertSettlementLocked(sql, run, ids, owner)
      if (intent === 'success') {
        const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
        const executions = await readRepeatExecutionsLocked(sql, snapshot, ids)
        const reviewers = await readRetainedRemoteReviewers(sql, executions.map(stored => stored.execution))
        retainedPrincipals.push(...reviewers.map(reviewer => reviewer.principalId))
      }
    })
  }
  if (intent !== 'cleanup' && !retained.length) await assertApprovalTerminalSettlement(sql, run.id)
  const pending = (await sql.query<{ pending: boolean }>(`select (
    exists(select 1 from durable_interactions i where i.run_id=$1 and i.status not in ('delivered','canceled')
      and not (i.execution_id=any($2::text[])))
    or exists(select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
      where i.run_id=$1 and j.state not in ('completed','failed') and not (i.execution_id=any($2::text[])))
    or exists(select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
      where b.run_id=$1 and (b.revoked_at is null or p.id is null or p.revoked_at is null)
      and not (b.execution_id=any($2::text[])) and not (b.principal_id=any($3::text[])))
    or exists(select 1 from approval_execution_state b join harness_executions e on e.id=b.execution_id
      where e.run_id=$1 and (b.active_started_at is not null or b.approval_wait_started_at is not null)
      and not (e.id=any($2::text[])))
    or ($4<>'restart' and exists(select 1 from run_coordinator_consultations c where c.run_id=$1
      and (c.state not in ('completed','failed','canceled')
        or c.browser_input is not null and c.browser_state is distinct from 'released')))
    ) as pending`, [run.id, retained, retainedPrincipals, intent])).rows[0]
  if (pending?.pending !== false) return conflict('REPEAT_CLEANUP_PENDING')
}

/** The repository passes terminals derived from ALL settled selected paths. The
 * writer independently rereads their immutable accepted records. The aggregate
 * is an output view only: exact source identities and full accepted envelopes
 * remain immutable in run_repeat_results and canonical acceptance receipts.
 * Every terminal handoff activation is retained, including earlier revisions. */
export async function completeRunLocked(sql: GraphTransactionSql, suppliedRun: AcceptedWorkflowRunV3,
  suppliedVersion: WorkflowVersionV3, suppliedTerminals: readonly RepeatSource[], owner: RunOwnership): Promise<void> {
  assertGraphTransaction(sql)
  try {
    owner.assertOwned()
    const snapshot = await readAcceptedRepeatRunLocked(sql, owner.runId)
    const { run, version } = snapshot
    if (!sameRepeatValue(run, suppliedRun) || !sameRepeatValue(version, suppliedVersion)) return conflict('RUN_PIN_CONFLICT')
    if (snapshot.stopRequested || snapshot.cleanupPending) return conflict('GRAPH_STOP_CONFLICT')
    if (!['running', 'waiting'].includes(run.executionState)) return conflict('GRAPH_TERMINAL_CONFLICT')
    const terminals = [...structuredClone(suppliedTerminals)].sort((a, b) =>
      a.execution.workflowNodeId.localeCompare(b.execution.workflowNodeId)
      || a.execution.executionId.localeCompare(b.execution.executionId))
    if (!terminals.length || terminals.length > version.definition.executionPolicy!.maxNodeExecutions
      || new Set(terminals.map((item) => item.execution.executionId)).size !== terminals.length) return conflict('WORKFLOW_UNRESOLVED')
    const scope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
      workflowVersionId: version.id, executionSemanticsVersion: 3 as const }
    const outputs: Array<{ nodeId: string; executionId: string; result: NonNullable<ExecutionResult['output']> | null }> = []
    const activationIds = new Set<string>()
    const ids = terminals.map(terminal => terminal.execution.executionId)
    const storedTerminals = await readRepeatExecutionsLocked(sql, snapshot, ids)
    const acceptedRows = await sql.query<{ execution_id: string; result_digest: string; result_json: string }>(
      'select execution_id,result_digest,result_json from run_repeat_results where run_id=$1 and execution_id=any($2::text[])',
      [run.id, ids])
    const acceptedById = new Map(acceptedRows.rows.map(row => [row.execution_id, row]))
    const workRows = version.definition.handoffs ? (await sql.query<{
      execution_id: string; activation_id: string; result_digest: string
    }>(`select x.execution_id,x.activation_id,x.result_digest from run_work_results x
        join run_work_activations a on a.run_id=x.run_id and a.activation_id=x.activation_id
      where x.run_id=$1 and x.execution_id=any($2::text[]) and a.state='completed'`, [run.id, ids])).rows : []
    const workById = new Map(workRows.map(row => [row.execution_id, row]))
    for (const [index, terminal] of terminals.entries()) {
      const stored = storedTerminals[index]!
      assertRepeatSource(version, scope, terminal, stored.execution, stored.accepted)
      AcceptedCurrentNodeResultSchema.parse(stored.execution.result)
      if (version.definition.handoffs) {
        const work = workById.get(stored.execution.id)
        if (!work || work.activation_id !== stored.workActivationId
          || work.result_digest !== terminal.acceptedResultDigest || activationIds.has(work.activation_id)) {
          return conflict('WORK_RESULT_RECEIPT_MISSING')
        }
        activationIds.add(work.activation_id)
      }
      const accepted = acceptedById.get(stored.execution.id)
      if (!accepted || accepted.result_digest !== terminal.acceptedResultDigest
        || repeatDigest(JSON.parse(accepted.result_json), 64 * 1024) !== accepted.result_digest) return conflict('REPEAT_INPUT_NOT_ACCEPTED')
      outputs.push({ nodeId: stored.ref.nodeId, executionId: stored.execution.id, result: stored.execution.result!.output ?? null })
    }
    await assertWorkflowRunSettlementLocked(sql, run, owner)
    const result: ExecutionResult = { outcome: 'succeeded', output: outputs.length === 1 ? outputs[0]!.result : { outputs } }
    const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'completed', outcome: 'succeeded',
      result, finishedAt: new Date().toISOString() })
    try { canonicalGraphJson(next, RUN_GRAPH_LIMITS.transactionBytes) } catch { return conflict('WORKFLOW_RESULT_TOO_LARGE') }
    const fence = await owner.readOneShotFence(sql)
    await sql.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=clock_timestamp()`, [run.id])
    const changed = await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [run.id, next.executionState, JSON.stringify(next)])
    if (changed.rowCount !== 1) return conflict('RUN_PIN_CONFLICT')
    // Called inside the existing run.complete effect, whose G1 finalizer commits
    // the actual Run/source/presentation and completion effect atomically.
    beforeGraphCommit(sql, async () => {
      owner.assertOwned()
      const final = await readAcceptedRepeatRunLocked(sql, run.id)
      if (!sameRepeatValue(final.run, next) || final.stopRequested || !final.cleanupPending
        || !sameRepeatValue(fence, await owner.readOneShotFence(sql))) return conflict('RUN_PIN_CONFLICT')
    })
  } catch (error) { poisonGraphTransaction(sql); throw error }
}
