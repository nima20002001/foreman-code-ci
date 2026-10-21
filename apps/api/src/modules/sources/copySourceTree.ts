import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { scheduler } from 'node:timers/promises'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { processSourceDirectories } from './entryProcessing.js'
import { anchored } from './privateFilesystem.js'
import { withSourceDirectoryParents } from './directoryParents.js'
import { SourceError, verifySourceBytes } from './manifest.js'
import { sourceFileWriter } from './sourceFileWriter.js'
import { componentLogger } from '../diagnostics/logger.js'

/** Copies raw files without Git filters, shared writable inodes or per-file thread-pool queues. */
export async function copySourceTree(input: {
  source: FileHandle
  target: FileHandle
  manifest: SourceManifest
  fileMode: 0o400 | 0o600
  signal: AbortSignal
}): Promise<void> {
  const { source, target, manifest, signal } = input
  const started = performance.now()
  const writer = await sourceFileWriter(target, input.fileMode, signal)
  try {
    await withSourceDirectoryParents(target, true, async destinationParent => {
      await processSourceDirectories(source, manifest.entries, async (parent, entries) => {
        const destination = await destinationParent(entries[0]!.path)
        try {
          for (const entry of entries) {
            signal.throwIfAborted()
            const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
            const original = openSync(anchored(parent, leaf),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME)
            let bytes: Buffer
            try {
              const stat = fstatSync(original)
              if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize) {
                throw new SourceError('SOURCE_BYTES_INVALID', 'Source kind, size or link count changed.')
              }
              bytes = readFileSync(original)
              verifySourceBytes(entry, bytes)
              await writer.write(destination, entry, bytes)
            } finally { closeSync(original) }
            // Bound event-loop work to one manifest-limited file, including cancellation delivery.
            await scheduler.yield()
          }
        } finally { await destination.close() }
      }, { signal })
    })
    const copied = performance.now()
    await writer.finish()
    componentLogger('engine').debug({ snapshotId: manifest.snapshotId,
      copyMs: Math.round(copied - started), flushMs: Math.round(performance.now() - copied) }, 'source tree copied')
  } finally { writer.close() }
}
