import { encodeMaterializationRecord } from './materializationRecord.js'
import { importGitSourceObjects } from './gitSourceObjects.js'
import { processSourceDirectories } from './entryProcessing.js'
import { sourceMaterializationClaimName, restoreQuotaMaterializationClaim, writeSourceClaim } from './quotaClaims.js'
import { reclaimMaterializationQuota, reclaimPreparationQuota, removeSourceDirectory } from './quotaReclamation.js'
import { archiveMaterializationClaim, materializationDirectory, verifyMaterializedSourceTree, withClaimLock,
  type SourceQuotaPool } from './materializationClaim.js'
export { archiveMaterializationClaim, materializationDirectory, verifyMaterializedSourceTree, withClaimLock,
  type SourceQuotaPool } from './materializationClaim.js'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, mkdir, rename, statfs, readdir, readlink, stat, readFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, MaterializationReceiptSchema, RootBindingSchema, type MaterializationReceipt, type RootBinding, type SourceManifest, type SourceSnapshotReference, SourceMaterializationFileSchema, sourceMaterializationParent, type SourceProjectQuotaSlot } from '@foreman-code/contracts/source-materialization'
import { sourceMaterializationBytes } from './footprint.js'
import { SOURCE_LIMITS, SourceError, verifySourceBytes, verifySourceManifest } from './manifest.js'
import { anchored, identity, openChildDirectory, openPrivateRoot,
  withPrivateDirectoryLock } from './privateFilesystem.js'
