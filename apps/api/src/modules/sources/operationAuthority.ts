import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { ResolvedJobDefinitionSpecRecordSchema } from '@foreman-code/contracts/job-verification'
import { isDeepStrictEqual } from 'node:util'
import { SourceFilesystemOperationSchema, SourceOperationOwnerSchema, type SourceFilesystemOperation, type SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { ApprovedSourceSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError, retryDatabaseRead } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { SourceAttemptAuthority, SourceActiveNativeSessionReader } from './executionHosts.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { assertAcceptedSourceRelativeCwd } from './agentSourceAuthority.js'
import type { MaterializationAttempt } from './ports.js'
import { resolvePreparationReconciliationOwner } from './preparationReconciliation.js'
import { requireUnreclaimedSourceOperation } from './reservations.js'
import { agentWorktree } from './service.js'
import { retainedNodeReceipt, retainsNodeWorkingTree } from './retainedNodeSource.js'

/** Actual Main allocation/source facts; workers receive no database credentials. */
export class PostgresSourceOperationAuthority {
  constructor(private readonly pool: pg.Pool, private readonly attempts: SourceAttemptAuthority,
    private readonly closure: (sql: GraphSqlClient, record: SourceMaterializationRecord) => Promise<boolean>,
    private readonly activeNativeSession?: SourceActiveNativeSessionReader) {}
  private async transaction<T>(work: (sql: GraphSqlClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }
  private async allocation(sql: GraphSqlClient, attempt: MaterializationAttempt) {
    const rows = await sql.query<{ operation_id: string; principal_id: string; preparation_kind: 'job' | 'workflow' }>(`select operation_id,principal_id,'job' preparation_kind from job_preparations where execution_id=$1 and attempt_id=$2
      union all select p.preparation->>'operationId',r.record->>'authorizationPrincipalId','job' from workflow_job_preparations p
      join runs r on r.id=p.preparation->>'runId' where p.preparation->>'executionId'=$1 and p.preparation->>'attemptId'=$2
      union all select i.operation_id,r.record->>'authorizationPrincipalId','workflow' from execution_dispatch_intents i
      join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id and e.workflow_node_id=i.node_id
      join runs r on r.id=i.run_id where i.execution_id=$1 and i.attempt_id=$2`, [attempt.executionId, attempt.attemptId])
    if (rows.rows.length !== 1) throw new DomainError('SOURCE_ALLOCATION_CONFLICT', 'The original actual Main preparation is missing or ambiguous.', 409)
    return rows.rows[0]!
  }
  async authorizePreparation(sql: GraphSqlClient, root: SourceRootRecord, attempt: MaterializationAttempt,
    identity: { operationId: string; ownerPrincipalId: string; expiresAt: string }) {
    await requireUnreclaimedSourceOperation(sql, identity.operationId)
    if ((await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1', [identity.operationId])).rowCount)
      throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original source transfer is fenced for reconciliation.', 409)
    const allocated = await this.allocation(sql, attempt), principal = await readLiveManagementPrincipal(sql, allocated.principal_id)
    if (identity.operationId !== allocated.operation_id || identity.ownerPrincipalId !== principal.id || Date.parse(identity.expiresAt) > Date.parse(principal.expiresAt)
      || Date.parse(identity.expiresAt) <= Date.now()) throw new DomainError('SOURCE_OWNER_CONFLICT', 'The original source package allocation owner is expired or differs.', 403)
    await this.attempts.authorize(sql, principal, { workspaceId: root.binding.workspaceId, root, attempt, operationId: allocated.operation_id })
    return principal
  }
  /** Read-only: the identity is used only after this transaction ends, so it reads committed Run rows. */
  async prepareIdentity(root: SourceRootRecord, attempt: MaterializationAttempt) {
    return retryDatabaseRead(() => this.transaction(async sql => {
      const allocated = await this.allocation(sql, attempt), principal = await readLiveManagementPrincipal(sql, allocated.principal_id)
      await requireUnreclaimedSourceOperation(sql, allocated.operation_id)
      if ((await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1', [allocated.operation_id])).rowCount)
        throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original preparation is fenced for reconciliation.', 409)
      await this.attempts.authorize(sql, principal, { workspaceId: root.binding.workspaceId, root, attempt, operationId: allocated.operation_id }, false)
      return { operationId: allocated.operation_id, ownerPrincipalId: principal.id, expiresAt: principal.expiresAt }
    }))
  }
  async resolve(raw: SourceFilesystemOperation, binding: Readonly<DeviceConnectionIdentity>): Promise<SourceOperationOwner> {
    const request = SourceFilesystemOperationSchema.parse(raw)
    if (request.operation === 'sources.reconcile-preparation') return this.transaction(async sql => {
      const owner = await resolvePreparationReconciliationOwner(sql, request.reconciliationId), root = owner.root
      if (root.selection.hostRef.kind !== 'device' || !root.registration || root.binding.mainId !== binding.mainId
        || root.binding.deviceId !== binding.deviceId || root.binding.workerInstallationId !== binding.workerInstallationId
        || root.registration.keyRevision !== binding.keyRevision || root.registration.authorizationRevision !== binding.authorizationRevision)
        throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Cleanup requires the exact original authenticated worker registration.', 403)
      return owner
    })
    // Idempotent: a lock or statement timeout rolls back before any effect and is replayed.
    return retryDatabaseRead(() => this.transaction(async sql => {
      const preparing = request.operation === 'sources.prepare' || request.operation === 'sources.capacity'
      const receipt = preparing ? null : request.record.receipt
      const attempt = preparing ? request.attempt : { placementHash: receipt!.placementHash, executionId: receipt!.executionId,
        attemptId: receipt!.attemptId, keyRevision: receipt!.keyRevision, authorizationRevision: receipt!.authorizationRevision }
      const allocated = await this.allocation(sql, attempt)
      if (request.operation !== 'sources.release') await requireUnreclaimedSourceOperation(sql, allocated.operation_id)
      const cleanup = request.operation === 'sources.release'
      const principal = cleanup ? undefined : await readLiveManagementPrincipal(sql, allocated.principal_id)
      if (request.operation === 'sources.verify') await assertAcceptedSourceRelativeCwd(sql, attempt.executionId, request.relativeCwd)
      const requestedBinding = preparing ? request.root.binding : receipt!.binding
      if (request.operation !== 'sources.release' && (await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1', [allocated.operation_id])).rowCount)
        throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original preparation is fenced for reconciliation.', 409)
      const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share', [requestedBinding.rootId, requestedBinding.bindingRevision])).rows[0]
      const root = SourceRootRecordSchema.parse(row?.record)
      if (!isDeepStrictEqual(root.binding, requestedBinding) || root.selection.hostRef.kind !== 'device' || root.binding.deviceId !== binding.deviceId
        || root.binding.mainId !== binding.mainId || root.binding.workerInstallationId !== binding.workerInstallationId || !root.registration
        || root.registration.keyRevision !== binding.keyRevision || root.registration.authorizationRevision !== binding.authorizationRevision)
        throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source operation is not bound to its original current authenticated device.', 409)
      // The Worker acts on this owner only after the reply, so the Run rows are read without locks.
      if (principal) await this.attempts.authorize(sql, principal, { workspaceId: root.binding.workspaceId, root, attempt, operationId: allocated.operation_id }, false)
      const snapshot = (await sql.query<{ availability: string; record: unknown }>('select availability,record from source_snapshots where workspace_id=$1 and approved_source_id=$2 and snapshot_id=$3 and manifest_digest=$4 for share',
        [root.binding.workspaceId, root.source.approvedSourceId, root.source.snapshotId, root.source.manifestDigest])).rows[0]
      if ((request.operation !== 'sources.release' || receipt?.quota) && snapshot?.availability !== 'retained') throw new DomainError('SOURCE_UNAVAILABLE', 'The original approved source is not retained.', 410)
      let record: SourceMaterializationRecord | null = null, physicalClosureConfirmed = false
      if (!preparing) {
        const lock = cleanup ? 'for update' : 'for share'
        const stored = (await sql.query<{ record: unknown; state: string }>(`select record,state from source_execution_materializations where materialization_id=$1 and execution_id=$2 and attempt_id=$3 and operation_id=$4 ${lock}`,
          [receipt!.materializationId, attempt.executionId, attempt.attemptId, allocated.operation_id])).rows[0]
        record = SourceMaterializationRecordSchema.parse(stored?.record)
        if (!isDeepStrictEqual(record, request.record)) throw new DomainError('SOURCE_RECORD_CONFLICT', 'The submitted record is not the actual immutable Main materialization.', 409)
        if (request.operation !== 'sources.release' && !['prepared', 'running'].includes(stored!.state))
          throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original source materialization is no longer owned for execution.', 409)
        if (request.operation !== 'sources.release' && record.finalDispatchBindingHash) await this.attempts.authorizeFinal(sql, principal!, record, record.finalDispatchBindingHash, false)
        if (request.operation === 'sources.release') {
          await authorizeClosedSourceRelease(sql, root, record, this.closure)
          physicalClosureConfirmed = true
        }
      }
      let identity: SourceOperationOwner['identity']
      if (cleanup) {
        const lease = (await sql.query<{ expires_at: Date }>(`update source_execution_materializations
          set cleanup_lease_expires_at=case when cleanup_lease_expires_at>clock_timestamp()
            then cleanup_lease_expires_at else clock_timestamp()+interval '60 seconds' end
          where materialization_id=$1 and record=$2::jsonb returning cleanup_lease_expires_at as expires_at`,
        [record!.receipt.materializationId, JSON.stringify(record)])).rows[0]
        if (!lease) throw new DomainError('SOURCE_RECORD_CONFLICT', 'The original cleanup record changed.', 409)
        identity = { operationId: allocated.operation_id, ownerPrincipalId: allocated.principal_id,
          expiresAt: lease.expires_at.toISOString() }
      } else {
        const live = principal!
        identity = preparing ? request.identity
          : { operationId: allocated.operation_id, ownerPrincipalId: live.id, expiresAt: live.expiresAt }
        if (identity.operationId !== allocated.operation_id || identity.ownerPrincipalId !== live.id
          || Date.parse(identity.expiresAt) > Date.parse(live.expiresAt) || Date.parse(identity.expiresAt) <= Date.now()) {
          throw new DomainError('SOURCE_OWNER_CONFLICT',
            'Source ownership is expired or differs from the actual Main allocation.', 403)
        }
      }
      const selected = (await sql.query<{ spec: unknown }>('select spec from job_computer_selections where execution_id=$1',
        [attempt.executionId])).rows[0]
      const quotaRequired = Boolean(record?.receipt.quota || selected && 'verification' in
        ResolvedJobDefinitionSpecRecordSchema.parse(selected.spec))
      const activeNativeSession = request.operation === 'sources.verify' && record?.receipt.binding.accessMode === 'exclusive-write'
        ? await this.activeNativeSession?.(sql, record) ?? null : null
      const worktree = request.operation === 'sources.prepare' && allocated.preparation_kind === 'workflow'
        && root.binding.accessMode === 'exclusive-write'
        ? await agentWorktree(sql, attempt.executionId, ApprovedSourceSchema.parse(snapshot?.record).manifest) : undefined
      if (request.operation === 'sources.prepare' && !isDeepStrictEqual(request.worktree, worktree)) {
        throw new DomainError('SOURCE_WORKTREE_CONFLICT', 'Preparation cannot substitute the accepted Agent branch request.', 409)
      }
      const retainedReceipt = request.operation === 'sources.prepare' && allocated.preparation_kind === 'workflow'
        ? await retainedNodeReceipt(sql, attempt.executionId, root.binding) : undefined
      if (request.operation === 'sources.prepare' && !isDeepStrictEqual(request.retainedReceipt, retainedReceipt)) {
        throw new DomainError('SOURCE_RECEIPT_CONFLICT', 'Preparation cannot substitute the retained node directory.', 409)
      }
      const retainWorkingTree = request.operation === 'sources.release'
        && await retainsNodeWorkingTree(sql, attempt.executionId)
      return SourceOperationOwnerSchema.parse({ identity, root, attempt, source: root.source, record, physicalClosureConfirmed, activeNativeSession,
        ...(retainedReceipt ? { retainedReceipt } : {}), ...(retainWorkingTree ? { retainWorkingTree: true } : {}),
        ...(worktree ? { worktree } : {}),
        ...(quotaRequired ? { quotaRequired: true } : {}),
        ...(allocated.preparation_kind === 'workflow' ? { preparationKind: 'workflow' } : {}) })
    }))
  }
}

/** Cleanup confers no execution authority. Terminal Runs can release only their
 * exact original claim after positive Main closure and current root/device auth. */
export async function authorizeClosedSourceRelease(sql: GraphSqlClient, root: SourceRootRecord, record: SourceMaterializationRecord,
  closure: (sql: GraphSqlClient, record: SourceMaterializationRecord) => Promise<boolean>): Promise<void> {
  if (!isDeepStrictEqual(root.binding, record.receipt.binding) || record.rootPolicyId !== root.selection.rootPolicyId
    || record.rootPolicyRevision !== root.selection.rootPolicyRevision || !await closure(sql, record))
    throw new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'Original physical ownership closure is not positively confirmed.', 409)
  const policy = await sql.query('select 1 from workspace_root_policies where workspace_id=$1 and root_policy_id=$2 and root_policy_revision=$3 and revoked_at is null for share',
    [root.binding.workspaceId, record.rootPolicyId, record.rootPolicyRevision])
  if (policy.rowCount !== 1) throw new DomainError('ROOT_POLICY_UNAVAILABLE', 'The exact original root policy is unavailable or revoked.', 409)
  const registration = await assertDeviceHostInstallation(sql, root.selection.hostRef, root.binding.workerInstallationId ?? root.binding.mainId)
  if (!root.registration || !registration || registration.keyRevision !== root.registration.keyRevision
    || registration.authorizationRevision !== root.registration.authorizationRevision)
    throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Original device authority is unavailable or revoked.', 403)
}
