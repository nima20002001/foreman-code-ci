import { join } from 'node:path'
import { sourceMaterializationComponents, sourceMaterializationParent, type MaterializationReceipt } from '@foreman-code/contracts/source-materialization'

export function sourceWorkingTreeId(receipt: MaterializationReceipt): string {
  return receipt.sharedTree?.id ?? receipt.retainedTree?.materializationId ?? receipt.materializationId
}

/** Shared workflow trees sit beside their claims; quota trees stay in their Job namespace. */
export function sourceWorkingTreePath(receipt: MaterializationReceipt): string {
  return receipt.sharedTree || receipt.retainedTree ? join(receipt.binding.canonicalPath, sourceWorkingTreeId(receipt), 'tree')
    : join(sourceMaterializationParent(receipt), 'tree')
}

/** Directory components below the root binding that hold the working tree. */
export function sourceWorkingTreeComponents(receipt: MaterializationReceipt): string[] {
  return receipt.sharedTree || receipt.retainedTree ? [sourceWorkingTreeId(receipt)] : sourceMaterializationComponents(receipt)
}
