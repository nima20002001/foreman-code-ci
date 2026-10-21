import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'
import type { SourceWorktreeRequest, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { sourceMaterializationParent } from '@foreman-code/contracts/source-materialization'
import { sourceWorkingTreePath } from './sourceTreePaths.js'
import type { PostgresSourceRsyncLifecycle } from './rsyncTransferLifecycle.js'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { SOURCE_OPERATION_EXTENSION, SourceOperationRequestSchema, SourceOperationResponseSchema, SourceTransferStatusRequestSchema, SourceTransferStatusResponseSchema,
  type SourceFilesystemOperation, type SourceOperationOwner, type SourceGitHubReferenceSchema } from '@foreman-code/contracts/source-operations'
import type { z } from 'zod'
import type { SourceRootRecord, SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { MainWorkerCarrier } from '../placement/workerCarrier.js'
import { DeviceApplicationError, type DeviceExtensionRegistration, type DeviceExtensionContext } from '../devices/deviceApplicationChannel.js'
import { DomainError } from '../errors.js'
import type { RemoteSourceMaterializationHost } from './executionHosts.js'
import type { MaterializationAttempt } from './ports.js'
import type { PostgresSourcePackageTransfers } from './operationTransferAdmission.js'
import { transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { verifiedSourceWorkingTree } from './nativeStamp.js'
import { SOURCE_LIMITS } from './manifest.js'
import { assertWorktreeReceipt } from './worktreeRequest.js'
import { sourceCwdAttestationDigest } from './workingDirectory.js'
import type { PostgresSourceOperationAuthority } from './operationAuthority.js'
import { SourceReservationReclamationRequestSchema, SourceReservationReclamationAuthorityResponseSchema } from '@foreman-code/contracts/source-operations'
import type { MaterializationReservationCleanup } from './materializationReservationCleanup.js'

const GITHUB_PUBLISH_TIMEOUT_MS = 10 * 60_000

export interface SourceGitHubPublication {
  /** GitHub serves the approved commit before the computer fetches it; Main sends no source bytes. */
  publish(manifest: SourceManifest, signal: AbortSignal): Promise<z.infer<typeof SourceGitHubReferenceSchema>>
}
export class CarrierRemoteSourceMaterializationHost implements RemoteSourceMaterializationHost {
  constructor(private readonly carrier: MainWorkerCarrier, private readonly owners: Pick<PostgresSourceOperationAuthority, 'prepareIdentity' | 'resolve'>,
    private readonly github: SourceGitHubPublication) {}
  async storageCapacity(root: SourceRootRecord, attempt: MaterializationAttempt) {
    const identity = await this.owners.prepareIdentity(root, attempt)
    const response = await this.call(root, { version: 1, operation: 'sources.capacity', root, attempt, identity })
    if (response.operation !== 'sources.capacity'
      || !isDeepStrictEqual(response.capacity.filesystem, root.binding.filesystem)) {
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Source capacity belongs to another filesystem.', 409)
    }
    return response.capacity
  }
  async reconcilePreparation(reconciliationId: string, owner: SourceOperationOwner) {
    const response = await this.call(owner.root, { version: 1, operation: 'sources.reconcile-preparation', reconciliationId })
    if (response.operation !== 'sources.reconcile-preparation') throw new DomainError('SOURCE_RESPONSE_INVALID', 'Expected original preparation closure proof.', 409)
    return response.closure
  }
  private connection(root: SourceRootRecord) {
    if (root.selection.hostRef.kind !== 'device' || !root.registration) throw new DomainError('SOURCE_DEVICE_REQUIRED', 'Source operation requires its actual accepted worker registration.', 409)
    const channel = this.carrier.capture(root.selection.hostRef.deviceId), identity = DeviceConnectionIdentitySchema.parse(channel.identity)
    if (identity.mainId !== root.binding.mainId || identity.deviceId !== root.binding.deviceId || identity.workerInstallationId !== root.registration.workerInstallationId
      || identity.keyRevision !== root.registration.keyRevision || identity.authorizationRevision !== root.registration.authorizationRevision)
      throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source operation must use the exact authenticated accepted device.', 409)
    return channel
  }
  private async call(root: SourceRootRecord, request: SourceFilesystemOperation, signal?: AbortSignal) {
    const connection = this.connection(root)
    // RootWorkerClient uses the same captured W07 request closure; this namespace
    // changes only the domain schema, never transport/connection authority.
    // The Worker bounds each operation by its own preparation budget. Cancelling sooner aborts an activation
    // midway and leaves its claim uncertain, so Main waits out that budget plus time for the Worker's reply.
    const timeoutMs = SOURCE_LIMITS.preparationMs + 30_000
    const response = await connection.request(SOURCE_OPERATION_EXTENSION.namespace, request, signal ? { signal, timeoutMs } : { timeoutMs }).catch((error: unknown) => {
      if (error instanceof DeviceApplicationError && ['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY'].includes(error.code)) {
        throw new DomainError(error.code, 'The selected computer is waiting for source storage capacity.', 409, undefined, { cause: error })
      }
      if (request.operation === 'sources.reconcile-preparation' && error instanceof DeviceApplicationError)
        throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The worker did not positively confirm preparation closure. Retry the original reconciliation command.', 409, undefined, { cause: error })
      if (request.operation === 'sources.private-repository' && error instanceof DeviceApplicationError) {
        if (error.code === 'timeout' || error.code === 'source-repository-timeout')
          throw new DomainError('SOURCE_REPOSITORY_TIMEOUT', 'Private source preparation timed out. Retry the original command to read its retained state; incomplete ownership requires reconciliation.', 503, { retryable: true }, { cause: error })
        if (error.code === 'source-repository-uncertain')
          throw new DomainError('SOURCE_REPOSITORY_UNCERTAIN', 'The original private repository is incomplete; reconcile this exact attempt before retry.', 409, undefined, { cause: error })
      }
      throw error
    })
    if (response.bytes !== undefined) throw new DomainError('SOURCE_RESPONSE_INVALID', 'Source control replies contain no inline binary bytes.', 409)
    const value = SourceOperationResponseSchema.parse(response.payload)
    if (value.operation !== request.operation) throw new DomainError('SOURCE_RESPONSE_INVALID', 'Source response belongs to another operation.', 409)
    return value
  }
  async prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt,
    options?: { worktree?: SourceWorktreeRequest; retainedReceipt?: MaterializationReceipt }) {
    const identity = await this.owners.prepareIdentity(root, attempt)
    this.connection(root) // Validate actual host before any source transfer.
    // Publishing one commit is bounded well inside the attempt; long attempt leases exceed timer limits.
    const github = await this.github.publish(manifest, AbortSignal.timeout(
      Math.min(GITHUB_PUBLISH_TIMEOUT_MS, Math.max(1, Date.parse(identity.expiresAt) - Date.now()))))
    const response = await this.call(root, { version: 1, operation: 'sources.prepare', root, attempt, identity, github,
      ...(options?.worktree ? { worktree: options.worktree } : {}),
      ...(options?.retainedReceipt ? { retainedReceipt: options.retainedReceipt } : {}) })
    if (response.operation !== 'sources.prepare' || !isDeepStrictEqual(response.receipt.binding, root.binding) || response.receipt.executionId !== attempt.executionId
      || response.receipt.attemptId !== attempt.attemptId || response.receipt.placementHash !== attempt.placementHash || response.receipt.verifiedManifestDigest !== manifest.manifestDigest
      || response.receipt.verifiedEntries !== manifest.totalEntries || response.receipt.verifiedBytes !== manifest.totalBytes)
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Source materialization does not verify the original accepted complete snapshot.', 409)
    assertWorktreeReceipt(response.receipt, options?.worktree, manifest.git?.commit)
    return response.receipt
  }
  private async rootFor(record: SourceMaterializationRecord, operation: 'sources.verify' | 'sources.private-repository' | 'sources.release') {
    const r = record.receipt, connection = this.carrier.capture(r.binding.deviceId!)
    const request: SourceFilesystemOperation = operation === 'sources.verify' ? { version: 1, operation, record, relativeCwd: '' } : { version: 1, operation, record }
    const owner = await this.owners.resolve(request, connection.identity)
    return owner.root
  }
  async verify(record: SourceMaterializationRecord): Promise<string> {
    const root = await this.rootFor(record, 'sources.verify'), response = await this.call(root, { version: 1, operation: 'sources.verify', record, relativeCwd: '' })
    if (response.operation !== 'sources.verify' || response.workTree !== sourceWorkingTreePath(record.receipt))
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Source reply is not the actual original private tree.', 409)
    return response.workTree
  }
  async verifyWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string): Promise<VerifiedSourceWorkingTree> {
    const root = await this.rootFor(record, 'sources.verify')
    const response = await this.call(root, { version: 1, operation: 'sources.verify', record, relativeCwd })
    if (response.operation !== 'sources.verify') throw new DomainError('SOURCE_RESPONSE_INVALID', 'Expected working directory verification.', 409)
    const proof = response.cwdAttestation
    if (response.workTree !== sourceWorkingTreePath(record.receipt)
      || response.canonicalCwd !== join(response.workTree, relativeCwd) || proof.relativeCwd !== relativeCwd
      || proof.materializationId !== record.receipt.materializationId || proof.executionId !== record.receipt.executionId
      || proof.attemptId !== record.receipt.attemptId || proof.operationId !== record.operationId || proof.sourceBindingHash !== record.receipt.placementHash
      || proof.attestationDigest !== sourceCwdAttestationDigest(proof) || proof.canonicalCwd !== response.canonicalCwd
      || proof.directoryIdentityHash !== response.directoryIdentityHash || !isDeepStrictEqual(proof.filesystem, response.filesystem)
      || proof.accessMode !== record.receipt.binding.accessMode || response.accessMode !== proof.accessMode)
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Working directory proof differs from the exact original materialization.', 409)
    return { ...verifiedSourceWorkingTree(record, response.workTree), canonicalCwd: response.canonicalCwd,
      directoryIdentityHash: response.directoryIdentityHash, cwdAttestation: proof }
  }
  async privateRepository(record: SourceMaterializationRecord, _manifest: SourceManifest) {
    const root = await this.rootFor(record, 'sources.private-repository'), response = await this.call(root, { version: 1, operation: 'sources.private-repository', record })
    if (response.operation !== 'sources.private-repository' || response.repository.workTree !== sourceWorkingTreePath(record.receipt)
      || response.repository.gitDirectory !== join(sourceMaterializationParent(record.receipt), 'repository'))
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Repository reply is not the actual detached original private Git store.', 409)
    if (_manifest.snapshotId !== record.receipt.binding.snapshotId || _manifest.manifestDigest !== record.receipt.verifiedManifestDigest)
      throw new DomainError('SOURCE_PIN_CONFLICT', 'Repository belongs to another exact source snapshot.', 409)
    return response.repository
  }
  async releaseClaim(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string }): Promise<RetainedSourceFootprint> {
    const root = await this.rootFor(record, 'sources.release'), response = await this.call(root, { version: 1, operation: 'sources.release', record }, options?.signal)
    if (response.operation !== 'sources.release' || response.materializationId !== record.receipt.materializationId
      || response.operationId !== record.operationId || response.sharedTree?.id !== record.receipt.sharedTree?.id)
      throw new DomainError('SOURCE_RESPONSE_INVALID', 'Closure acknowledgment belongs to another original materialization.', 409)
    return { retainedBytes: response.retainedBytes,
      ...(response.worktree ? { worktree: response.worktree } : {}),
      ...(response.sharedTree ? { sharedTree: response.sharedTree } : {}) }
  }
}
/** Main accepts only owner lookup from the authenticated worker. */
export function createMainSourceOperationExtension(owners: Pick<PostgresSourceOperationAuthority, 'resolve'>, transfers: Pick<PostgresSourcePackageTransfers, 'intent'>,
  lifecycle?: Pick<PostgresSourceRsyncLifecycle, 'status'>,
  reclamations?: (reservationId: string, reclamationId: string, context: DeviceExtensionContext) => ReturnType<MaterializationReservationCleanup['authorize']>): DeviceExtensionRegistration {
  return { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(raw, context) {
    if (raw && typeof raw === 'object' && 'operation' in raw && raw.operation === 'sources.reclamation-authorize') {
      const request = SourceReservationReclamationRequestSchema.parse(raw)
      if (context.bytes?.byteLength || !reclamations) {
        throw new DomainError('SOURCE_ROLE_DENIED', 'Source reservation cleanup authority is unavailable.', 403)
      }
      context.signal.throwIfAborted()
      const grant = await reclamations(request.reservationId, request.reclamationId, context)
      context.signal.throwIfAborted()
      return { payload: SourceReservationReclamationAuthorityResponseSchema.parse({ version: 1,
        operation: 'sources.reclamation-authorize', grant }) }
    }
    const request = raw && typeof raw === 'object' && 'operation' in raw && raw.operation === 'sources.transfer-status'
      ? SourceTransferStatusRequestSchema.parse(raw) : SourceOperationRequestSchema.parse(raw)
    if ((context.bytes?.byteLength ?? 0) !== 0) throw new DomainError('SOURCE_ROLE_DENIED', 'Workers cannot invoke Main filesystem source operations.', 403)
    context.signal.throwIfAborted()
    if (request.operation === 'sources.transfer-status') {
      if (!lifecycle) throw new DomainError('SOURCE_TRANSFER_STATUS_UNAVAILABLE', 'Original committed source status is unavailable.', 409)
      const result = await lifecycle.status(request.transferId, context.binding)
      context.signal.throwIfAborted()
      return { payload: SourceTransferStatusResponseSchema.parse({ version: 1, operation: request.operation, ...result }) }
    }
    if (request.operation === 'sources.transfer-authorize') {
      const intent = await transfers.intent(request.transferId, context.binding)
      context.signal.throwIfAborted(); return { payload: SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, intent }) }
    }
    if (request.operation !== 'sources.authorize') throw new DomainError('SOURCE_ROLE_DENIED', 'Workers may only resolve actual source owner/transfer authority on Main.', 403)
    const owner = await owners.resolve(request.request, context.binding)
    context.signal.throwIfAborted(); return { payload: SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, owner }) }
  } }
}
export function sourceOwnerOnMain(request: (namespace: string, payload: unknown, options: { signal: AbortSignal }) => Promise<{ payload: unknown; bytes?: Uint8Array }>) {
  return async (operation: SourceFilesystemOperation, context: DeviceExtensionContext): Promise<SourceOperationOwner> => {
    const response = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.authorize', request: operation }, { signal: context.signal })
    const value = SourceOperationResponseSchema.parse(response.payload)
    if (value.operation !== 'sources.authorize' || response.bytes !== undefined) throw new DomainError('SOURCE_OWNER_CONFLICT', 'The authenticated Main did not return its actual source owner.', 403)
    return value.owner
  }
}

