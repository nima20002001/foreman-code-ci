import { closeSourceWorktree } from './worktreeCleanup.js'
import type { SourceQuotaPool } from './materialization.js'
/** Worker-safe actual source filesystem operations: Node/shared contracts only. */
import { constants } from 'node:fs'
import { measureRetainedMaterializationFootprint } from './retainedDirectoryUsage.js'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertWorktreeReceipt } from './worktreeRequest.js'
import { z } from 'zod'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, SourceFilesystemOperationSchema, SourceOperationOwnerSchema, SourceOperationResponseSchema,
  SOURCE_OPERATION_EXTENSION, type SourceFilesystemOperation, type SourceOperationOwner, type SourceOperationResponse } from '@foreman-code/contracts/source-operations'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { SourceManifest, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import type { SourcePreparationClosure, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceError, verifySourceManifest } from './manifest.js'
import { anchored, openPrivateRoot } from './privateFilesystem.js'
import { verifyApprovedRootAllowlist } from './rootAttestation.js'
import { PrivateSourceMaterializer, materializationDirectory, releaseMaterializationClaim, reconcileSourcePreparation } from './materialization.js'
import { createPrivateSourceRepository } from './repository.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { assertSourceNativeSession, sourceNativeSessionContinues, verifyMaterializedWorkingDirectory } from './workingDirectory.js'
import type { SourceNativeSessionCapture, SourceInstalledNativeOwnerReader } from './executionHosts.js'
import { openGitHubSource } from './githubSource.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { SourceReservationReclamationRequestSchema, SourceReservationReclamationSchema,
  SourceReservationReclamationResponseSchema, type SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { reclaimSourceReservation } from './reclaimSourceReservation.js'
import { readSourceStorageCapacity } from './storageCapacity.js'

export interface SourceOperationWorkerContext { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal; bytes?: Uint8Array }
export interface SourceOperationWorkerOptions {
  mainNow(): number
  currentReclamation?(reservationId: string, reclamationId: string,
    context: SourceOperationWorkerContext): Promise<SourceReservationReclamation>
  reclamationNativeClosed?(owner: SourceOperationOwner | null, operationId: string): Promise<boolean>
  /** Existing actual paired-main/current boot/key/auth root authentication. */
  authenticate(context: SourceOperationWorkerContext): Promise<void>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  quotaPoolFor?(binding: MaterializationReceipt['binding']): Promise<SourceQuotaPool | undefined>
  /** Real sources.authorize on the sole authenticated W07 Main channel. */
  currentOwner(request: SourceFilesystemOperation, context: SourceOperationWorkerContext): Promise<SourceOperationOwner>
  /** This computer's GitHub clone; it fetches approved commits with its own login. */
  git?: GitWorktreePorts
  /** Actual original installed native manager/session; no caller-supplied flag. */
  nativeOwnerFor?: SourceInstalledNativeOwnerReader
  /** Original protected installed Job journal. Missing evidence fails closed. */
  preparationNativeClosed?(operationId: string, owner: SourceOperationOwner): Promise<boolean>
  preparationTransfersClosed?(closure: SourcePreparationClosure, signal: AbortSignal): Promise<void>
  preparationReconciled?(closure: SourcePreparationClosure): Promise<void>
  executionTransfersClosed?(record: SourceMaterializationRecord, signal: AbortSignal): Promise<void>
}
function attemptOf(record: NonNullable<SourceOperationOwner['record']>) {
  const r = record.receipt
  return { placementHash: r.placementHash, executionId: r.executionId, attemptId: r.attemptId, keyRevision: r.keyRevision, authorizationRevision: r.authorizationRevision }
}
function checkOwner(request: SourceFilesystemOperation, raw: SourceOperationOwner, context: SourceOperationWorkerContext): SourceOperationOwner {
  const owner = SourceOperationOwnerSchema.parse(raw), root = owner.root, binding = context.binding
  if (Date.parse(owner.identity.expiresAt) <= Date.now() || root.selection.hostRef.kind !== 'device' || root.binding.deviceId !== binding.deviceId
    || root.binding.mainId !== binding.mainId || root.binding.workerInstallationId !== binding.workerInstallationId || !root.registration
    || root.registration.workerInstallationId !== binding.workerInstallationId || root.registration.keyRevision !== binding.keyRevision
    || root.registration.authorizationRevision !== binding.authorizationRevision || owner.attempt.keyRevision !== binding.keyRevision
    || owner.attempt.authorizationRevision !== binding.authorizationRevision || sourceOperationSelectionHash(root, owner.attempt, owner.identity.operationId) !== owner.attempt.placementHash
    || !isDeepStrictEqual(owner.source, root.source)) throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source operation is not owned by the current exact authenticated main/device/attempt.')
  if (request.operation === 'sources.prepare' || request.operation === 'sources.capacity') {
    if (!isDeepStrictEqual(request.root, root) || !isDeepStrictEqual(request.attempt, owner.attempt) || !isDeepStrictEqual(request.identity, owner.identity))
      throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Preparation cannot change the accepted original source/root/owner identity.')
    if (request.operation === 'sources.prepare' && !isDeepStrictEqual(request.worktree, owner.worktree)) {
      throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Preparation cannot change the accepted Agent branch request.')
    }
    if (request.operation === 'sources.prepare' && !isDeepStrictEqual(request.retainedReceipt, owner.retainedReceipt)) {
      throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Preparation cannot substitute the retained node directory.')
    }
    if (request.operation === 'sources.prepare' && request.worktree
      && (owner.preparationKind !== 'workflow' || root.binding.accessMode !== 'exclusive-write')) {
      throw new SourceError('SOURCE_READ_ONLY', 'Agent branches require a writable workflow source.')
    }
  } else if (request.operation === 'sources.reconcile-preparation') {
    if (owner.preparationClosed !== true) throw new SourceError('source-reconciliation-unconfirmed', 'Original Main preparation admission is not closed.')
  } else if (!owner.record || !isDeepStrictEqual(request.record, owner.record) || request.record.operationId !== owner.identity.operationId
    || !isDeepStrictEqual(request.record.receipt.binding, root.binding) || !isDeepStrictEqual(attemptOf(request.record), owner.attempt))
    throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source operation does not match the actual persisted materialization owner.')
  if (request.operation === 'sources.release' && !owner.physicalClosureConfirmed)
    throw new SourceError('SOURCE_EXECUTION_UNCERTAIN', 'Physical original ownership closure is not positively confirmed by Main.')
  if (request.operation === 'sources.private-repository' && root.binding.accessMode !== 'exclusive-write')
    throw new SourceError('SOURCE_READ_ONLY', 'Read-only source references cannot acquire writable repository authority.')
  return owner
}
async function localManifest(receipt: MaterializationReceipt): Promise<SourceManifest> {
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    const reservation = await materializationDirectory(root, receipt)
    try {
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await record.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid private materialization record.')
        const value = JSON.parse(await record.readFile('utf8')) as { receipt: unknown; manifest: unknown }
        const manifest = verifySourceManifest(value.manifest)
        if (!isDeepStrictEqual(value.receipt, receipt) || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== receipt.binding.snapshotId)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Private source metadata differs from its accepted immutable receipt.')
        return manifest
      } finally { await record.close() }
    } finally { await reservation.close() }
  } finally { await root.close() }
}
export class SourceOperationWorkerService {
  private active = 0
  private readonly preparing = new Set<string>()
  constructor(private readonly options: SourceOperationWorkerOptions) {}
  private async reclaimReservation(request: ReturnType<typeof SourceReservationReclamationRequestSchema.parse>,
    context: SourceOperationWorkerContext) {
    await this.options.authenticate(context)
    if (context.bytes?.byteLength || !this.options.currentReclamation || !this.options.reclamationNativeClosed) {
      throw new SourceError('source-reconciliation-unconfirmed', 'Source reservation cleanup authority is unavailable.')
    }
    const grant = SourceReservationReclamationSchema.parse(await this.options.currentReclamation(
      request.reservationId, request.reclamationId, context))
    if (grant.reservationId !== request.reservationId || grant.reclamationId !== request.reclamationId
      || Date.parse(grant.expiresAt) <= Date.now()) {
      throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source cleanup belongs to another reservation.')
    }
    if (this.preparing.has(grant.operationId)) {
      throw new SourceError('source-reconciliation-unconfirmed', 'Original source preparation is still active.')
    }
    this.preparing.add(grant.operationId)
    try {
      const allowlist = ApprovedRootAllowlistSchema.parse(await this.options.approvedRoots())
      const binding = context.binding
      if (allowlist.hostRef.kind !== 'device' || allowlist.hostRef.mainId !== binding.mainId
        || allowlist.hostRef.deviceId !== binding.deviceId || allowlist.applicationInstallationId !== binding.workerInstallationId) {
        throw new SourceError('SOURCE_ROOT_CONFLICT', 'Source cleanup requires the approved Worker installation.')
      }
      for (const root of grant.roots) {
        if (root.binding.mainId !== binding.mainId || root.binding.deviceId !== binding.deviceId
          || root.binding.workerInstallationId !== binding.workerInstallationId
          || root.registration?.keyRevision !== binding.keyRevision
          || root.registration.authorizationRevision !== binding.authorizationRevision
          || root.binding.canonicalPath !== join(allowlist.managedRuntimeRoot, 'source-materializations', z.uuid().parse(root.selection.rootPolicyId))) {
          throw new SourceError('SOURCE_ROOT_CONFLICT', 'Source cleanup cannot change the original approved namespace.')
        }
      }
      await verifyApprovedRootAllowlist(allowlist)
      const result = await reclaimSourceReservation(grant, {
        ...(this.options.git ? { git: this.options.git } : {}),
        authorize: async () => {
          context.signal.throwIfAborted()
          await this.options.authenticate(context)
          if (!isDeepStrictEqual(grant, await this.options.currentReclamation!(request.reservationId,
            request.reclamationId, context))) {
            throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source cleanup authority changed.')
          }
        },
        operationClosed: operationId => this.options.reclamationNativeClosed!(null, operationId),
        nativeClosed: owner => this.options.reclamationNativeClosed!(owner, grant.operationId),
        quotaPoolFor: owner => this.options.quotaPoolFor?.(owner.root.binding)
          ?? Promise.resolve(undefined),
        closed: async closure => {
          await this.options.preparationTransfersClosed?.(closure, context.signal)
          await this.options.preparationReconciled?.(closure)
        },
      }, context.signal)
      return SourceReservationReclamationResponseSchema.parse({ version: 1, operation: 'sources.reclaim-reservation',
        reservationId: grant.reservationId, reclamationId: grant.reclamationId,
        operationId: grant.operationId, reclaimed: !result.retained, ...result })
    } finally { this.preparing.delete(grant.operationId) }
  }
  private async authority(request: SourceFilesystemOperation, context: SourceOperationWorkerContext) {
    context.signal.throwIfAborted(); await this.options.authenticate(context)
    if ((context.bytes?.byteLength ?? 0) !== 0) throw new SourceError('SOURCE_OPERATION_INVALID', 'Source control operations contain no inline binary bytes.')
    const owner = checkOwner(request, await this.options.currentOwner(request, context), context)
    context.signal.throwIfAborted(); return owner
  }
  async handle(raw: unknown, context: SourceOperationWorkerContext): Promise<SourceOperationResponse> {
    if (raw && typeof raw === 'object' && 'operation' in raw && raw.operation === 'sources.reclaim-reservation') {
      if (this.active >= SOURCE_OPERATION_EXTENSION.maxPending) throw new SourceError('SOURCE_CAPACITY', 'Source operation capacity is exhausted.')
      this.active++
      try {
        return await this.reclaimReservation(SourceReservationReclamationRequestSchema.parse(raw), context)
      } finally { this.active-- }
    }
    const request = SourceFilesystemOperationSchema.parse(raw)
    if (Buffer.byteLength(JSON.stringify(request)) > SOURCE_OPERATION_EXTENSION.maxJsonBytes) throw new SourceError('SOURCE_CAPACITY', 'Source operation metadata exceeds its carrier budget.')
    if (this.active >= SOURCE_OPERATION_EXTENSION.maxPending) throw new SourceError('SOURCE_CAPACITY', 'Source operation capacity is exhausted.')
    this.active++
    let preparation: string | undefined
    try {
      let owner = await this.authority(request, context)
      if (['sources.prepare', 'sources.private-repository', 'sources.reconcile-preparation'].includes(request.operation)) {
        preparation = owner.identity.operationId
        if (this.preparing.has(preparation)) { preparation = undefined; throw new SourceError('source-reconciliation-unconfirmed', 'Original source preparation is still active.') }
        this.preparing.add(preparation)
      }
      // Authenticate and resolve the actual owner before local config or target IO.
      const allowlist = ApprovedRootAllowlistSchema.parse(await this.options.approvedRoots())
      if (allowlist.hostRef.kind !== 'device' || allowlist.hostRef.mainId !== context.binding.mainId || allowlist.hostRef.deviceId !== context.binding.deviceId
        || allowlist.applicationInstallationId !== context.binding.workerInstallationId
        || owner.root.binding.canonicalPath !== join(allowlist.managedRuntimeRoot, 'source-materializations', z.uuid().parse(owner.root.selection.rootPolicyId)))
        throw new SourceError('SOURCE_ROOT_CONFLICT', 'Source paths must belong to the actual human-approved host runtime namespace.')
      await verifyApprovedRootAllowlist(allowlist)
      const reauthorize = async () => {
        const current = await this.authority(request, context)
        const { activeNativeSession: previousSession, ...previousOwner } = owner
        const { activeNativeSession: currentSession, ...currentOwner } = current
        if (!isDeepStrictEqual(currentOwner, previousOwner) || !sourceNativeSessionContinues(previousSession, currentSession)) {
          throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Current source ownership changed during the filesystem operation.')
        }
        owner = current
      }
      if (request.operation === 'sources.capacity') {
        const capacity = await readSourceStorageCapacity(owner.root.binding.canonicalPath,
          owner.root.binding.filesystem, this.options.mainNow)
        await reauthorize()
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, capacity })
      }
      const reader = null
      const quotaPool = owner.quotaRequired || owner.record?.receipt.quota
        ? await this.options.quotaPoolFor?.(owner.root.binding) : undefined
      if (owner.quotaRequired && !quotaPool) {
        throw new SourceError('SOURCE_QUOTA_MISSING', 'The original verification Job requires its installed quota pool.')
      }
      if (request.operation === 'sources.reconcile-preparation') {
        if (!this.options.preparationNativeClosed) throw new SourceError('source-reconciliation-unconfirmed', 'Original native closure evidence is unavailable.')
        const closure = await reconcileSourcePreparation(request.reconciliationId, owner,
          () => this.options.preparationNativeClosed!(owner.identity.operationId, owner), reauthorize, quotaPool, context.signal)
        await this.options.preparationTransfersClosed?.(closure, context.signal)
        await reauthorize()
        await this.options.preparationReconciled?.(closure)
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, closure })
      }
      if (request.operation === 'sources.prepare') {
        const materializer = new PrivateSourceMaterializer(reader, reauthorize, quotaPool)
        const recovered = await materializer.recover(owner.root.binding, owner.attempt, context.signal)
        if (recovered) {
          assertWorktreeReceipt(recovered, owner.worktree)
          await reauthorize()
          return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, receipt: recovered })
        }
        const github = await openGitHubSource(this.options.git ?? systemGitWorktreePorts(), request.github, owner.source, context.signal)
        await reauthorize()
        const manifest = github.manifest
        const receiptValue = await new PrivateSourceMaterializer(github.reader, reauthorize, quotaPool).prepare({ manifest,
          binding: owner.root.binding, attempt: owner.attempt, signal: context.signal,
          ...(owner.retainedReceipt ? { retainedReceipt: owner.retainedReceipt } : {}),
          ...(owner.preparationKind === 'workflow' && owner.root.binding.accessMode === 'exclusive-write'
            ? { sharedWritableTree: true, ...(request.worktree ? { worktree: request.worktree } : {}) } : {}),
          ...(owner.preparationKind === 'workflow' && owner.root.binding.accessMode === 'read-only'
            ? { sharedReadOnlyTree: true } : {}) })
        await reauthorize()
        assertWorktreeReceipt(receiptValue, owner.worktree, manifest.git?.commit)
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, receipt: receiptValue })
      }
      const record = request.record
      const materializer = new PrivateSourceMaterializer(reader, reauthorize, quotaPool)
      if (request.operation === 'sources.verify') {
        let capture: SourceNativeSessionCapture | undefined
        if (owner.activeNativeSession) {
          const installed = await this.options.nativeOwnerFor?.(record), proof = owner.activeNativeSession
          if (!installed) throw new SourceError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original installed native lifetime is unavailable.')
          const assertCurrent = async () => {
            installed.signal.throwIfAborted(); context.signal.throwIfAborted()
            await reauthorize()
            if (installed.executionId !== proof.executionId || installed.runId !== proof.runId || installed.technicalAttempt !== proof.technicalAttempt || installed.attemptId !== proof.attemptId
              || installed.operationId !== proof.operationId || installed.materializationId !== proof.materializationId
              || installed.sourceBindingHash !== proof.sourceBindingHash || installed.finalDispatchBindingHash !== proof.finalDispatchBindingHash
              || !isDeepStrictEqual(installed.session, proof.nativeSession) || !isDeepStrictEqual(installed.owner, proof.owner))
              throw new SourceError('SOURCE_NATIVE_SESSION_CONFLICT', 'Main continuation evidence differs from the actual original installed native lifetime.')
            await installed.assertCurrent(); installed.signal.throwIfAborted(); context.signal.throwIfAborted()
          }
          capture = { get proof() { return owner.activeNativeSession! },
            signal: AbortSignal.any([context.signal, installed.signal]), assertCurrent }
          await assertSourceNativeSession(record, capture)
        }
        const verified = await verifyMaterializedWorkingDirectory(record, request.relativeCwd, reauthorize, capture)
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, workTree: verified.canonicalProjectRoot,
          canonicalCwd: verified.canonicalCwd, directoryIdentityHash: verified.directoryIdentityHash,
          filesystem: verified.cwdAttestation!.filesystem, accessMode: verified.accessMode, cwdAttestation: verified.cwdAttestation })
      }
      if (request.operation === 'sources.private-repository') {
        const manifest = await localManifest(record.receipt)
        if (manifest.approvedSourceId !== owner.source.approvedSourceId) throw new SourceError('SOURCE_PIN_CONFLICT', 'Private repository is bound to a different approved source.')
        const repository = await createPrivateSourceRepository({ receipt: record.receipt, manifest, materializer, attempt: owner.attempt, signal: context.signal }).catch((error: unknown) => {
          // W07 only sends bounded lowercase domain codes, never Error messages,
          // paths or child-process handles. Main maps this exact operation code.
          if ((error as { code?: string }).code === 'SOURCE_REPOSITORY_TIMEOUT') throw new SourceError('source-repository-timeout', 'Private source preparation timed out.', { cause: error })
          if ((error as { code?: string }).code === 'SOURCE_REPOSITORY_UNCERTAIN') throw new SourceError('source-repository-uncertain', 'Original private source preparation requires reconciliation.', { cause: error })
          throw error
        })
        await reauthorize(); return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, repository })
      }
      await reauthorize()
      await releaseMaterializationClaim(record.receipt, async () => {
        const current = await this.authority(request, context)
        return current.physicalClosureConfirmed ? 'released' : 'uncertain'
      }, quotaPool, context.signal)
      await this.options.executionTransfersClosed?.(record, context.signal)
      await reauthorize()
      const worktree = owner.retainWorkingTree && record.receipt.worktree
        ? { state: 'retained' as const, message: 'The active Run retains this node working directory.' }
        : await closeSourceWorktree(record.receipt, context.signal)
      const footprint = { ...await measureRetainedMaterializationFootprint(record.receipt), ...(worktree ? { worktree } : {}) }
      await reauthorize()
      return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation,
        materializationId: record.receipt.materializationId, operationId: record.operationId, released: true, ...footprint })
    } finally { if (preparation) this.preparing.delete(preparation); this.active-- }
  }
}
export function createSourceOperationWorkerHandler(options: SourceOperationWorkerOptions) {
  const service = new SourceOperationWorkerService(options)
  return (payload: unknown, context: SourceOperationWorkerContext) => service.handle(payload, context)
}
