import { sourceWorkingTreePath } from './sourceTreePaths.js'
import { VerifiedSourceWorkingTreeSchema, type SourceMaterializationRecord, type VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import { sourceMaterializationDigest } from './bindingHash.js'
import { sourceSha256 } from './manifest.js'
import { DomainError } from '../errors.js'

/** Call only after SourceAdmission.verifyPreparation/verifyExecution returns the actual host path.
 * Native recovery is separately allocated/attested by HRT/W08 in a sibling
 * namespace. This never fabricates a recovery inode from a project identity.
 */
export function verifiedSourceWorkingTree(record: SourceMaterializationRecord, verifiedPath: string,
  privateGit: VerifiedSourceWorkingTree['privateGit'] = null): VerifiedSourceWorkingTree {
  const expected = sourceWorkingTreePath(record.receipt)
  if (verifiedPath !== expected) throw new DomainError('SOURCE_DIRECTORY_CONFLICT', 'Native execution must use the actual verified private source tree.', 409)
  return VerifiedSourceWorkingTreeSchema.parse({ materializationId: record.receipt.materializationId, materializationDigest: sourceMaterializationDigest(record),
    canonicalProjectRoot: verifiedPath, canonicalCwd: verifiedPath, filesystem: record.receipt.localTreeIdentity,
    directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(record.receipt.localTreeIdentity))), accessMode: record.receipt.binding.accessMode, privateGit })
}
