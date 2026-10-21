import { closeSourceWorktree } from './worktreeCleanup.js'
import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'
import type { SourceWorktreeRequest, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { SourceQuotaPool } from './materialization.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord, SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { DomainError } from '../errors.js'
import { measureRetainedMaterializationFootprint } from './retainedDirectoryUsage.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim, reconcileSourcePreparation } from './materialization.js'
import { verifyMaterializedWorkingDirectory } from './workingDirectory.js'
import { createPrivateSourceRepository } from './repository.js'
import type { MaterializationAttempt, SourceAttemptAuthority, SourceByteReader, SourceExecutionHostPort, SourceNativeSessionCapture } from './ports.js'
export type { SourceAttemptAuthority, SourceNativeSessionCapture } from './ports.js'
import type { SourceActiveNativeSession } from '@foreman-code/contracts/source-operations'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import { readSourceStorageCapacity } from './storageCapacity.js'

export type SourceNativeSessionCaptureReader = (record: SourceMaterializationRecord) => Promise<SourceNativeSessionCapture | null>
export type SourceActiveNativeSessionReader = (sql: GraphSqlClient, record: SourceMaterializationRecord) => Promise<SourceActiveNativeSession | null>
/** Worker independently observes these original installed-host facts. Main owns
 * the entered SQL row and current session lane, so the worker never invents them. */
export interface SourceInstalledNativeOwner {
  executionId: string; runId: string; technicalAttempt: number; attemptId: string; operationId: string
  materializationId: string; sourceBindingHash: string; finalDispatchBindingHash: string
  session: SourceActiveNativeSession['nativeSession']; owner: SourceActiveNativeSession['owner']
  signal: AbortSignal; assertCurrent(): Promise<void> | void
}
export type SourceInstalledNativeOwnerReader = (record: SourceMaterializationRecord) => Promise<SourceInstalledNativeOwner | null>

export interface RemoteSourceMaterializationHost {
  storageCapacity?(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<SourceStorageCapacity>
  prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt,
    options?: { sharedWritableTree?: true; worktree?: SourceWorktreeRequest; retainedReceipt?: MaterializationReceipt }): Promise<SourceMaterializationRecord['receipt']>
  verifyWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string): Promise<VerifiedSourceWorkingTree>
  verify(record: SourceMaterializationRecord): Promise<string>
  releaseClaim(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string; retainWorkingTree?: true }): Promise<RetainedSourceFootprint>
  privateRepository(record: SourceMaterializationRecord, manifest: SourceManifest): Promise<{ workTree: string; gitDirectory: string; generatedCommit: string; sourceCommit: string | null }>
  reconcilePreparation?(reconciliationId: string, owner: SourceOperationOwner): Promise<SourcePreparationClosure>
}
/** Concrete original-main source copy. Remote carries exactly the same approved
 * operation through W07/B verified source bytes, never a second scheduler. */
