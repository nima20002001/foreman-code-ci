import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { AcceptedNodePlacementSchema, DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { hasPositiveRemoteEntryClosure, hasPositiveRemoteNonEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { SourceMaterializationRecordSchema, SourcePreparationClosureSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceOperationOwnerSchema } from '@foreman-code/contracts/source-operations'
import { DomainError } from '../errors.js'
import { readUnboundWorkflowClosure } from '../interactions/workflowClosure.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { sourceBindingHash } from './bindingHash.js'
import type { SourceReservation } from './reservations.js'

export async function loadWorkflowPreparation(sql: GraphSqlClient, workspaceId: string, operationId: string) {
  const row = (await sql.query<{
    intent: unknown; execution: unknown; placement: unknown; principal_id: string;
    execution_state: string; stop_requested: boolean; cleanup_pending: boolean; session_bound: boolean; session_reference: unknown | null;
    reservation: SourceReservation; reservation_state: string; reserved_bytes: string;
    materialization: unknown | null; reconciliation_id: string | null; command_id: string | null;
    status: string | null; owner: unknown | null; closure: unknown | null;
  }>(`select i.record as intent,e.record as execution,p.record as placement,
      r.record->>'authorizationPrincipalId' as principal_id,r.execution_state,r.stop_requested_at is not null as stop_requested,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending,
      exists(select 1 from execution_native_sessions n where n.execution_id=e.id) as session_bound,
      (select n.reference from execution_native_sessions n where n.execution_id=e.id) as session_reference,
      s.record as reservation,s.state as reservation_state,s.reserved_bytes,m.record as materialization,
      c.reconciliation_id,c.command_id,c.status,c.owner,c.closure
    from execution_dispatch_intents i join harness_executions e on e.id=i.execution_id
    join runs r on r.id=e.run_id
    join run_node_placements p on p.run_id=r.id and p.node_id=e.workflow_node_id
    join source_storage_reservations s on s.owner_kind='materialization' and s.owner_id=i.operation_id
    left join source_execution_materializations m on m.operation_id=i.operation_id
    left join source_preparation_reconciliations c on c.operation_id=i.operation_id
    where r.workspace_id=$1 and i.operation_id=$2 for share of i,e,r,s`, [workspaceId, operationId])).rows[0]
  if (!row) throw new DomainError('SOURCE_PREPARATION_NOT_FOUND', 'The original source preparation was not found.', 404)
  const intent = DispatchIntentSchema.parse(row.intent)
  const execution = HarnessExecutionSchema.parse(row.execution)
  const nativeSession = row.session_reference === null ? null : NativeSessionReferenceSchema.parse(row.session_reference)
  if ((execution.nativeSessionId ?? null) !== (nativeSession?.nativeSessionId ?? null)) {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original native session binding changed.', 409)
  }
  const placement = AcceptedNodePlacementSchema.parse(row.placement)
  const source = placement.source
  if (!('kind' in source) || source.kind !== 'pending') {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The workflow has no original source preparation.', 409)
  }
  const rootRow = (await sql.query<{ record: unknown }>(
    'select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share',
    [workspaceId, source.rootId, source.bindingRevision],
  )).rows[0]
  const root = SourceRootRecordSchema.parse(rootRow?.record)
  const binding = root.binding
  const scopeId = `${binding.mainId}:${binding.deviceId ?? 'original-main'}:${binding.workerInstallationId ?? binding.mainId}:${binding.filesystem.device}:${binding.filesystem.mountId}`
  const attempt = {
    executionId: execution.id, attemptId: intent.attemptId,
    keyRevision: root.registration?.keyRevision ?? null,
    authorizationRevision: root.registration?.authorizationRevision ?? null,
    placementHash: '',
  }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const record = row.materialization === null ? null : SourceMaterializationRecordSchema.parse(row.materialization)
  if (intent.operationId !== operationId || intent.executionId !== execution.id || intent.runId !== execution.runId
    || intent.nodeId !== execution.workflowNodeId || intent.technicalAttempt !== execution.attempt
    || placement.runId !== intent.runId || placement.nodeId !== intent.nodeId || placement.bindingHash !== intent.bindingHash
    || placement.payload.kind !== 'agent' || placement.payload.agentId !== execution.agentId
    || placement.payload.agentConfigurationVersionId !== execution.agentConfigurationVersionId
    || binding.mainId !== intent.mainId || placement.mainId !== intent.mainId || binding.workspaceId !== workspaceId
    || binding.rootId !== source.rootId || binding.bindingRevision !== source.bindingRevision
    || root.selection.rootPolicyId !== placement.destination.rootPolicyId
    || root.selection.rootPolicyRevision !== placement.destination.rootPolicyRevision
    || root.source.approvedSourceId !== source.approvedSourceId || root.source.snapshotId !== source.snapshotId
    || root.source.manifestDigest !== source.manifestDigest || !isDeepStrictEqual(root.selection.hostRef, placement.hostRef)
    || !isDeepStrictEqual(root.registration, placement.registration)
    || row.reservation.ownerKind !== 'materialization' || row.reservation.ownerId !== operationId
    || row.reservation.scopeId !== scopeId
    || record && (record.operationId !== operationId || record.reservationId !== row.reservation.reservationId
      || !isDeepStrictEqual(record.receipt.binding, binding) || record.receipt.executionId !== execution.id
      || record.receipt.attemptId !== intent.attemptId || record.sourceBindingHash !== attempt.placementHash)) {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original workflow source reservation changed.', 409)
  }
  return { ...row, kind: 'workflow' as const, execution, nativeSession, root, attempt, record, operationId, workspaceId }
}

export async function assertWorkflowPreparationClosed(
  sql: GraphSqlClient,
  state: Awaited<ReturnType<typeof loadWorkflowPreparation>>,
): Promise<void> {
  const execution = state.execution
  const fenced = state.execution_state === 'completed' || state.stop_requested || state.cleanup_pending
  if (!fenced || execution.result?.outcome === 'succeeded'
    || (execution.nativeSessionId ?? null) !== (state.nativeSession?.nativeSessionId ?? null)
    || state.session_bound !== Boolean(state.nativeSession)) {
    throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'Stop the workflow before reconciling its original worker session.', 409)
  }
  const entry = (await sql.query<{ phase: string; reservation: { execution: unknown } }>(
    'select phase,reservation from workflow_native_entries where execution_id=$1 and run_id=$2 for share',
    [execution.id, execution.runId],
  )).rows[0]
  if (!entry || !isDeepStrictEqual(entry.reservation.execution, repeatExecutionIdentity(execution))
    || !['reserved', 'prepared', 'entered', 'not_submitted'].includes(entry.phase)) {
    throw new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'The original workflow launch is not closed.', 409)
  }
}

