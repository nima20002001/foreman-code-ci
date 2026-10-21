import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SOURCE_MANIFEST_MAX_BYTES, SourceSnapshotReferenceSchema, type SourceManifest, type SourceSnapshotReference }
  from '@foreman-code/contracts/source-materialization'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, verifySourceManifest } from './manifest.js'

export async function openSnapshotReference(input: SourceSnapshotReference, manifest: SourceManifest,
  signal?: AbortSignal): Promise<FileHandle> {
  signal?.throwIfAborted()
  const reference = SourceSnapshotReferenceSchema.parse(input)
  const root = await openPrivateRoot(reference.canonicalStorePath)
  try {
    if (!isDeepStrictEqual(await identity(root), reference.storeIdentity)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'Snapshot storage identity changed.')
    }
    const snapshot = await openChildDirectory(root, manifest.snapshotId)
    try {
      const file = await open(anchored(snapshot, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MANIFEST_MAX_BYTES) {
          throw new SourceError('SOURCE_MANIFEST_INVALID', 'Invalid snapshot manifest.')
        }
        if (!isDeepStrictEqual(verifySourceManifest(JSON.parse(await file.readFile('utf8'))), manifest)) {
          throw new SourceError('SOURCE_PIN_CONFLICT', 'Snapshot reference requires the approved manifest.')
        }
      } finally { await file.close() }
      signal?.throwIfAborted()
      return await openChildDirectory(snapshot, 'bytes')
    } finally { await snapshot.close() }
  } finally { await root.close() }
}
