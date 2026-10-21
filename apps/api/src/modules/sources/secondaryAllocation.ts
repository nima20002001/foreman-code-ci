import { randomUUID } from 'node:crypto'
import { rename, unlink, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SecondarySourceAllocationSchema, type SecondarySourceAllocation }
  from '@foreman-code/contracts/source-operations'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { MaterializationAttempt } from './ports.js'
import { anchored, identity, openChildDirectory } from './privateFilesystem.js'
import { readCleanupRecord, removeIncompleteCleanupRecord } from './sourceCleanupMetadata.js'
import { writeSourceClaim } from './quotaClaims.js'
import { removeSourceDirectory } from './quotaReclamation.js'
import { SourceError } from './manifest.js'

export async function writeSecondaryAllocation(parent: FileHandle, input: SecondarySourceAllocation,
  signal: AbortSignal): Promise<void> {
  const allocation = SecondarySourceAllocationSchema.parse(input)
  const pending = `allocation-${randomUUID()}.pending`
  await writeSourceClaim(parent, pending, JSON.stringify(allocation), signal)
  await rename(anchored(parent, pending), anchored(parent, 'allocation.json'))
  await parent.sync()
}

export async function readSecondaryAllocation(parent: FileHandle, signal: AbortSignal) {
  const raw = await readCleanupRecord(parent, 'allocation.json', signal)
  return raw ? SecondarySourceAllocationSchema.parse(raw) : null
}

export async function preserveReleasedPreparationClaim(parent: FileHandle, claim: unknown,
  signal: AbortSignal): Promise<void> {
  const released = await readCleanupRecord(parent, 'released-claim.json', signal)
  if (released) {
    if (!isDeepStrictEqual(released, claim)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Released preparation claim changed.')
    }
    return
  }
  await writeSourceClaim(parent, 'released-claim.json', JSON.stringify(claim), signal)
}

export function assertSecondaryOwner(allocation: SecondarySourceAllocation, binding: RootBinding,
  attempt: MaterializationAttempt, materializationId: string): void {
  if (!isDeepStrictEqual(allocation.binding, binding) || !isDeepStrictEqual(allocation.attempt, attempt)
    || allocation.materializationId !== materializationId) {
    throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Secondary allocation belongs to another source preparation.')
  }
}

/** The root lock and positive writer closure are held by the caller. */
export async function reconcileSecondaryAllocation(root: FileHandle, binding: RootBinding,
  attempt: MaterializationAttempt, materializationId: string, signal: AbortSignal,
  childrenClosed: (path: string, signal: AbortSignal) => Promise<boolean>): Promise<void> {
  let parent: FileHandle
  try {
    parent = await openChildDirectory(root, materializationId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const allocation = await readSecondaryAllocation(parent, signal)
    if (!allocation) return
    assertSecondaryOwner(allocation, binding, attempt, materializationId)
    await childrenClosed(`${binding.canonicalPath}/${allocation.id}`, signal)
    let directory: FileHandle | undefined
    try {
      directory = await openChildDirectory(root, allocation.id)
      if (allocation.filesystem && !isDeepStrictEqual(await identity(directory), allocation.filesystem)) {
        throw new SourceError('SOURCE_TREE_CHANGED', 'Secondary allocation identity changed.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      await directory?.close()
    }
    if (allocation.kind === 'worktree') return
    const name = `working-tree-${binding.rootId}-${binding.bindingRevision}.json`
    const raw = await readCleanupRecord(root, `${name}.pending`, signal)
    if (!raw) return
    const pending = SecondarySourceAllocationSchema.parse(raw)
    assertSecondaryOwner(pending, binding, attempt, materializationId)
    if (pending.id !== allocation.id || pending.kind !== 'shared') {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Shared initialization belongs to another preparation.')
    }
    const completed = await readCleanupRecord(root, name, signal) as { id?: string; binding?: unknown } | null
    if (completed) {
      if (completed.id !== allocation.id || !isDeepStrictEqual(completed.binding, binding)) {
        throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Shared initialization changed before cleanup.')
      }
    } else {
      await removeSourceDirectory(root, allocation.id, { binding }, signal)
      await writeSecondaryAllocation(parent, { ...allocation, state: 'reclaimed' }, signal)
      await removeIncompleteCleanupRecord(root, `${name}.pending.ready`, signal)
    }
    await unlink(anchored(root, `${name}.pending`))
    await root.sync()
  } finally {
    await parent.close()
  }
}
