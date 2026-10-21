import { randomUUID } from 'node:crypto'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { readLiveManagementPrincipal } from '../../src/modules/access/liveManagementPrincipal.js'
import { bindNativeExecution } from '../../src/modules/placement/executionBinding.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement,
  insertNativePlacement } from '../../src/modules/placement/persistence.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../../src/modules/sources/bindingHash.js'
import { sourceCwdAttestationDigest } from '../../src/modules/sources/workingDirectory.js'
import { PostgresSourceReservations } from '../../src/modules/sources/reservations.js'
import { repeatRuntimeDirectory } from '../../src/modules/runs/repeatRepositoryHost.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'
import type { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { sourceStorageCapacityFixture } from './sourceStorageCapacityFixture.js'

/** Synthetic host filesystem receipts feed the real native binding and launch
 * gates. Live profile and source authorization remain the production services. */
export async function prepareHandoffSource(owner: RunOwnership, run: AcceptedWorkflowRunV3,
  execution: HarnessExecution, placement: Awaited<ReturnType<typeof mixedComputerPlacement>>) {
  const prepared = await owner.oneShotConnection().transaction(async sql => {
    const pin = await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)
    const intent = await readDispatchIntent(sql, execution.id)
    if (!pin || !intent || !('kind' in pin.source) || pin.source.kind !== 'pending') {
      throw new Error('Expected the admitted source and dispatch.')
    }
    const principal = await readLiveManagementPrincipal(sql, run.authorizationPrincipalId)
    await placement.producer.assertPinsCurrent(sql, pin, principal, run.workspaceId)
    const previous = await readNativePlacement(sql, execution.id)
    if (previous) return { pin, principal, native: previous }
    const root = await placement.sources.resolveRootBinding(sql, principal, { workspaceId: run.workspaceId,
      rootId: pin.source.rootId, bindingRevision: pin.source.bindingRevision, source: {
        approvedSourceId: pin.source.approvedSourceId, snapshotId: pin.source.snapshotId,
        manifestDigest: pin.source.manifestDigest,
      } })
    const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture())
    const reservation = await reservations.reserve(sql, { scopeId: randomUUID(), ownerKind: 'materialization',
      ownerId: intent.operationId, reservedBytes: 16 * 1024 })
    const receipt = { version: 1 as const, materializationId: randomUUID(), binding: root.binding,
      placementHash: sourceBindingHash(root, { executionId: execution.id, attemptId: intent.attemptId,
        keyRevision: pin.registration?.keyRevision ?? null,
        authorizationRevision: pin.registration?.authorizationRevision ?? null }, intent.operationId),
      executionId: execution.id, attemptId: intent.attemptId,
      keyRevision: pin.registration?.keyRevision ?? null,
      authorizationRevision: pin.registration?.authorizationRevision ?? null,
      verifiedManifestDigest: root.source.manifestDigest, verifiedEntries: 1, verifiedBytes: 29,
      verifiedAt: new Date().toISOString(), localTreeIdentity: root.binding.filesystem,
      claimScope: 'execution' as const,
      ...(root.binding.accessMode === 'exclusive-write'
        ? { sharedTree: { id: randomUUID(), referenceIdentity: root.binding.filesystem } } : {}) }
    const record = SourceMaterializationRecordSchema.parse({ receipt, operationId: intent.operationId,
      rootPolicyId: pin.destination.rootPolicyId, rootPolicyRevision: pin.destination.rootPolicyRevision,
      reservationId: reservation.reservationId, sourceBindingHash: receipt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' })
    const fields = { version: 1 as const, materializationId: receipt.materializationId,
      executionId: execution.id, attemptId: intent.attemptId, operationId: intent.operationId,
      sourceBindingHash: receipt.placementHash, relativeCwd: '', canonicalCwd: pin.destination.canonicalCwd,
      filesystem: root.binding.filesystem, directoryIdentityHash: pin.destination.directoryIdentityHash,
      accessMode: root.binding.accessMode }
    const native = bindNativeExecution(pin, intent, record, { materializationId: receipt.materializationId,
      materializationDigest: sourceMaterializationDigest(record),
      canonicalProjectRoot: pin.destination.canonicalProjectRoot, canonicalCwd: fields.canonicalCwd,
      directoryIdentityHash: fields.directoryIdentityHash, filesystem: fields.filesystem,
      accessMode: fields.accessMode, privateGit: null,
      cwdAttestation: { ...fields, attestationDigest: sourceCwdAttestationDigest(fields) } })
    await sql.query(`insert into source_execution_materializations
      (materialization_id,workspace_id,execution_id,attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'prepared')`, [receipt.materializationId, run.workspaceId,
      execution.id, intent.attemptId, intent.operationId, root.binding.rootId, root.binding.bindingRevision,
      reservation.reservationId, JSON.stringify({ ...record, finalDispatchBindingHash: native.bindingHash })])
    await reservations.retain(sql, reservation, 'owned')
    await insertNativePlacement(sql, owner, native)
    return { pin, principal, native }
  })
  return { workingDirectory: prepared.native.workingTree.canonicalCwd,
    runtimeDirectory: repeatRuntimeDirectory(prepared.pin.destination.managedRuntimeRoot, {
      workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId,
      runId: run.id, executionSemanticsVersion: 3,
    }, execution),
    revalidate: () => owner.oneShotConnection().transaction(sql => placement.producer.assertPinsCurrent(sql,
      prepared.pin, prepared.principal, run.workspaceId)) }
}
