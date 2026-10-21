import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import { join } from 'node:path'
import type pg from 'pg'
import { TransferIntentSchema, TransferContextSchema, type TransferIntent, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { ApprovedSourceSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema,
  type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceOperationAttemptSchema, SourcePreparationIdentitySchema } from '@foreman-code/contracts/source-operations'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import type { TransferOperation } from '../byte-transfer/service.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { sourceBindingHash } from './bindingHash.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { verifyApprovedRootAllowlist } from './rootAttestation.js'

export interface SourceCommittedTransfer { intent: TransferIntent; record: SourceMaterializationRecord }
function conflict(message: string): never { throw new DomainError('SOURCE_TRANSFER_CONFLICT', message, 409) }
async function allocation(sql: GraphSqlClient, id: string) {
  TransferIntentSchema.shape.transferId.parse(id)
  const rows = (await sql.query<{ result: unknown }>(`select result from management_command_receipts
    where operation='source.package.admit' and result->'intent'->>'transferId'=$1`, [id])).rows
  if (rows.length !== 1) conflict('The original source package admission is missing or ambiguous.')
  const raw = rows[0]!.result as Record<string, unknown>
  const intent = TransferIntentSchema.parse(raw.intent), root = SourceRootRecordSchema.parse(raw.root)
  const attempt = SourceOperationAttemptSchema.parse(raw.attempt), identity = SourcePreparationIdentitySchema.parse(raw.identity)
  if (intent.transferId !== id || intent.direction !== 'to-worker' || intent.byteClass !== 'source'
    || intent.operationId !== identity.operationId || intent.executionId !== attempt.executionId || intent.attemptId !== attempt.attemptId
    || intent.placementHash !== attempt.placementHash || sourceBindingHash(root, attempt, identity.operationId) !== attempt.placementHash
    || intent.rootId !== root.binding.rootId || intent.rootBindingRevision !== root.binding.bindingRevision
    || intent.manifestDigest !== root.source.manifestDigest || intent.mainId !== root.binding.mainId
    || intent.deviceId !== root.binding.deviceId || intent.workerInstallationId !== root.binding.workerInstallationId
    || intent.keyRevision !== root.registration?.keyRevision || intent.authorizationRevision !== root.registration?.authorizationRevision
    || attempt.keyRevision !== intent.keyRevision || attempt.authorizationRevision !== intent.authorizationRevision
    || Date.parse(intent.expiresAt) > Date.parse(identity.expiresAt)) conflict('The original source package admission pins conflict.')
  return { intent, root, attempt, identity }
}
function assertRecord(intent: TransferIntent, record: SourceMaterializationRecord) {
  const receipt = record.receipt
  if (record.state === 'uncertain' || record.operationId !== intent.operationId || record.sourceBindingHash !== intent.placementHash
    || receipt.executionId !== intent.executionId || receipt.attemptId !== intent.attemptId || receipt.placementHash !== intent.placementHash
    || receipt.keyRevision !== intent.keyRevision || receipt.authorizationRevision !== intent.authorizationRevision
    || receipt.binding.mainId !== intent.mainId || receipt.binding.deviceId !== intent.deviceId
    || receipt.binding.workerInstallationId !== intent.workerInstallationId || receipt.binding.rootId !== intent.rootId
    || receipt.binding.bindingRevision !== intent.rootBindingRevision || receipt.verifiedManifestDigest !== intent.manifestDigest
    || receipt.binding.manifestDigest !== intent.manifestDigest) conflict('The committed materialization differs from its original source transfer.')
}

/** Main-only SQL read facades. Existing accepted source authority remains the data grant.
 * No second allocation, actor, capture, expiry, ACK ledger or writer-stopped flag. */
export class PostgresSourceRsyncLifecycle implements AcceptedTransferAuthority {
  constructor(private readonly pool: pg.Pool, private readonly accepted: AcceptedTransferAuthority) {}
  async intent(id: string, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent> {
    const original = (await allocation(this.pool, id)).intent
    const accepted = TransferIntentSchema.parse(await this.accepted.intent(id, binding))
    if (!isDeepStrictEqual(original, accepted)) conflict('Live source authority returned another admitted intent.')
    await this.authorize(original, transferContextForBinding(binding), 'read'); return original
  }
  async authorize(raw: TransferIntent, context: TransferContext, operation: TransferOperation) {
    const intent = TransferIntentSchema.parse(raw), original = (await allocation(this.pool, intent.transferId)).intent
    if (!isDeepStrictEqual(original, intent)) conflict('Source transfer immutable identity changed.')
    if (Date.now() >= Date.parse(intent.expiresAt)) conflict('The original source transfer has expired.')
    await this.accepted.authorize(intent, TransferContextSchema.parse(context), operation)
  }
  async committed(raw: TransferIntent, rawContext: TransferContext): Promise<SourceMaterializationRecord> {
    const intent = TransferIntentSchema.parse(raw), context = TransferContextSchema.parse(rawContext)
    await this.authorize(intent, context, 'read')
    const record = await withTransaction(this.pool, async (sql) => {
      const original = await allocation(sql, intent.transferId)
      if (!isDeepStrictEqual(original.intent, intent)) conflict('Source package admission changed during readback.')
      const rows = (await sql.query<{ record: unknown; state: string; reservation_id: string; materialization_id: string }>(`select record,state,reservation_id,materialization_id
        from source_execution_materializations where operation_id=$1 and execution_id=$2 and attempt_id=$3
        and workspace_id=$4 and root_id=$5 and binding_revision=$6 for share`, [intent.operationId, intent.executionId,
        intent.attemptId, original.root.binding.workspaceId, intent.rootId, intent.rootBindingRevision])).rows
      if (rows.length !== 1) conflict('The exact source materialization has not committed.')
      const row = rows[0]!, stored = SourceMaterializationRecordSchema.parse(row.record)
      if (stored.state === 'uncertain') conflict('The original source materialization is uncertain.')
      const record = SourceMaterializationRecordSchema.parse({ ...stored, state: row.state })
      assertRecord(intent, record)
      if (!isDeepStrictEqual(record.receipt.binding, original.root.binding)
        || record.rootPolicyId !== original.root.selection.rootPolicyId || record.rootPolicyRevision !== original.root.selection.rootPolicyRevision
        || record.reservationId !== row.reservation_id || record.receipt.materializationId !== row.materialization_id)
        conflict('The committed source root/materialization/reservation pins differ.')
      const roots = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
        [intent.rootId, intent.rootBindingRevision])).rows
      if (roots.length !== 1 || !isDeepStrictEqual(SourceRootRecordSchema.parse(roots[0]!.record), original.root)) conflict('The original source root is unavailable or changed.')
      const snapshots = (await sql.query<{ record: unknown; availability: string }>(`select record,availability from source_snapshots
        where workspace_id=$1 and approved_source_id=$2 and snapshot_id=$3 and manifest_digest=$4 for share`,
      [original.root.binding.workspaceId, original.root.source.approvedSourceId, original.root.source.snapshotId, intent.manifestDigest])).rows
      if (snapshots.length !== 1 || snapshots[0]!.availability !== 'retained') conflict('The approved immutable source is unavailable.')
      const source = ApprovedSourceSchema.parse(snapshots[0]!.record), manifest = source.manifest
      if (source.availability !== 'retained' || source.workspaceId !== original.root.binding.workspaceId || source.mainId !== intent.mainId
        || manifest.approvedSourceId !== original.root.source.approvedSourceId || manifest.snapshotId !== original.root.source.snapshotId
        || manifest.manifestDigest !== intent.manifestDigest || manifest.totalEntries !== record.receipt.verifiedEntries
        || manifest.totalBytes !== record.receipt.verifiedBytes) conflict('The committed source receipt did not verify the approved manifest.')
      const reservations = (await sql.query<{ state: string; owner_kind: string; owner_id: string; reserved_bytes: string }>(`select state,owner_kind,owner_id,reserved_bytes
        from source_storage_reservations where reservation_id=$1 for share`, [record.reservationId])).rows
      if (reservations.length !== 1 || reservations[0]!.state !== 'owned' || reservations[0]!.owner_kind !== 'materialization'
        || reservations[0]!.owner_id !== intent.operationId || !Number.isSafeInteger(Number(reservations[0]!.reserved_bytes))
        || Number(reservations[0]!.reserved_bytes) < manifest.totalBytes) conflict('The actual source materialization reservation is not owned or accounted.')
      return record
    })
    // No transaction spans the live-authority recheck, local filesystem checks or rsync ACK.
    await this.authorize(intent, context, 'read'); return record
  }
  async acknowledged(intent: TransferIntent, context: TransferContext): Promise<void> { await this.committed(intent, context) }
  async status(id: string, binding: Readonly<DeviceSessionBinding>): Promise<SourceCommittedTransfer> {
    const intent = await this.intent(id, binding)
    return { intent, record: await this.committed(intent, transferContextForBinding(binding)) }
  }
  /** After-commit prepareExecution/retry bridge: resolve persisted IDs, never a transient sender map. */
  async forMaterialization(raw: SourceMaterializationRecord, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent> {
    const record = SourceMaterializationRecordSchema.parse(raw)
    const rows = (await this.pool.query<{ result: unknown }>(`select result from management_command_receipts
      where operation='source.package.admit' and result->'intent'->>'operationId'=$1`, [record.operationId])).rows
    if (rows.length !== 1) conflict('The original source materialization transfer is missing or ambiguous.')
    const id = TransferIntentSchema.parse((rows[0]!.result as Record<string, unknown>).intent).transferId
    const value = await this.status(id, binding)
    if (!isDeepStrictEqual(value.record, record)) conflict('The supplied materialization is not the committed original record.')
    return value.intent
  }
  /** Trusted existing cleanup supervisor only. Identity readback conveys NO authority or stopped proof. */
  async expiredIntent(id: string): Promise<TransferIntent> {
    const intent = (await allocation(this.pool, id)).intent
    if (Date.now() < Date.parse(intent.expiresAt)) conflict('Cleanup requires the original transfer expiry.')
    return intent
  }
}

export interface WorkerSourceRsyncAcknowledgementInput {
  authenticate(intent: TransferIntent, context: TransferContext, signal: AbortSignal): Promise<void>
  /** ID-only current Main readback over the existing authenticated source channel; no caller ACK flags. */
  currentCommitted(id: string, context: TransferContext, signal: AbortSignal): Promise<SourceCommittedTransfer>
  approvedRoots(): Promise<ApprovedRootAllowlist>
}
/** Worker-safe: original Main commit plus actual existing ready receipt and tree verification.
 * A materialization ACK does not prove any rsync writer or native process stopped. */
export function createWorkerSourceRsyncAcknowledgement(input: WorkerSourceRsyncAcknowledgementInput) {
  return { acknowledged: async (raw: TransferIntent, rawContext: TransferContext, signal = AbortSignal.timeout(30000)) => {
    const intent = TransferIntentSchema.parse(raw), context = TransferContextSchema.parse(rawContext)
    const authenticate = async () => { signal.throwIfAborted(); await input.authenticate(intent, context, signal); signal.throwIfAborted() }
    const read = async () => {
      await authenticate()
      const value = await input.currentCommitted(intent.transferId, context, signal)
      if (!isDeepStrictEqual(TransferIntentSchema.parse(value.intent), intent)) conflict('Main committed another source transfer.')
      const record = SourceMaterializationRecordSchema.parse(value.record); assertRecord(intent, record)
      await authenticate(); return record
    }
    if (intent.byteClass !== 'source' || intent.direction !== 'to-worker' || Date.now() >= Date.parse(intent.expiresAt)) conflict('This is not a current admitted worker source package.')
    for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)
      if (intent[key] !== context[key]) conflict('Worker source acknowledgement belongs to another current device authority.')
    const record = await read(), roots = ApprovedRootAllowlistSchema.parse(await input.approvedRoots())
    if (roots.hostRef.kind !== 'device' || roots.hostRef.mainId !== intent.mainId || roots.hostRef.deviceId !== intent.deviceId
      || roots.applicationInstallationId !== intent.workerInstallationId
      || record.receipt.binding.canonicalPath !== join(roots.managedRuntimeRoot, 'source-materializations', TransferIntentSchema.shape.rootId.parse(record.rootPolicyId)))
      conflict('Source acknowledgement root is outside the installed approved runtime.')
    await verifyApprovedRootAllowlist(roots)
    const receipt = record.receipt, attempt = { executionId: receipt.executionId, attemptId: receipt.attemptId, placementHash: receipt.placementHash,
      keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    const recovered = await new PrivateSourceMaterializer(null, authenticate).recover(receipt.binding, attempt)
    if (!recovered || !isDeepStrictEqual(recovered, receipt)) conflict('The actual local ready source receipt is missing or differs.')
    if (!isDeepStrictEqual(await read(), record)) conflict('The Main source materialization changed during local acknowledgement.')
  } }
}
