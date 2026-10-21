import { closeSync, constants, fchmodSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { SOURCE_ENTRY_LIMIT, type SourceEntry } from '@foreman-code/contracts/source-materialization'
import { anchored } from './privateFilesystem.js'
import { flushSourceTree } from './sourceTreeFlush.js'
import { syncSourceTree } from './sourceTreeSync.js'

export interface SourceFileWriter {
  write(parent: FileHandle, entry: SourceEntry, bytes: Uint8Array): Promise<void>
  finish(): Promise<void>
  close(): void
}

/** Original write descriptors remain open until their data wait or full fsync completes. */
export async function sourceFileWriter(tree: FileHandle, fileMode: 0o400 | 0o600,
  signal: AbortSignal): Promise<SourceFileWriter> {
  const batchData = await flushSourceTree(tree, signal, { mode: 'qualify' })
  const pending: number[] = []
  let flushing: Promise<void> | undefined
  const flush = async () => {
    const files = pending.splice(0)
    if (!files.length) return
    try {
      if (!await flushSourceTree(tree, signal, { mode: 'data', files })) {
        for (const file of files) fsyncSync(file)
      }
    } finally {
      for (const file of files) closeSync(file)
    }
  }
  return {
    async write(parent, entry, bytes) {
      if (flushing) await flushing
      signal.throwIfAborted()
      const mode = fileMode | (entry.executable ? 0o100 : 0)
      const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      const file = openSync(anchored(parent, leaf),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
      let queued = false
      try {
        writeFileSync(file, bytes)
        if (process.umask() & mode) fchmodSync(file, mode)
        if (batchData) {
          pending.push(file)
          queued = true
        } else {
          fsyncSync(file)
        }
      } finally {
        if (!queued) closeSync(file)
      }
      if (pending.length >= SOURCE_ENTRY_LIMIT) {
        flushing = flush()
        await flushing
        flushing = undefined
      }
    },
    async finish() {
      if (flushing) await flushing
      await flush()
      // Git creates this auxiliary file before our original source write descriptors exist.
      let gitFile: number | undefined
      try {
        gitFile = openSync(anchored(tree, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (gitFile !== undefined) {
        try { fsyncSync(gitFile) } finally { closeSync(gitFile) }
      }
      if (!await flushSourceTree(tree, signal, { mode: 'metadata' })) {
        await syncSourceTree(tree, signal)
      }
    },
    close() {
      for (const file of pending.splice(0)) closeSync(file)
    },
  }
}
