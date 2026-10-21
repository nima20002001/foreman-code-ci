import { opendir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, MaterializationReceiptSchema, RootBindingSchema, SourceProjectQuotaSlotSchema }
  from '@foreman-code/contracts/source-materialization'
import { SourceOperationAttemptSchema, SourceOperationOwnerSchema,
  type SourceOperationOwner, type SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { SourceMaterializationRecordSchema, type SourcePreparationClosure, type SourceRootRecord }
  from '@foreman-code/contracts/source-admission'
import { anchored, identity, openChildDirectory, openPrivateRoot, withPrivateDirectoryLock } from './privateFilesystem.js'
import { preparationChildrenClosed, reconcileSourcePreparation, type SourceQuotaPool } from './materialization.js'
import { removeSourceDirectory } from './quotaReclamation.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { readCleanupRecord } from './sourceCleanupMetadata.js'
import { readSecondaryAllocation, assertSecondaryOwner, preserveReleasedPreparationClaim } from './secondaryAllocation.js'
import { sourceMaterializationClaimName } from './quotaClaims.js'
import { closeSourceWorktree } from './worktreeCleanup.js'
import type { GitWorktreePorts } from './gitWorktree.js'
import { scheduler } from 'node:timers/promises'
import { SourceError } from './manifest.js'
import { measureRetainedMaterializationFootprint, measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'

export type SourceReclamationResult = {
  closures: SourcePreparationClosure[]
  retained?: RetainedSourceFootprint
}

async function removeRetainedCopy(directory: FileHandle, owner: SourceOperationOwner,
  signal: AbortSignal, authorize: () => Promise<void>, git?: GitWorktreePorts): Promise<RetainedSourceFootprint | undefined> {
  const receipt = owner.record?.receipt
  if (!receipt || receipt.quota || receipt.sharedTree && !receipt.worktree) {
    throw new SourceError('SOURCE_RECLAMATION_UNCONFIRMED', 'Retained cleanup requires a disposable execution copy.')
  }
  if (receipt.sharedTree) {
    await preparationChildrenClosed(`${receipt.binding.canonicalPath}/${receipt.sharedTree.id}`, signal)
    await authorize()
    const worktree = await closeSourceWorktree(receipt, signal, git)
    if (worktree?.state !== 'removed') {
      return { ...await measureRetainedMaterializationFootprint(receipt), ...(worktree ? { worktree } : {}) }
    }
    await authorize()
    await removeSourceDirectory(directory, receipt.sharedTree.id, receipt, signal)
  }
  await authorize()
  await removeSourceDirectory(directory, receipt.materializationId, receipt, signal)
  return undefined
}

async function retainedWorkingTree(directory: FileHandle, root: SourceRootRecord,
  owner: SourceOperationOwner, materializationId: string, reclamationId: string, signal: AbortSignal,
  authorize: () => Promise<void>, git?: GitWorktreePorts): Promise<RetainedSourceFootprint | null> {
  let receipt = owner.record?.receipt
  let copy: FileHandle
  let allocation: Awaited<ReturnType<typeof readSecondaryAllocation>>
  try {
    copy = await openChildDirectory(directory, materializationId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return receipt?.sharedTree ? measureRetainedMaterializationFootprint(receipt) : null
  }
  try {
    const raw = await readCleanupRecord(copy, 'receipt.json', signal, SOURCE_MATERIALIZATION_RECORD_MAX_BYTES)
    if (raw) {
      receipt = z.object({ receipt: MaterializationReceiptSchema }).parse(raw).receipt
      if (owner.record && !isDeepStrictEqual(receipt, owner.record.receipt)) {
        throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Retained receipt differs from the original preparation.')
      }
    }
    allocation = await readSecondaryAllocation(copy, signal)
    if (allocation) assertSecondaryOwner(allocation, root.binding, owner.attempt, materializationId)
  } finally { await copy.close() }
  if (receipt) {
    if (receipt.materializationId !== materializationId || receipt.executionId !== owner.attempt.executionId
      || receipt.attemptId !== owner.attempt.attemptId || receipt.placementHash !== owner.attempt.placementHash
      || receipt.keyRevision !== owner.attempt.keyRevision
      || receipt.authorizationRevision !== owner.attempt.authorizationRevision
      || !isDeepStrictEqual(receipt.binding, root.binding)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Retained working tree belongs to another preparation.')
    }
    if (!receipt.sharedTree) return null
    if (!receipt.worktree) {
      if (receipt.binding.accessMode !== 'read-only') return measureRetainedMaterializationFootprint(receipt)
      const parent = await openChildDirectory(directory, materializationId)
      try {
        await authorize()
        await removeSourceDirectory(parent, 'tree', receipt, signal)
      } finally { await parent.close() }
      return measureRetainedMaterializationFootprint(receipt)
    }
    await preparationChildrenClosed(`${root.binding.canonicalPath}/${receipt.sharedTree.id}`, signal)
    let worktree: RetainedSourceFootprint['worktree']
    const parent = await openChildDirectory(directory, materializationId)
    try {
      const released = await readCleanupRecord(parent, 'released-claim.json', signal)
      const raw = released ?? await readCleanupRecord(directory,
        `closed-preparation-${reclamationId}.claim.json`, signal)
      const claim = ClaimSchema.parse(raw)
      if (claim.materializationId !== materializationId || !isDeepStrictEqual(claim.binding, root.binding)
        || !isDeepStrictEqual(claim.attempt, owner.attempt)) {
        throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Worktree cleanup does not own the original claim.')
      }
      let secondary: FileHandle | undefined
      let tree: FileHandle | undefined
      try {
        secondary = await openChildDirectory(directory, receipt.sharedTree.id)
        tree = await openChildDirectory(secondary, 'tree')
        if (!isDeepStrictEqual(await identity(tree), receipt.localTreeIdentity)) {
          throw new SourceError('SOURCE_TREE_CHANGED', 'Worktree identity changed before cleanup.')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        await tree?.close()
        await secondary?.close()
      }
      await authorize()
      worktree = await closeSourceWorktree(receipt, signal, git)
      await preserveReleasedPreparationClaim(parent, claim, signal)
      await authorize()
      await removeSourceDirectory(parent, 'tree', receipt, signal)
    } finally {
      await parent.close()
    }
    return { ...await measureRetainedMaterializationFootprint(receipt), ...(worktree ? { worktree } : {}) }
  }
  if (allocation) {
    if (allocation.state === 'reclaimed') return null
    await preparationChildrenClosed(`${root.binding.canonicalPath}/${allocation.id}`, signal)
    const bytes = await measureRetainedSourceDirectory(root.binding.canonicalPath, allocation.id, root.binding.filesystem)
    const reference = await measureRetainedSourceDirectory(root.binding.canonicalPath, materializationId,
      root.binding.filesystem)
    return { retainedBytes: reference + bytes, sharedTree: { id: allocation.id, bytes } }
  }
  // A worktree marker can commit before its materialization receipt.
  const markerSchema = z.object({ id: z.uuid(), executionId: z.string(), binding: RootBindingSchema })
  for await (const entry of await opendir(anchored(directory))) {
    const name = entry.name
    signal.throwIfAborted()
    if (!/^worktree-.*\.json$/.test(name)) continue
    const raw = await readCleanupRecord(directory, name, signal)
    if (!raw) continue
    const marker = markerSchema.parse(raw)
    if (marker.executionId !== owner.attempt.executionId || !isDeepStrictEqual(marker.binding, root.binding)) continue
    const bytes = await measureRetainedSourceDirectory(root.binding.canonicalPath, marker.id, root.binding.filesystem)
    const reference = await measureRetainedSourceDirectory(root.binding.canonicalPath, materializationId,
      root.binding.filesystem)
    return { retainedBytes: reference + bytes, sharedTree: { id: marker.id, bytes } }
  }
  return null
}

const ClaimSchema = z.object({ version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  attempt: SourceOperationAttemptSchema, quota: SourceProjectQuotaSlotSchema.optional() }).strict()

function ownsClaim(root: SourceRootRecord, grant: SourceReservationReclamation,
  claim: ReturnType<typeof ClaimSchema.parse>): boolean {
  return isDeepStrictEqual(claim.binding, root.binding)
    && sourceOperationSelectionHash(root, claim.attempt, grant.operationId) === claim.attempt.placementHash
}

async function releasedOwner(directory: FileHandle, name: string, root: SourceRootRecord,
  grant: SourceReservationReclamation, signal: AbortSignal): Promise<SourceOperationOwner | null> {
  const copy = await openChildDirectory(directory, name)
  try {
    const raw = await readCleanupRecord(copy, 'released-claim.json', signal)
    if (!raw) return null
    const claim = ClaimSchema.parse(raw)
    if (!ownsClaim(root, grant, claim)) return null
    const metadata = z.object({ receipt: MaterializationReceiptSchema }).parse(
      await readCleanupRecord(copy, 'receipt.json', signal, SOURCE_MATERIALIZATION_RECORD_MAX_BYTES))
    const receipt = metadata.receipt
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId,
      attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    if (receipt.materializationId !== name || claim.materializationId !== name
      || !isDeepStrictEqual(receipt.binding, claim.binding) || !isDeepStrictEqual(attempt, claim.attempt)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Released source metadata belongs to another copy.')
    }
    return SourceOperationOwnerSchema.parse({
      identity: { operationId: grant.operationId, ownerPrincipalId: root.ownerPrincipalId, expiresAt: grant.expiresAt },
      root, source: root.source, attempt, physicalClosureConfirmed: false,
      record: SourceMaterializationRecordSchema.parse({ receipt, operationId: grant.operationId,
        reservationId: grant.reservationId, rootPolicyId: root.selection.rootPolicyId,
        rootPolicyRevision: root.selection.rootPolicyRevision, sourceBindingHash: attempt.placementHash,
        finalDispatchBindingHash: null, state: 'closed' }),
    })
  } finally {
    await copy.close()
  }
}

async function findOwners(root: SourceRootRecord, grant: SourceReservationReclamation, signal: AbortSignal) {
  const remaining = Math.max(0, Date.parse(grant.expiresAt) - Date.now())
  signal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 4_294_967_295))])
  signal.throwIfAborted()
  const directory = await openPrivateRoot(root.binding.canonicalPath)
  try {
    if (!isDeepStrictEqual(await identity(directory), root.binding.filesystem)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source cleanup root changed.')
    }
    if (grant.owner && isDeepStrictEqual(grant.owner.root, root)) {
      const owner = grant.owner
      if (owner.identity.operationId !== grant.operationId
        || sourceOperationSelectionHash(root, owner.attempt, grant.operationId) !== owner.attempt.placementHash) {
        throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup owner belongs to another operation.')
      }
      const claimName = sourceMaterializationClaimName(root.binding, owner.attempt,
        owner.record?.receipt.quota ?? (owner.quotaRequired ? true : undefined),
        owner.record?.receipt.claimScope ?? 'execution')
      const claimed = await readCleanupRecord(directory, claimName, signal)
        ?? await readCleanupRecord(directory, `closed-preparation-${grant.reclamationId}.claim.json`, signal)
      const closed = await readCleanupRecord(directory, `closed-preparation-${grant.reclamationId}.json`, signal)
      if (owner.record || claimed || closed) return [owner]
    }
    const owners = new Map<string, SourceOperationOwner>()
    if (grant.owner && isDeepStrictEqual(grant.owner.root, root)) {
      owners.set(grant.owner.attempt.executionId, grant.owner)
    }
    let pageEntries = 0
    for await (const entry of await opendir(anchored(directory), { bufferSize: 128 })) {
      signal.throwIfAborted()
      const name = entry.name
      if (name.endsWith('.lock') || name.endsWith('.claim.json')) {
        const raw = await readCleanupRecord(directory, name, signal)
        if (!raw || typeof raw === 'object' && 'kind' in raw && raw.kind === 'qualification') continue
        const claim = ClaimSchema.parse(raw)
        if (!ownsClaim(root, grant, claim)) continue
        if (!owners.has(claim.attempt.executionId)) {
          owners.set(claim.attempt.executionId, SourceOperationOwnerSchema.parse({
            identity: { operationId: grant.operationId, ownerPrincipalId: root.ownerPrincipalId, expiresAt: grant.expiresAt },
            root, source: root.source, attempt: claim.attempt, record: null, physicalClosureConfirmed: false,
            ...(claim.quota ? { quotaRequired: true } : {}),
          }))
        }
      } else if (z.uuid().safeParse(name).success) {
        const owner = await releasedOwner(directory, name, root, grant, signal)
        if (owner) owners.set(owner.attempt.executionId, owner)
      }
      if (owners.size > 1024) {
        throw new SourceError('SOURCE_CAPACITY', 'Source cleanup owner count exceeds its bound.')
      }
      pageEntries += 1
      if (pageEntries === 128) {
        pageEntries = 0
        await scheduler.yield()
      }
    }
    return [...owners.values()]
  } finally { await directory.close() }
}

