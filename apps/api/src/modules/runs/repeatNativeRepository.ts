import { type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { retainWorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import type { WorkflowNativeEntryPermit } from './workflowNativeEntry.js'
import type { RepeatNodeRef, RepeatScope } from './repeatResolution.js'

export interface RepeatLaunchPaths { workingDirectory: string; runtimeDirectory: string }
/** The immutable launch envelope is reconstructible after a restart. Mutable
 * lifecycle/result/session fields must never change its receipt digest. */
export interface RepeatLaunchClaim {
  scope: RepeatScope
  ref: RepeatNodeRef
  executionId: string
  agentId: string
  agentConfigurationVersionId: string
  technicalAttempt: number
  inputDigest: string
  createdAt: string
  startedAt: string
  workingDirectory: string
  runtimeDirectory: string
  systemPrompt?: HarnessExecution['systemPrompt']
  sessionContinuation?: HarnessExecution['sessionContinuation']
}
export function repeatLaunchClaim(scope: RepeatScope, ref: RepeatNodeRef, execution: HarnessExecution,
  inputDigest: string): RepeatLaunchClaim {
  if (!execution.agentConfigurationVersionId || !execution.startedAt
    || !execution.workingDirectory || !execution.runtimeDirectory
    || execution.runId !== scope.runId || execution.workflowNodeId !== ref.nodeId
    || ref.occurrence && (ref.occurrence.scope.runId !== scope.runId
      || ref.occurrence.scope.workspaceId !== scope.workspaceId
      || ref.occurrence.scope.workflowId !== scope.workflowId
      || ref.occurrence.scope.workflowVersionId !== scope.workflowVersionId
      || ref.occurrence.scope.executionSemanticsVersion !== 3)
    || scope.executionSemanticsVersion !== 3
    || !Number.isInteger(execution.attempt) || execution.attempt < 1 || execution.attempt > 2147483647
    || !/^sha256:[0-9a-f]{64}$/.test(inputDigest)) {
    throw new DomainError('REPEAT_LAUNCH_IDENTITY_CONFLICT', 'The exact occurrence launch envelope is incomplete.', 409)
  }
  return {
    scope: structuredClone(scope), ref: structuredClone(ref), executionId: execution.id, agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId,
    technicalAttempt: execution.attempt, inputDigest, createdAt: execution.createdAt,
    startedAt: execution.startedAt, workingDirectory: execution.workingDirectory,
    runtimeDirectory: execution.runtimeDirectory,
    ...(execution.systemPrompt ? { systemPrompt: structuredClone(execution.systemPrompt) } : {}),
    ...(execution.sessionContinuation ? { sessionContinuation: structuredClone(execution.sessionContinuation) } : {}),
  }
}

/** Opaque to this repository, but mandatory and verified by the existing native
 * authority adapter, not by a boolean supplied by a caller. The adapter owns the
 * concrete live-lease / same-command history receipts (NATIVE-2). Evidence must
 * be bounded JSON provenance, never a credential, process handle or mutable
 * manager object. No evidence payload is sent to the public graph. */
export interface RepeatNativeEvidence {
  kind: 'live' | 'recovery'
  session: NativeSessionReference
  evidence: unknown
}
/** Capture the private original source before asynchronous guards run. This is
 * shape/bounds validation only, NEVER authority or a substitute for raw receipts. */
export function captureRepeatNativeEvidence(input: RepeatNativeEvidence): RepeatNativeEvidence {
  return retainWorkflowNativeCapture(input)
}
export type RepeatNativeBoundaryEvidence =
  | { kind: 'first_launch'; permit: WorkflowNativeEntryPermit }
  | RepeatNativeEvidence
export interface RepeatNativeChange {
  kind: 'launch' | 'observation' | 'session_recovery' | 'native_entry' | 'negative_settlement'
  scope: RepeatScope
  ref: RepeatNodeRef
  previous: HarnessExecution
  next: HarnessExecution
  /** Includes the ORIGINAL incoming observation, before result normalization.
   * Private source evidence: never serialize it into public graph facts. */
  source: unknown
  sourceDigest: string
  sourceId: string
  sourceRevision: string
  effect: { kind: 'execution.launch'; entityId: string; digest: string } | null
}
/** Mandatory native capability on the existing transaction host. No native I/O,
 * credentials, filesystem allocation, or pool transaction may occur here. */
export interface RepeatNativeLockedHooks {
  assertLaunchLocked(sql: GraphTransactionSql, execution: HarnessExecution, ref: RepeatNodeRef,
    paths: RepeatLaunchPaths): Promise<void>
  assertBoundaryLocked(sql: GraphTransactionSql, execution: HarnessExecution, ref: RepeatNodeRef,
    evidence: RepeatNativeBoundaryEvidence): Promise<void>
  assertUpdateLocked(sql: GraphTransactionSql, previous: HarnessExecution, incoming: HarnessExecution,
    ref: RepeatNodeRef, evidence: RepeatNativeEvidence): Promise<WorkflowNativeProofRecord>
  /** The canonical G1 producer must retain source/effect/reset receipts on this
   * transaction. A callback result is not a receipt. No second graph journal. */
  publishLocked(sql: GraphTransactionSql, change: RepeatNativeChange, mutate: () => Promise<void>): Promise<void>
  /** Must prove the exact canonical receipt through the owning transaction's
   * finalization. A detached pool read or run_repeat_effects alone is insufficient. */
  assertReceiptLocked(sql: GraphTransactionSql, change: RepeatNativeChange): Promise<void>
  assertLaunchReceiptLocked(sql: GraphTransactionSql, claim: RepeatLaunchClaim, digest: string): Promise<void>
}
export function requireRepeatNativeHooks(hooks: RepeatNativeLockedHooks | undefined): RepeatNativeLockedHooks {
  if (!hooks || ['assertLaunchLocked', 'assertBoundaryLocked', 'assertUpdateLocked', 'publishLocked',
    'assertReceiptLocked', 'assertLaunchReceiptLocked'].some((key) => typeof hooks[key as keyof RepeatNativeLockedHooks] !== 'function')) {
    throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'The canonical repeat native repository host is not installed.', 409)
  }
  return hooks
}

/** Conservative possible-submission evidence. Missing launch receipts are NOT
 * permission to submit if any allocation/preflight/native/credential evidence
 * exists. This is the same existing lifetime protocol; it creates no new table. */
export async function repeatPossibleSubmissionLocked(sql: GraphTransactionSql, execution: HarnessExecution): Promise<boolean> {
  if (execution.state !== 'queued' || execution.startedAt || execution.finishedAt || execution.result
    || execution.nativeSessionId || execution.workingDirectory || execution.runtimeDirectory) return true
  const result = await sql.query<{ possible_submission: boolean }>(`select (
    exists(select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch' and entity_id=$2)
    or exists(select 1 from execution_native_sessions where execution_id=$2)
    or exists(select 1 from execution_native_closures where execution_id=$2)
    or exists(select 1 from harness_native_events where execution_id=$2)
    or exists(select 1 from run_native_correlations where run_id=$1 and execution_id=$2)
    or exists(select 1 from worker_credential_bindings where execution_id=$2)
    or exists(select 1 from approval_execution_state where execution_id=$2)
    or exists(select 1 from durable_interactions where execution_id=$2)
    or exists(select 1 from review_jobs where execution_id=$2)
  ) as possible_submission`, [execution.runId, execution.id])
  if (result.rows.length !== 1 || typeof result.rows[0]!.possible_submission !== 'boolean') {
    throw new DomainError('REPEAT_SUBMISSION_EVIDENCE_MISSING', 'Submission absence was not established.', 409)
  }
  return result.rows[0]!.possible_submission
}
