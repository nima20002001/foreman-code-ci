import { sourceWorkingTreeComponents, sourceWorkingTreePath } from './sourceTreePaths.js'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer } from './materialization.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, sourcePath, sourceSha256 } from './manifest.js'
import { verifiedSourceWorkingTree } from './nativeStamp.js'
import { SourceActiveNativeSessionSchema, type SourceActiveNativeSession } from '@foreman-code/contracts/source-operations'
import type { SourceNativeSessionCapture } from './ports.js'
import { verifyWorktreeBranch } from './worktreeRequest.js'

export async function assertSourceNativeSession(record: SourceMaterializationRecord, capture: SourceNativeSessionCapture): Promise<void> {
  capture.signal.throwIfAborted()
  await capture.assertCurrent()
  const proof = SourceActiveNativeSessionSchema.parse(capture.proof), receipt = record.receipt
  if (receipt.binding.accessMode !== 'exclusive-write' || !record.finalDispatchBindingHash
    || proof.executionId !== receipt.executionId || proof.attemptId !== receipt.attemptId || proof.operationId !== record.operationId
    || proof.materializationId !== receipt.materializationId || proof.sourceBindingHash !== receipt.placementHash
    || proof.sourceBindingHash !== record.sourceBindingHash || proof.finalDispatchBindingHash !== record.finalDispatchBindingHash
    || proof.cwdAttestation.materializationId !== receipt.materializationId || proof.cwdAttestation.executionId !== receipt.executionId
    || proof.cwdAttestation.attemptId !== receipt.attemptId || proof.cwdAttestation.operationId !== record.operationId
    || proof.cwdAttestation.sourceBindingHash !== record.sourceBindingHash || proof.cwdAttestation.accessMode !== receipt.binding.accessMode
    || Date.parse(proof.lane.expiresAt) <= Date.now())
    throw new SourceError('SOURCE_NATIVE_SESSION_CONFLICT', 'The current original entered native owner does not match this writable source attempt.')
  capture.signal.throwIfAborted()
}

/** A heartbeat extends the same writer lease; it cannot replace its owner or token. */
export function sourceNativeSessionContinues(
  previous: SourceActiveNativeSession | null | undefined,
  current: SourceActiveNativeSession | null | undefined,
): boolean {
  if (!previous || !current) return previous === current
  if (current.lane.revision < previous.lane.revision
    || Date.parse(current.lane.expiresAt) < Date.parse(previous.lane.expiresAt)) return false
  return isDeepStrictEqual(previous, {
    ...current,
    lane: { ...current.lane, revision: previous.lane.revision, expiresAt: previous.lane.expiresAt },
  })
}

export function sourceCwdAttestationDigest(proof: Record<string, unknown>): string {
  const { attestationDigest: _digest, ...fields } = proof
  void _digest
  return commandInputHash(fields).slice('sha256:'.length)
}
/** Before allocation reverify exact bytes. A current entered writable lifetime
 * instead retains the original root/tree/CWD identities through opened FDs. */
export async function verifyMaterializedWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string,
  authorize: () => Promise<void>, capture?: SourceNativeSessionCapture): Promise<VerifiedSourceWorkingTree> {
  if (relativeCwd.length > 1024) throw new SourceError('SOURCE_PATH_INVALID', 'Working directory exceeds its bound.')
  if (relativeCwd) sourcePath(relativeCwd)
  const receipt = record.receipt
  const materializer = new PrivateSourceMaterializer(null, authorize)
  if (capture) { await assertSourceNativeSession(record, capture); await authorize(); await assertSourceNativeSession(record, capture) }
  const canonicalProjectRoot = capture ? sourceWorkingTreePath(receipt)
    : await materializer.resolve(receipt, { binding: receipt.binding, attempt: { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision } })
  let directory = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (!isDeepStrictEqual(await identity(directory), receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Approved source root changed.')
    for (const component of [...sourceWorkingTreeComponents(receipt), 'tree']) {
      const child = await openChildDirectory(directory, component)
      await directory.close(); directory = child
    }
    if (!isDeepStrictEqual(await identity(directory), receipt.localTreeIdentity)) throw new SourceError('SOURCE_TREE_CHANGED', 'Verified source tree identity changed.')
    if (capture) await verifyWorktreeBranch(receipt, { signal: capture.signal })
    for (const component of relativeCwd ? relativeCwd.split('/') : []) {
      const child = await openChildDirectory(directory, component)
      await directory.close(); directory = child
    }
    const accessFlags = constants.R_OK | constants.X_OK | (receipt.binding.accessMode === 'exclusive-write' ? constants.W_OK : 0)
    await access(anchored(directory), accessFlags)
    const filesystem = await identity(directory), canonicalCwd = join(canonicalProjectRoot, relativeCwd)
    if (capture && relativeCwd && (capture.proof.cwdAttestation.relativeCwd !== relativeCwd
      || capture.proof.cwdAttestation.canonicalCwd !== canonicalCwd || !isDeepStrictEqual(capture.proof.cwdAttestation.filesystem, filesystem)))
      throw new SourceError('SOURCE_CWD_CHANGED', 'Working directory differs from the original entered native directory.')
    const directoryIdentityHash = sourceSha256(Buffer.from(JSON.stringify(filesystem)))
    const fields = { version: 1 as const, materializationId: receipt.materializationId, executionId: receipt.executionId,
      attemptId: receipt.attemptId, operationId: record.operationId, sourceBindingHash: receipt.placementHash,
      relativeCwd, canonicalCwd, filesystem, directoryIdentityHash, accessMode: receipt.binding.accessMode }
    await authorize()
    if (capture) await assertSourceNativeSession(record, capture)
    // Detect replacement during authorization while retaining the original FD.
    let current = await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      if (!isDeepStrictEqual(await identity(current), receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Approved source root changed during verification.')
      for (const [index, component] of [...sourceWorkingTreeComponents(receipt), 'tree', ...(relativeCwd ? relativeCwd.split('/') : [])].entries()) {
        const child = await openChildDirectory(current, component); await current.close(); current = child
        if (index === sourceWorkingTreeComponents(receipt).length && !isDeepStrictEqual(await identity(current), receipt.localTreeIdentity))
          throw new SourceError('SOURCE_TREE_CHANGED', 'Verified source tree identity changed during verification.')
      }
      await access(anchored(current), accessFlags)
      if (!isDeepStrictEqual(await identity(current), filesystem)) throw new SourceError('SOURCE_CWD_CHANGED', 'Working directory changed during verification.')
    } finally { await current.close() }
    if (capture) await assertSourceNativeSession(record, capture)
    return { ...verifiedSourceWorkingTree(record, canonicalProjectRoot), canonicalCwd, directoryIdentityHash,
      cwdAttestation: { ...fields, attestationDigest: sourceCwdAttestationDigest(fields) } }
  } finally { await directory.close() }
}
