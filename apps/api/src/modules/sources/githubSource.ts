import type { SourceEntry, SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourcePinSchema } from '@foreman-code/contracts/source-admission'
import type { SourceGitHubReferenceSchema } from '@foreman-code/contracts/source-operations'
import type { z } from 'zod'
import { captureGitSource } from './capture.js'
import { ensureCommit, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError, verifySourceBytes } from './manifest.js'
import type { SourceByteReader, SourceSnapshotPin } from './ports.js'

type Pin = z.infer<typeof SourcePinSchema>
type Reference = z.infer<typeof SourceGitHubReferenceSchema>

/** This computer fetches the approved commit from GitHub with its own login, then rebuilds the snapshot
 * and accepts it only when it is byte-for-byte Main's approved manifest. Main never sends source bytes. */
export async function openGitHubSource(ports: GitWorktreePorts, reference: Reference, pin: Pin,
  signal: AbortSignal): Promise<{ manifest: SourceManifest; reader: SourceByteReader }> {
  let clone: string
  try {
    clone = await ensureCommit(ports, reference.repository, reference.commit, signal)
  } catch (error) {
    signal.throwIfAborted()
    throw error
  }
  const files = new Map<string, Uint8Array>()
  let metadata: Uint8Array | undefined
  const manifest = await captureGitSource({ root: clone, approvedSourceId: pin.approvedSourceId, snapshotId: pin.snapshotId,
    commit: reference.commit, repository: reference.repository, executablePolicy: reference.executablePolicy,
    sink: {
      write: async (_snapshot, entry, bytes) => { signal.throwIfAborted(); files.set(entry.path, bytes) },
      writeGitMetadata: async (_snapshot, bytes) => { metadata = bytes },
      commit: async () => {}, abort: async () => {},
    } })
  if (manifest.manifestDigest !== pin.manifestDigest) {
    throw new SourceError('SOURCE_PIN_CONFLICT', 'The commit fetched from GitHub differs from the approved source.')
  }
  return { manifest, reader: {
    read: async (snapshot: SourceSnapshotPin, entry: SourceEntry, readSignal: AbortSignal) => {
      readSignal.throwIfAborted()
      const bytes = files.get(entry.path)
      if (snapshot.manifestDigest !== pin.manifestDigest || snapshot.snapshotId !== pin.snapshotId
        || snapshot.approvedSourceId !== pin.approvedSourceId || !bytes) throw new SourceError('SOURCE_PIN_CONFLICT', 'The entry is not part of the approved source.')
      verifySourceBytes(entry, bytes)
      return bytes
    },
    readGitMetadata: async (approved: SourceManifest, readSignal: AbortSignal) => {
      readSignal.throwIfAborted()
      if (approved.manifestDigest !== pin.manifestDigest || !metadata) {
        throw new SourceError('SOURCE_PIN_CONFLICT', 'Git metadata is not part of the approved source.')
      }
      return metadata
    },
  } }
}