export async function reclaimSourceReservation(grant: SourceReservationReclamation, ports: {
  git?: GitWorktreePorts
  authorize(): Promise<void>
  operationClosed(operationId: string): Promise<boolean>
  nativeClosed(owner: SourceOperationOwner): Promise<boolean>
  quotaPoolFor?(owner: SourceOperationOwner): Promise<SourceQuotaPool | undefined>
  closed?(closure: SourcePreparationClosure): Promise<void>
}, signal: AbortSignal): Promise<SourceReclamationResult> {
  let foundOwner = false
  const closures: SourcePreparationClosure[] = []
  const unmatchedRoots: SourceRootRecord[] = []
  let retained: RetainedSourceFootprint | undefined
  for (const root of grant.roots) {
    signal.throwIfAborted()
    await ports.authorize()
    const owners = await findOwners(root, grant, signal)
    if (!owners.length) unmatchedRoots.push(root)
    if (owners.length) foundOwner = true
    for (const original of owners) {
      const owner = SourceOperationOwnerSchema.parse({ ...original, preparationClosed: true,
        identity: { ...original.identity, expiresAt: grant.expiresAt } })
      const closure = await reconcileSourcePreparation(grant.reclamationId, owner,
        () => ports.nativeClosed(owner), ports.authorize, await ports.quotaPoolFor?.(owner), signal)
      await ports.closed?.(closure)
      if (closure.materializationId && !closure.quotaReclaimed) {
        await ports.authorize()
        const directory = await openPrivateRoot(root.binding.canonicalPath)
        try {
          if (!isDeepStrictEqual(await identity(directory), root.binding.filesystem)) {
            throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source cleanup root changed.')
          }
          const footprint = await withPrivateDirectoryLock(directory, () => grant.removeRetained
            ? removeRetainedCopy(directory, owner, signal, ports.authorize, ports.git)
            : retainedWorkingTree(directory, root, owner, closure.materializationId!, grant.reclamationId,
              signal, ports.authorize, ports.git), { signal })
          if (footprint) {
            if (retained) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Multiple retained working trees need reconciliation.')
            retained = footprint
          } else if (!grant.removeRetained) {
            await removeSourceDirectory(directory, closure.materializationId, { binding: root.binding }, signal)
          }
        } finally { await directory.close() }
      }
      await ports.authorize()
      closures.push(closure)
    }
  }
  if (!foundOwner) {
    for (const root of unmatchedRoots) await preparationChildrenClosed(root.binding.canonicalPath, signal)
    if (!await ports.operationClosed(grant.operationId)) {
      throw new SourceError('source-reconciliation-unconfirmed', 'Original native operation closure is unconfirmed.')
    }
  }
  await ports.authorize()
  return { closures, ...(retained ? { retained } : {}) }
}