import type { MaterializationAttempt, SourceByteReader } from './ports.js'
import { SourcePreparationClosureSchema, type SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import { verifyJobQuotaOwnership } from '../jobs/quotaOwnership.js'
import { prepareAgentWorktree, prepareSharedWorkingTree, verifySharedWorkingTree } from './sharedWorkingTree.js'
import { assertWorktreeReceipt, verifyWorktreeBranch } from './worktreeRequest.js'
import { systemGitWorktreePorts, type GitWorktreePorts, type WorktreeRequest } from './gitWorktree.js'
import { sourceWorkingTreePath } from './sourceTreePaths.js'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { componentLogger } from '../diagnostics/logger.js'
import { reconcileSecondaryAllocation, preserveReleasedPreparationClaim } from './secondaryAllocation.js'
import { openSnapshotReference } from './snapshotReference.js'
import { verifyRetainedWorkingTree } from './retainedWorkingTree.js'

const equal = isDeepStrictEqual
export class PrivateSourceMaterializer {
  private active = 0
  constructor(private readonly bytes: SourceByteReader | null,
    private readonly authorize: (binding: RootBinding, attempt: MaterializationAttempt) => Promise<void>,
    private readonly quotaPool?: SourceQuotaPool,
    private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}
  async prepare(input: { manifest: SourceManifest; binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal;
    sharedWritableTree?: true; sharedReadOnlyTree?: true
    /** Workflow agents in a GitHub workspace get their own worktree and branch instead of the shared copy. */
    worktree?: WorktreeRequest; retainedReceipt?: MaterializationReceipt }): Promise<MaterializationReceipt> {
    const bytes = this.bytes
    if (!bytes) throw new SourceError('SOURCE_READ_ONLY_VERIFIER', 'A verification-only materializer cannot prepare source bytes.')
    const started = performance.now()
    let checkpoint = started
    const phases: Record<string, number> = {}
    const completed = (phase: string) => {
      const now = performance.now()
      phases[phase] = Math.round(now - checkpoint)
      checkpoint = now
    }
    const manifest = verifySourceManifest(input.manifest), binding = RootBindingSchema.parse(input.binding)
    if (binding.snapshotId !== manifest.snapshotId || binding.manifestDigest !== manifest.manifestDigest)
      throw new SourceError('SOURCE_PIN_CONFLICT', 'The root is not bound to this exact source snapshot.')
    if (input.worktree && input.worktree.repository !== manifest.git?.repository) {
      throw new SourceError('SOURCE_PIN_CONFLICT', 'The worktree repository differs from the approved source.')
    }
    if (input.worktree && (binding.accessMode !== 'exclusive-write' || !input.sharedWritableTree)) {
      throw new SourceError('SOURCE_READ_ONLY', 'Agent branches require a writable workflow source.')
    }
    if (input.sharedReadOnlyTree && binding.accessMode !== 'read-only') {
      throw new SourceError('SOURCE_READ_ONLY', 'Shared read-only checkouts require a read-only source binding.')
    }
    const attempt = input.attempt
    // Parse every accepted attempt pin before any I/O; the authorization port
    // rechecks current device/root/placement authority, never chooses a new pin.
    MaterializationReceiptSchema.shape.placementHash.parse(attempt.placementHash)
    MaterializationReceiptSchema.shape.executionId.parse(attempt.executionId)
    MaterializationReceiptSchema.shape.attemptId.parse(attempt.attemptId)
    MaterializationReceiptSchema.shape.keyRevision.parse(attempt.keyRevision)
    MaterializationReceiptSchema.shape.authorizationRevision.parse(attempt.authorizationRevision)
    if ((binding.deviceId === null) !== (binding.workerInstallationId === null)
      || (binding.deviceId === null) !== (attempt.keyRevision === null && attempt.authorizationRevision === null))
      throw new SourceError('SOURCE_HOST_IDENTITY_INVALID', 'Original-main roots have no worker registration; device roots require actual worker authorization pins.')
    const signal = AbortSignal.any([AbortSignal.timeout(SOURCE_LIMITS.preparationMs), ...(input.signal ? [input.signal] : [])])
    signal.throwIfAborted()
    await this.authorize(binding, attempt)
    signal.throwIfAborted()
    const recovered = await this.recover(binding, attempt, signal)
    if (recovered) {
      assertWorktreeReceipt(recovered, input.worktree, manifest.git?.commit)
      return recovered
    }
    if (this.active >= SOURCE_LIMITS.concurrent) throw new SourceError('SOURCE_CAPACITY', 'Materialization concurrency is exhausted.')
    this.active++
    let slotDirectory: FileHandle | undefined
    let quota: SourceProjectQuotaSlot | undefined
    let snapshotReference: SourceSnapshotReference | undefined
    let root: FileHandle | undefined, reservation: FileHandle | undefined, tree: FileHandle | undefined
    const id = randomUUID(), lockName = sourceMaterializationClaimName(binding, attempt, this.quotaPool, 'execution')
    try {
      signal.throwIfAborted()
      root = await openPrivateRoot(binding.canonicalPath)
      if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination filesystem identity changed.')
      await withClaimLock(root, async () => {
        if (this.quotaPool) {
          const prior = await open(anchored(root!, lockName), constants.O_RDONLY | constants.O_NOFOLLOW)
            .catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
          if (prior) {
            await prior.close()
            throw new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'This preparation already owns a quota slot; recover it.')
          }
        }
        if (this.quotaPool) {
          for (const slot of this.quotaPool.pool.slots) {
            await verifyJobQuotaOwnership({ ...this.quotaPool, binding, slot, signal })
            try {
              await writeSourceClaim(root!, `quota-${slot.namespace}.claim.json`, JSON.stringify({
                version: 1, materializationId: id, binding, attempt, quota: slot,
              }), signal)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
              throw error
            }
            quota = slot
            break
          }
          if (!quota) throw new SourceError('SOURCE_CAPACITY', 'Every per-Job quota is owned or retained.')
        }
        await writeSourceClaim(root!, lockName, JSON.stringify({ version: 1, materializationId: id,
          binding, attempt, ...(quota ? { quota } : {}) }), signal)
      }, { signal })
      // Reservation covers staging, activated copy and retained/reference space.
      const disk = await statfs(anchored(root), { bigint: true })
      const required = BigInt(sourceMaterializationBytes(manifest))
      if (disk.bavail * disk.bsize < required) throw new SourceError('SOURCE_DISK_CAPACITY', 'Insufficient reserved space for source staging and execution copies.')
      slotDirectory = quota ? await openChildDirectory(root, quota.namespace) : undefined
      const parent = slotDirectory ?? root
      await mkdir(anchored(parent, id), { mode: 0o700 })
      reservation = await openChildDirectory(parent, id)
      if (quota && this.quotaPool) {
        await verifyJobQuotaOwnership({ ...this.quotaPool, binding, slot: quota, signal,
          directory: join(binding.canonicalPath, quota.namespace, id) })
      }
      const reuseSnapshot = bytes.openReference && input.worktree && input.sharedWritableTree
        && binding.deviceId === null && !quota
      if (reuseSnapshot) {
        const reference = await bytes.openReference!(manifest, signal)
        tree = reference.tree
        snapshotReference = reference.snapshotReference
        completed('authorizationAndReservationMs')
      } else {
        await mkdir(anchored(reservation, 'staging'), { mode: 0o700 })
        tree = await openChildDirectory(reservation, 'staging')
        const staging = tree
        completed('authorizationAndReservationMs')
        if (bytes.copyTo) {
          const fileMode = binding.accessMode === 'read-only' || input.sharedWritableTree ? 0o400 : 0o600
          await bytes.copyTo(manifest, staging, fileMode, signal)
        } else {
          await processSourceDirectories(staging, manifest.entries, async (parent, entries) => {
            const write = async (entry: SourceManifest['entries'][number], content: Uint8Array) => {
              signal.throwIfAborted()
              verifySourceBytes(entry, content)
              const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
              const file = await open(anchored(parent, leaf),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
              const readOnly = binding.accessMode === 'read-only' || input.sharedWritableTree
              const mode = readOnly ? 0o400 : 0o600
              try {
                await file.writeFile(content)
                await file.chmod(mode | (entry.executable ? 0o100 : 0))
                await file.sync()
              } finally { await file.close() }
            }
            if (bytes.readEntries) {
              await bytes.readEntries(manifest, entries, signal, write)
            } else {
              for (const entry of entries) {
                signal.throwIfAborted()
                await write(entry, await bytes.read(manifest, entry, signal))
              }
            }
          }, { create: true, signal })
        }
      }
      completed('copyMs')
      await verifyMaterializedSourceTree(tree, manifest, signal, snapshotReference ? { snapshotBytes: true } : {})
      completed('verifyReferenceMs')
      const writable = input.sharedWritableTree && binding.accessMode === 'exclusive-write'
      if (manifest.git?.metadata) {
        const metadata = await bytes.readGitMetadata?.(manifest, signal)
        if (!metadata) throw new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'Approved Git metadata is unavailable.')
        if (writable && input.worktree) {
          await importGitSourceObjects({ ports: this.git, repository: input.worktree.repository, manifest, metadata, signal,
            blobPath: async path => snapshotReference
              ? join(snapshotReference.canonicalStorePath, manifest.snapshotId, 'bytes', path)
              : join(binding.canonicalPath, ...(quota ? [quota.namespace] : []), id, 'staging', path) })
        }
      }
      completed('importGitObjectsMs')
      signal.throwIfAborted(); await this.authorize(binding, attempt)
      const current = await openPrivateRoot(binding.canonicalPath)
      try { if (!equal(await identity(current), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root replaced before activation.') }
      finally { await current.close() }
      const referenceIdentity = await identity(tree)
      const retained = input.retainedReceipt
        ? await verifyRetainedWorkingTree(root, input.retainedReceipt, binding, this.git, signal) : undefined
      const worktree = !retained && writable && input.worktree ? await prepareAgentWorktree({
        root, binding, primary: reservation, materializationId: id, attempt, executionId: attempt.executionId,
        manifest, reference: tree, request: input.worktree, ports: this.git, signal,
        authorize: () => this.authorize(binding, attempt),
      }) : undefined
      const retainedDirectory = retained ? { id: retained.sharedTree?.id ?? retained.materializationId,
        filesystem: retained.localTreeIdentity } : undefined
      const shared = retainedDirectory ?? worktree ?? (writable || input.sharedReadOnlyTree
        ? await withClaimLock(root, () => prepareSharedWorkingTree({
          root: root!, binding, primary: reservation!, materializationId: id, attempt, manifest,
          reference: tree!, signal, authorize: () => this.authorize(binding, attempt),
        })) : undefined)
      completed('prepareWorkingTreeMs')
      const branch = retained?.worktree ?? worktree?.worktree
      const receipt = MaterializationReceiptSchema.parse({ version: 1, materializationId: id, binding, ...attempt, ...(quota ? { quota } : {}),
        claimScope: 'execution',
        ...(retained ? { retainedTree: { materializationId: retained.materializationId, executionId: retained.executionId } } : {}),
        ...(shared ? { sharedTree: { id: shared.id, referenceIdentity } } : {}),
        ...(branch ? { worktree: branch } : {}),
        verifiedManifestDigest: manifest.manifestDigest, verifiedEntries: manifest.totalEntries,
        verifiedBytes: manifest.totalBytes, verifiedAt: new Date().toISOString(), localTreeIdentity: shared?.filesystem ?? referenceIdentity })
      const encodedRecord = encodeMaterializationRecord({ receipt, manifest, ...(snapshotReference ? { snapshotReference } : {}) })
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await record.writeFile(encodedRecord); await record.sync() } finally { await record.close() }
      if (!snapshotReference) await tree.sync()
      // The fresh UUID reservation is exclusively app-owned. Its tree name has
      // never existed; rename cannot overwrite a caller or an execution tree.
      signal.throwIfAborted()
      if (!snapshotReference) await rename(anchored(reservation, 'staging'), anchored(reservation, 'tree'))
      await reservation.sync(); await root.sync()
      completed('activateMs')
      componentLogger('engine').info({ executionId: attempt.executionId, attemptId: attempt.attemptId,
        snapshotId: manifest.snapshotId, entries: manifest.totalEntries, durationMs: Math.round(performance.now() - started),
        phases }, 'source preparation completed')
      return receipt
    } finally {
      await tree?.close(); await reservation?.close(); await slotDirectory?.close(); await root?.close(); this.active--
      // Retain the binding lock even on failure/uncertain activation. Only
      // W08/W01 reconciliation may release it or reclaim its private directory.
    }
  }
  /** Exact lost-activation-ack recovery. Incomplete claims remain uncertain;
   * no new directory/attempt is allocated and no old claim is discarded. */
  async recover(binding: RootBinding, attempt: MaterializationAttempt,
    signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)): Promise<MaterializationReceipt | null> {
    signal.throwIfAborted()
    RootBindingSchema.parse(binding); await this.authorize(binding, attempt)
    signal.throwIfAborted()
    const root = await openPrivateRoot(binding.canonicalPath)
    try {
      if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
      const readClaim = (name: string) => open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      const claimPath = sourceMaterializationClaimName(binding, attempt, this.quotaPool, 'execution')
      let lock = await readClaim(claimPath)
      if (!lock && this.quotaPool) {
        await withClaimLock(root, () => restoreQuotaMaterializationClaim(root, binding, attempt, this.quotaPool!.pool, signal), { signal })
        lock = await readClaim(claimPath)
      }
      const legacy = !lock && !this.quotaPool && binding.accessMode === 'exclusive-write'
      if (legacy) lock = await readClaim(sourceMaterializationClaimName(binding, attempt))
      if (!lock) return null
      let claim: { materializationId: string; binding: RootBinding; attempt: MaterializationAttempt; quota?: SourceProjectQuotaSlot }
      try {
        const stat = await lock.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid source ownership claim.')
        claim = JSON.parse(await lock.readFile('utf8')) as typeof claim
      } finally { await lock.close() }
      if (legacy && claim.attempt.executionId !== attempt.executionId) return null
      MaterializationReceiptSchema.shape.materializationId.parse(claim.materializationId)
      if (!equal(claim.binding, binding) || !equal(claim.attempt, attempt)) throw new SourceError('SOURCE_ROOT_OWNED', 'The root belongs to another accepted execution/attempt.')
      try {
        const directory = await materializationDirectory(root, {
          materializationId: claim.materializationId, ...(claim.quota ? { quota: claim.quota } : {}),
        })
        let receipt: MaterializationReceipt
        try {
          const file = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) {
              throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid source receipt record.')
            }
            receipt = MaterializationReceiptSchema.parse(
              (JSON.parse(await file.readFile('utf8')) as { receipt: unknown }).receipt)
          } finally { await file.close() }
        } finally { await directory.close() }
        await this.verify(receipt, { binding, attempt, signal })
        return receipt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN',
            'Source preparation was interrupted before activation; reconcile this attempt.', { cause: error })
        }
        throw error
      }
    } finally { await root.close() }
  }
  async verify(input: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<void> {
    expected.signal?.throwIfAborted()
    const receipt = MaterializationReceiptSchema.parse(input)
    if (!equal(receipt.binding, RootBindingSchema.parse(expected.binding)) || !equal({ placementHash: receipt.placementHash,
      executionId: receipt.executionId, attemptId: receipt.attemptId, keyRevision: receipt.keyRevision,
      authorizationRevision: receipt.authorizationRevision }, expected.attempt)) throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Materialization does not match the accepted root and attempt.')
    await this.authorize(receipt.binding, expected.attempt)
    if (receipt.quota && this.quotaPool) {
      await verifyJobQuotaOwnership({ ...this.quotaPool, binding: receipt.binding, slot: receipt.quota,
        signal: expected.signal ?? AbortSignal.timeout(10_000), directory: sourceMaterializationParent(receipt) })
    }
    const root = await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      if (!equal(await identity(root), receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
      const directory = await materializationDirectory(root, receipt)
      try {
        const record = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        let stored: ReturnType<typeof SourceMaterializationFileSchema.parse>
        try {
          const stat = await record.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid receipt record.')
          stored = SourceMaterializationFileSchema.parse(JSON.parse(await record.readFile('utf8')))
        } finally { await record.close() }
        const manifest = verifySourceManifest(stored.manifest)
        if (!equal(stored.receipt, receipt) || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== receipt.binding.snapshotId
          || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Stored source receipt changed.')
        const tree = stored.snapshotReference
          ? await openSnapshotReference(stored.snapshotReference, manifest, expected.signal)
          : await openChildDirectory(directory, 'tree')
        try {
          if (!equal(await identity(tree), receipt.sharedTree?.referenceIdentity ?? receipt.localTreeIdentity)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Materialized source reference replaced.')
          await verifyMaterializedSourceTree(tree, manifest, expected.signal,
            stored.snapshotReference ? { snapshotBytes: true } : {})
          if (receipt.retainedTree) await verifyRetainedWorkingTree(root, receipt, receipt.binding, this.git, expected.signal)
          else await verifySharedWorkingTree(root, receipt)
          await verifyWorktreeBranch(receipt, { git: this.git, signal: expected.signal })
        } finally { await tree.close() }
      } finally { await directory.close() }
    } finally { await root.close() }
  }
  async resolve(receipt: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<string> {
    await this.verify(receipt, expected)
    return sourceWorkingTreePath(receipt)
  }
}
/** Called only after authoritative execution reconciliation, never on disconnect. */
export async function releaseMaterializationClaim(receipt: MaterializationReceipt,
  reconcile: () => Promise<'released' | 'owned' | 'uncertain'>, quotaPool?: SourceQuotaPool,
  signal = AbortSignal.timeout(60_000)): Promise<void> {
  if (receipt.quota) {
    if (!quotaPool) throw new SourceError('SOURCE_QUOTA_MISSING', 'The original quota configuration is required for cleanup.')
    return reclaimMaterializationQuota(receipt, quotaPool, reconcile, signal)
  }
  await archiveMaterializationClaim(receipt, { filesystem: receipt.binding.filesystem, signal }, reconcile)
  if (!receipt.sharedTree && receipt.binding.deviceId === null) return
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (!equal(await identity(root), receipt.binding.filesystem)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed before reference cleanup.')
    }
    await withClaimLock(root, async () => {
      if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution closure changed.')
      const directory = await materializationDirectory(root, receipt)
      try {
        // Keep the receipt for idempotent closure and any separate shared working tree.
        await removeSourceDirectory(directory, 'tree', receipt, signal)
      } finally { await directory.close() }
    }, { signal })
  } finally { await root.close() }
}

/** Only the separately signed original-Job cleanup grant can authorize a restored volume. */
export async function releaseMaterializationClaimForCancellation(receipt: MaterializationReceipt,
  filesystem: RootBinding['filesystem'], reconcile: () => Promise<'released' | 'owned' | 'uncertain'>,
  signal = AbortSignal.timeout(60_000), quotaPool?: SourceQuotaPool): Promise<void> {
  RootBindingSchema.shape.filesystem.parse(filesystem)
  if (filesystem.inode !== receipt.binding.filesystem.inode) {
    throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source root inode changed.')
  }
  if (receipt.quota) {
    if (!quotaPool) throw new SourceError('SOURCE_QUOTA_MISSING', 'Original quota configuration is required for recovery.')
    return reclaimMaterializationQuota(receipt, quotaPool, reconcile, signal, { filesystem, verifyOriginalSource: true })
  }
  return archiveMaterializationClaim(receipt, { filesystem, verifyOriginalSource: true, signal }, reconcile)
}

export async function preparationChildrenClosed(namespace: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const entries = await readdir('/proc')
  signal?.throwIfAborted()
  if (entries.length > 32768) {
    throw new SourceError('source-reconciliation-unconfirmed', 'Process inspection exceeded its process limit.')
  }
  const inside = (path: string) => path === namespace || path.startsWith(namespace + '/')
  for (const pid of entries.filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    signal?.throwIfAborted()
    const directory = `/proc/${pid}`
    try {
      if ((await stat(directory)).uid !== process.getuid?.()) continue
      // Only binaries used by installed source/native producers can own this
      // preparation. Unrelated protected login/database daemons are not its
      // children; requiring ptrace access to them would invent host authority.
      const comm = (await readFile(`${directory}/comm`, 'utf8')).trim()
      if (!['git', 'flock', 'node', 'rsync', 'podman', 'crun'].includes(comm)) continue
      if (inside(await readlink(`${directory}/cwd`))) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still uses the source directory.`)
      }
      const args = await open(`${directory}/cmdline`, constants.O_RDONLY)
      try {
        const bytes = Buffer.alloc(65536), result = await args.read(bytes, 0, bytes.length, 0)
        if (result.bytesRead === bytes.length) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} exceeded the argument inspection limit.`)
        }
        if (bytes.subarray(0, result.bytesRead).toString().split('\0').some(inside)) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still references the source directory.`)
        }
      } finally { await args.close() }
      const descriptors = await readdir(`${directory}/fd`)
      if (descriptors.length > 8192) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} exceeded the descriptor inspection limit.`)
      }
      for (const fd of descriptors) {
        signal?.throwIfAborted()
        if (inside(await readlink(`${directory}/fd/${fd}`))) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still holds a source descriptor.`)
        }
      }
    } catch (error) {
      if (error instanceof SourceError) throw error
      signal?.throwIfAborted()
      const code = (error as NodeJS.ErrnoException).code ?? ''
      // Unrelated protected processes and processes that exit during inspection do not own this namespace.
      if (!['EACCES', 'ENOENT', 'ESRCH'].includes(code)) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} could not be inspected.`, { cause: error })
      }
    }
  }
  return true
}