/** A completed worker reconciliation is physical closure; a pending Stop alone is not. */
export async function remoteWorkflowPreparationClosed(sql: GraphSqlClient, executionId: string): Promise<boolean> {
  const allocation = (await sql.query<{ operation_id: string; workspace_id: string }>(`select i.operation_id,r.workspace_id
    from execution_dispatch_intents i join runs r on r.id=i.run_id where i.execution_id=$1`, [executionId])).rows[0]
  if (!allocation) return false
  const retained = (await sql.query<{ receipt: unknown; session_bound: boolean }>(
    `select receipt,exists(select 1 from execution_native_sessions where execution_id=$2) as session_bound
      from remote_execution_receipts where operation_id=$1`, [allocation.operation_id, executionId])).rows[0]
  if (retained && !retained.session_bound) {
    const receipt = RemoteOperationReceiptSchema.parse(retained.receipt)
    const current = await readReconciledDispatchIntent(sql, allocation.operation_id)
    if (receipt.intent.executionId === executionId && isDeepStrictEqual(current, receipt.intent)
      && (hasPositiveRemoteEntryClosure(receipt) || hasPositiveRemoteNonEntryClosure(receipt))) return true
  }
  const state = await loadWorkflowPreparation(sql, allocation.workspace_id, allocation.operation_id)
  const automatic = state.status === null && state.reservation.preparationClosure
  const rawClosure = state.closure ?? automatic
  const rawOwner = state.owner ?? (automatic ? state.reservation.reclamation?.owner : null)
  const reconciliationId = state.reconciliation_id ?? (automatic ? state.reservation.reclamation?.reclamationId : null)
  if ((state.status !== 'closed' && !automatic) || !rawClosure || !rawOwner
    || state.root.selection.hostRef.kind !== 'device') return false
  await assertWorkflowPreparationClosed(sql, state)
  const closure = SourcePreparationClosureSchema.parse(rawClosure)
  const owner = SourceOperationOwnerSchema.parse(rawOwner)
  const binding = state.root.binding
  return owner.preparationKind === 'workflow' && owner.preparationClosed === true
    && isDeepStrictEqual(owner.root, state.root) && isDeepStrictEqual(owner.attempt, state.attempt)
    && isDeepStrictEqual(owner.record, state.record)
    && isDeepStrictEqual(owner.preparationNativeSession ?? null, state.nativeSession)
    && closure.reconciliationId === reconciliationId && closure.operationId === state.operationId
    && closure.executionId === executionId && closure.attemptId === state.attempt.attemptId
    && closure.rootId === binding.rootId && closure.bindingRevision === binding.bindingRevision
    && closure.materializationId === (state.record?.receipt.materializationId ?? null)
    && closure.mainId === binding.mainId && closure.deviceId === binding.deviceId
    && closure.workerInstallationId === binding.workerInstallationId
    && closure.keyRevision === state.attempt.keyRevision && closure.authorizationRevision === state.attempt.authorizationRevision
    && isDeepStrictEqual(closure.filesystem, binding.filesystem)
}

export async function localWorkflowPreparationClosed(
  sql: GraphSqlClient, owner: ReturnType<typeof SourceOperationOwnerSchema.parse>,
): Promise<boolean> {
  const state = await loadWorkflowPreparation(sql, owner.root.binding.workspaceId, owner.identity.operationId)
  await assertWorkflowPreparationClosed(sql, state)
  if (state.execution_state !== 'completed' || state.execution.state !== 'completed' || state.cleanup_pending
    || state.nativeSession
    || state.root.selection.hostRef.kind !== 'main' || !isDeepStrictEqual(state.root, owner.root)
    || !isDeepStrictEqual(state.attempt, owner.attempt)) return false
  const entry = (await sql.query<{ phase: string }>(
    'select phase from workflow_native_entries where execution_id=$1 and run_id=$2',
    [state.execution.id, state.execution.runId],
  )).rows[0]
  if (entry?.phase === 'not_submitted') return true
  return Boolean(await readUnboundWorkflowClosure(sql, state.execution))
}