/** Worker byte receiver obtains actual Main-admitted source intent, and repeats
 * lookup on every read/chunk. No peer-supplied intent creates receiver authority. */
export function sourceTransfersOnMain(request: (namespace: string, payload: unknown, options?: { signal?: AbortSignal }) => Promise<{ payload: unknown; bytes?: Uint8Array }>,
  currentBinding: () => Readonly<DeviceSessionBinding>): AcceptedTransferAuthority {
  const intent = async (id: string, binding: Readonly<DeviceSessionBinding>) => {
    if (!isDeepStrictEqual(binding, currentBinding())) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source transfer context is not the actual current worker channel.', 409)
    const result = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.transfer-authorize', transferId: id })
    const response = SourceOperationResponseSchema.parse(result.payload)
    if (response.operation !== 'sources.transfer-authorize' || result.bytes !== undefined || response.intent.transferId !== id || response.intent.byteClass !== 'source'
      || response.intent.direction !== 'to-worker') throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Main did not authorize this actual source transfer.', 403)
    const c = transferContextForBinding(binding)
    for (const key of ['mainId','deviceId','workerInstallationId','keyRevision','authorizationRevision'] as const)
      if (response.intent[key] !== c[key]) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source transfer belongs to another actual device authority.', 409)
    return response.intent
  }
  return { intent, async authorize(accepted, context) {
    const binding = currentBinding()
    if (!isDeepStrictEqual(transferContextForBinding(binding), context) || !isDeepStrictEqual(await intent(accepted.transferId, binding), accepted))
      throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Source receiver authority changed under the actual original transfer.', 403)
  } }
}
