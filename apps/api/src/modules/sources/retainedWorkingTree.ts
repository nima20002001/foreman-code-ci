import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, SourceMaterializationFileSchema,
  type MaterializationReceipt, type RootBinding } from '@foreman-code/contracts/source-materialization'
import { anchored, identity, openChildDirectory } from './privateFilesystem.js'
import { sourceWorkingTreeComponents } from './sourceTreePaths.js'
import { verifySharedWorkingTree } from './sharedWorkingTree.js'
import { verifyWorktreeBranch } from './worktreeRequest.js'
import type { GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'
import { verifyMaterializedSourceTree } from './materializationClaim.js'

async function storedMaterialization(root: FileHandle, materializationId: string) {
  const directory = await openChildDirectory(root, materializationId)
  try {
    const file = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) {
        throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid retained source receipt.')
      }
      const record = SourceMaterializationFileSchema.parse(JSON.parse(await file.readFile('utf8')))
      if (record.receipt.materializationId !== materializationId) {
        throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Retained source metadata belongs to another materialization.')
      }
      return record
    } finally { await file.close() }
  } finally { await directory.close() }
}

/** Each turn owns a fresh receipt; only the original, verified working directory is shared. */
export async function verifyRetainedWorkingTree(root: FileHandle, receipt: MaterializationReceipt,
  binding: RootBinding, git: GitWorktreePorts, signal?: AbortSignal): Promise<MaterializationReceipt> {
  const stored = await storedMaterialization(root, receipt.materializationId)
  const original = receipt.retainedTree
    ? await storedMaterialization(root, receipt.retainedTree.materializationId) : stored
  const origin = original.receipt
  if (receipt.quota || origin.quota || origin.retainedTree || !isDeepStrictEqual(stored.receipt, receipt)
    || !isDeepStrictEqual(origin.binding, binding) || !isDeepStrictEqual(receipt.binding, binding)
    || receipt.retainedTree && origin.executionId !== receipt.retainedTree.executionId
    || !isDeepStrictEqual(origin.localTreeIdentity, receipt.localTreeIdentity)
    || (receipt.retainedTree ? origin.sharedTree?.id ?? origin.materializationId : origin.sharedTree?.id)
      !== receipt.sharedTree?.id || !isDeepStrictEqual(origin.worktree, receipt.worktree)) {
    throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Retained working files differ from their original source owner.')
  }
  let directory = await openChildDirectory(root, sourceWorkingTreeComponents(origin)[0]!)
  try {
    const tree = await openChildDirectory(directory, 'tree')
    await directory.close()
    directory = tree
    if (!isDeepStrictEqual(await identity(directory), origin.localTreeIdentity)) {
      throw new SourceError('SOURCE_TREE_CHANGED', 'The retained working directory was replaced.')
    }
    if (!origin.sharedTree) await verifyMaterializedSourceTree(directory, original.manifest, signal)
    await verifySharedWorkingTree(root, origin)
    await verifyWorktreeBranch(origin, { git, signal })
    return origin
  } finally { await directory.close() }
}