/** Reconcile the original preparation; quota copies are reclaimed after positive closure. */
export async function reconcileSourcePreparation(reconciliationId: string, owner: SourceOperationOwner,
  nativeClosed: () => Promise<boolean>, reauthorize: () => Promise<void>, quotaPool?: SourceQuotaPool, signal?: AbortSignal): Promise<SourcePreparationClosure> {
  const remaining = Math.max(0, Date.parse(owner.identity.expiresAt) - Date.now())
  if (!remaining) throw new SourceError('SOURCE_PREPARATION_EXPIRED', 'Original source cleanup authority expired.')
  const cleanupSignal = AbortSignal.any([AbortSignal.timeout(Math.min(remaining, 4_294_967_295)), ...(signal ? [signal] : [])])
  cleanupSignal.throwIfAborted()
  SourcePreparationClosureSchema.shape.reconciliationId.parse(reconciliationId)
  if (owner.preparationClosed !== true) throw new SourceError('source-reconciliation-unconfirmed', 'Main preparation admission closure is not confirmed.')
  await reauthorize()
  cleanupSignal.throwIfAborted()
  const binding = RootBindingSchema.parse(owner.root.binding), root = await openPrivateRoot(binding.canonicalPath)
  try {
    cleanupSignal.throwIfAborted()
    if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Original source cleanup root changed.')
    return await withPrivateDirectoryLock(root, async () => {
      const proofName = `closed-preparation-${reconciliationId}.json`, archiveName = `closed-preparation-${reconciliationId}.claim.json`
      const readRecord = async (name: string) => {
        cleanupSignal.throwIfAborted()
        const file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          cleanupSignal.throwIfAborted()
          const stat = await file.stat()
          cleanupSignal.throwIfAborted()
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 16384)
            throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid original preparation cleanup record.')
          const bytes = await file.readFile({ encoding: 'utf8', signal: cleanupSignal })
          cleanupSignal.throwIfAborted()
          return JSON.parse(bytes) as unknown
        } finally { await file.close() }
      }
      const optionalRecord = async (name: string) => readRecord(name).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      const prior = await optionalRecord(proofName)
      if (prior) {
        cleanupSignal.throwIfAborted()
      const proof = SourcePreparationClosureSchema.parse(prior)
        if (proof.reconciliationId !== reconciliationId || proof.operationId !== owner.identity.operationId || proof.executionId !== owner.attempt.executionId
          || proof.attemptId !== owner.attempt.attemptId || proof.rootId !== binding.rootId || proof.bindingRevision !== binding.bindingRevision
          || !equal(proof.filesystem, binding.filesystem)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Closure proof belongs to another original preparation.')
        await reauthorize(); return proof
      }
      const lockName = sourceMaterializationClaimName(binding, owner.attempt, quotaPool ?? owner.record?.receipt.quota,
        owner.record ? owner.record.receipt.claimScope : 'execution')
      const archive = await optionalRecord(archiveName)
      if (!archive && quotaPool) await restoreQuotaMaterializationClaim(root, binding, owner.attempt, quotaPool.pool, cleanupSignal)
      const current = archive ?? await optionalRecord(lockName)
      const pending = current as { materializationId: string; quota?: SourceProjectQuotaSlot } | null
      const namespace = owner.record ? sourceMaterializationParent(owner.record.receipt)
        : pending ? join(binding.canonicalPath, ...(pending.quota ? [pending.quota.namespace] : []),
          MaterializationReceiptSchema.shape.materializationId.parse(pending.materializationId)) : binding.canonicalPath
      cleanupSignal.throwIfAborted()
      if (!await nativeClosed()) {
        throw new SourceError('source-reconciliation-unconfirmed', 'The native owner has not confirmed closure.')
      }
      await preparationChildrenClosed(namespace, cleanupSignal)
      await reauthorize()
      cleanupSignal.throwIfAborted()
      let materializationId = owner.record?.receipt.materializationId ?? null
      let quotaReclaimed = false
      if (current) {
        const claim = current as { version: number; materializationId: string; binding: RootBinding; attempt: MaterializationAttempt; quota?: SourceProjectQuotaSlot }
        if (claim.version !== 1 || !equal(claim.binding, binding)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The original binding claim changed.')
        MaterializationReceiptSchema.shape.materializationId.parse(claim.materializationId)
        if (equal(claim.attempt, owner.attempt)) {
          if (materializationId !== null && materializationId !== claim.materializationId) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The original materialization claim changed.')
          materializationId = claim.materializationId
          cleanupSignal.throwIfAborted()
          if (!archive) await rename(anchored(root, lockName), anchored(root, archiveName))
          cleanupSignal.throwIfAborted()
          if (claim.quota) {
            if (!quotaPool) throw new SourceError('SOURCE_QUOTA_MISSING', 'Original preparation quota configuration is required.')
            await reclaimPreparationQuota({ binding, quota: claim.quota, materializationId: claim.materializationId },
              root, quotaPool, () => nativeClosed(), cleanupSignal)
            quotaReclaimed = true
          }
        } else if (archive || materializationId !== null) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup cannot release another preparation claim.')
        // A pre-activation failure may never have acquired this binding; retain
        // an unrelated current claim and every copy while closing that failure.
      } else if (materializationId !== null) {
        const quota = owner.record?.receipt.quota
        const directory = quota ? await open(anchored(root), constants.O_RDONLY | constants.O_DIRECTORY)
          : await materializationDirectory(root, { materializationId })
        try {
          const file = await open(anchored(directory, quota ? `released-binding-${materializationId}.json` : 'released-claim.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
            .catch(error => {
              if (!quota || error.code !== 'ENOENT') throw error
              return open(anchored(directory, `released-quota-${materializationId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
            })
          try {
            cleanupSignal.throwIfAborted()
            const stat = await file.stat()
            cleanupSignal.throwIfAborted()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Original release evidence is invalid.')
            const released = JSON.parse(await file.readFile({ encoding: 'utf8', signal: cleanupSignal })) as { materializationId: string; binding: RootBinding; attempt: MaterializationAttempt; quota?: SourceProjectQuotaSlot }
            if (released.materializationId !== materializationId || !equal(released.binding, binding) || !equal(released.attempt, owner.attempt)
              || quota && !equal(released.quota, quota))
              throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Original release evidence belongs to another attempt.')
          } finally { await file.close() }
        } finally { await directory.close() }
        if (quota) {
          if (!quotaPool) throw new SourceError('SOURCE_QUOTA_MISSING', 'Original recovery quota configuration is required.')
          await reclaimPreparationQuota({ binding, quota, materializationId }, root, quotaPool, nativeClosed, cleanupSignal)
          quotaReclaimed = true
        }
      }
      if (materializationId && !quotaReclaimed) {
        await reconcileSecondaryAllocation(root, binding, owner.attempt, materializationId,
          cleanupSignal, preparationChildrenClosed)
      }
      if (owner.record?.receipt.sharedTree && !quotaReclaimed && current) {
        const directory = await materializationDirectory(root, owner.record.receipt)
        try {
          await preserveReleasedPreparationClaim(directory, current, cleanupSignal)
        } finally {
          await directory.close()
        }
      }
      cleanupSignal.throwIfAborted()
      const proof = SourcePreparationClosureSchema.parse({ version: 1, reconciliationId, operationId: owner.identity.operationId,
        executionId: owner.attempt.executionId, attemptId: owner.attempt.attemptId, rootId: binding.rootId, bindingRevision: binding.bindingRevision,
        materializationId, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
        keyRevision: owner.attempt.keyRevision, authorizationRevision: owner.attempt.authorizationRevision, filesystem: binding.filesystem,
        admissionClosed: true, childrenClosed: true, claimReleased: true, evidencePreserved: true,
        ...(quotaReclaimed ? { quotaReclaimed: true } : {}), observedAt: new Date().toISOString() })
      await writeSourceClaim(root, proofName, JSON.stringify(proof), cleanupSignal)
      await reauthorize()
      cleanupSignal.throwIfAborted()
      return proof
    }, { signal: cleanupSignal })
  } finally { await root.close() }
}