export class InstalledSourceExecutionHosts implements SourceExecutionHostPort {
  constructor(private readonly mainId: string, private readonly bytes: SourceByteReader,
    private readonly authority: SourceAttemptAuthority, private readonly remote: RemoteSourceMaterializationHost,
    private readonly captureNativeSession?: SourceNativeSessionCaptureReader,
    private readonly localPreparation?: {
      authorize(reconciliationId: string, owner: SourceOperationOwner): Promise<void>
      closed(owner: SourceOperationOwner): Promise<boolean>
    }, private readonly quotaPoolFor?: (binding: RootBinding, attempt: MaterializationAttempt) => Promise<SourceQuotaPool | undefined>) {}
  async storageCapacity(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<SourceStorageCapacity> {
    await this.authority.revalidate(root, attempt)
    if (root.binding.deviceId !== null) {
      if (!this.remote.storageCapacity) {
        throw new DomainError('SOURCE_CAPACITY_UNAVAILABLE', 'The selected worker cannot measure source capacity.', 409)
      }
      return this.remote.storageCapacity(root, attempt)
    }
    return readSourceStorageCapacity(root.binding.canonicalPath, root.binding.filesystem)
  }
  async reconcilePreparation(reconciliationId: string, owner: SourceOperationOwner) {
    if (owner.root.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source cleanup belongs to another Main.', 403)
    if (owner.root.binding.deviceId !== null) {
      if (!this.remote.reconcilePreparation) throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'The original worker does not support preparation reconciliation.', 409)
      return this.remote.reconcilePreparation(reconciliationId, owner)
    }
    if (!this.localPreparation) {
      throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'Original Main cleanup authority is unavailable.', 409)
    }
    return reconcileSourcePreparation(reconciliationId, owner,
      () => this.localPreparation!.closed(owner),
      () => this.localPreparation!.authorize(reconciliationId, owner),
      await this.quotaPoolFor?.(owner.root.binding, owner.attempt))
  }
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }) {
    return this.authority.authorize(sql, principal, input)
  }
  authorizeFinal(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, hash: string) {
    return this.authority.authorizeFinal(sql, principal, record, hash)
  }
  async prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt,
    options?: { sharedWritableTree?: true; worktree?: SourceWorktreeRequest; retainedReceipt?: MaterializationReceipt }) {
    if (root.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source copy belongs to another main.', 403)
    if (root.binding.deviceId !== null) return this.remote.prepare(manifest, root, attempt, options)
    const materializer = new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidate(root, attempt),
      await this.quotaPoolFor?.(root.binding, attempt))
    return materializer.prepare({ manifest, binding: root.binding, attempt, ...options })
  }
  async verify(record: SourceMaterializationRecord): Promise<string> {
    if (record.receipt.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source copy belongs to another main.', 403)
    if (record.receipt.binding.deviceId !== null) return this.remote.verify(record)
    const expected = { binding: record.receipt.binding, attempt: { placementHash: record.receipt.placementHash, executionId: record.receipt.executionId,
      attemptId: record.receipt.attemptId, keyRevision: record.receipt.keyRevision, authorizationRevision: record.receipt.authorizationRevision } }
    return new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidateMaterialization(record),
      await this.quotaPoolFor?.(record.receipt.binding, expected.attempt)).resolve(record.receipt, expected)
  }
  async verifyWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string): Promise<VerifiedSourceWorkingTree> {
    if (record.receipt.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source copy belongs to another main.', 403)
    if (record.receipt.binding.deviceId !== null) return this.remote.verifyWorkingDirectory(record, relativeCwd)
    const capture = await this.captureNativeSession?.(record)
    return verifyMaterializedWorkingDirectory(record, relativeCwd, () => this.authority.revalidateMaterialization(record), capture ?? undefined)
  }
  /** Main service calls only after exact original physical closure proof. */
  async releaseClaim(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string; retainWorkingTree?: true }): Promise<RetainedSourceFootprint> {
    if (record.receipt.binding.deviceId !== null) return this.remote.releaseClaim(record, options)
    const receipt = record.receipt
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId,
      keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    await releaseMaterializationClaim(receipt, async () => 'released',
      await this.quotaPoolFor?.(receipt.binding, attempt), options?.signal)
    const worktree = options?.retainWorkingTree && receipt.worktree
      ? { state: 'retained' as const, message: 'The active Run retains this node working directory.' }
      : await closeSourceWorktree(receipt, options?.signal)
    return { ...await measureRetainedMaterializationFootprint(record.receipt), ...(worktree ? { worktree } : {}) }
  }
  /** CI-only explicit detached write copy; read-only references cannot acquire
   * write authority or Git working metadata through this helper. */
  async privateRepository(record: SourceMaterializationRecord, manifest: SourceManifest) {
    if (record.receipt.binding.deviceId !== null) return this.remote.privateRepository(record, manifest)
    if (record.receipt.binding.accessMode !== 'exclusive-write') throw new DomainError('SOURCE_READ_ONLY', 'Read-only source references cannot become writable execution copies.', 403)
    const receipt = record.receipt
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId,
      keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    const materializer = new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidateMaterialization(record),
      await this.quotaPoolFor?.(receipt.binding, attempt))
    return createPrivateSourceRepository({ receipt, manifest, materializer, attempt })
  }
}
