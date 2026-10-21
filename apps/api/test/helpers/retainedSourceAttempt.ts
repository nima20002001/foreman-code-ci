import { randomUUID } from 'node:crypto'
import type { HarnessExecution } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { readDispatchIntent, readExecutionPlacement } from '../../src/modules/placement/persistence.js'
import { sourceBindingHash } from '../../src/modules/sources/bindingHash.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../../src/modules/sources/materialization.js'
import { measureRetainedMaterializationFootprint } from '../../src/modules/sources/retainedDirectoryUsage.js'
import { sourceWorkingTreePath } from '../../src/modules/sources/sourceTreePaths.js'
import type { sourceWorktreeMcpFixture } from './sourceWorktreeMcpFixture.js'

/** Historical preparation metadata and files, created before the execution's dispatched native attempt. */
export async function seedRetainedSourceAttempt(f: Awaited<ReturnType<typeof sourceWorktreeMcpFixture>>,
  execution: HarnessExecution): Promise<string> {
  const placement = await readExecutionPlacement(f.base.db.pool, execution.id)
  const intent = await readDispatchIntent(f.base.db.pool, execution.id)
  if (!placement || !intent || placement.payload.kind !== 'agent'
    || !('kind' in placement.source) || placement.source.kind !== 'pending') {
    throw new Error('Expected a pending Agent source')
  }
  const root = SourceRootRecordSchema.parse((await f.base.db.pool.query<{ record: unknown }>(
    'select record from source_root_bindings where root_id=$1 and binding_revision=$2',
    [placement.source.rootId, placement.source.bindingRevision])).rows[0]!.record)
  const manifest = await f.production.snapshots.manifest(root.binding.snapshotId)
  const operationId = randomUUID()
  const attempt = { executionId: execution.id, attemptId: `0-discarded-${randomUUID()}`,
    keyRevision: null, authorizationRevision: null, placementHash: '' }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  // This fixture seeds a discarded preparation, with no dispatch or native-entry authority.
  const materializer = new PrivateSourceMaterializer(f.production.snapshots, async () => {
    await f.production.sources.resolveRootBinding(f.base.db.pool, f.base.writer.principal, {
      workspaceId: root.binding.workspaceId, rootId: root.binding.rootId,
      bindingRevision: root.binding.bindingRevision, source: root.source,
    })
  })
  const receipt = await materializer.prepare({ manifest, binding: root.binding, attempt,
    sharedWritableTree: true, ...(placement.payload.worktree ? { worktree: placement.payload.worktree } : {}) })
  // This preparation never entered a native process; discard its claim while retaining its checkout.
  await releaseMaterializationClaim(receipt, async () => 'released')
  const footprint = await measureRetainedMaterializationFootprint(receipt)
  const capacity = await f.production.executions.storageCapacity(root, {
    ...attempt, attemptId: intent.attemptId,
    placementHash: sourceBindingHash(root, { ...attempt, attemptId: intent.attemptId }, intent.operationId),
  })
  await withTransaction(f.base.db.pool, async sql => {
    const { mainId, filesystem } = root.binding
    const reservation = await f.production.sources.reservations.reserve(sql, {
      scopeId: `${mainId}:original-main:${mainId}:${filesystem.device}:${filesystem.mountId}`,
      ownerKind: 'materialization', ownerId: operationId, reservedBytes: footprint.retainedBytes,
    }, { capacity })
    const record = SourceMaterializationRecordSchema.parse({ receipt, operationId,
      rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: root.selection.rootPolicyRevision,
      reservationId: reservation.reservationId, sourceBindingHash: attempt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' })
    await sql.query(`insert into source_execution_materializations(materialization_id,workspace_id,execution_id,
      attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'closed')`,
    [receipt.materializationId, root.binding.workspaceId, execution.id, attempt.attemptId, operationId,
      root.binding.rootId, root.binding.bindingRevision, reservation.reservationId, JSON.stringify(record)])
    await f.production.sources.reservations.retainMaterialization(sql, reservation, footprint)
  })
  return sourceWorkingTreePath(receipt)
}
