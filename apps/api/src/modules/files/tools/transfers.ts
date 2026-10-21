import { Writable, type Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'

/** No filesystem/path API: only a completed runner byte stream may become a snapshot.
 * This module has no runtime dependencies and is also tested directly with node:test. */
export class FileTransferError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FileTransferError' }
}
export async function completedBytes(source: Readable, maxBytes: number,
  signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid byte limit')
  const chunks: Buffer[] = []
  let size = 0
  const interrupted = () => new FileTransferError('FILE_WRITE_INTERRUPTED', 'The artifact write did not complete.')
  if (signal.aborted) { source.destroy(); throw interrupted() }
  // A synchronous sink copies on delivery, before an async producer can reuse a queued buffer.
  // Copying in a for-await consumer is too late when Readable has prefetched mutable chunks.
  const sink = new Writable({ objectMode: true, decodeStrings: false, write(chunk: unknown, _encoding, done) {
    if (!(chunk instanceof Uint8Array)) return done(new FileTransferError('FILE_WRITE_INVALID', 'Byte chunks are required.'))
    size += chunk.byteLength
    if (size > maxBytes) return done(new FileTransferError('FILE_TOO_LARGE', 'The artifact exceeds the permitted byte limit.'))
    chunks.push(Buffer.from(chunk))
    done()
  } })
  try {
    await pipeline(source, sink, { signal })
    if (signal.aborted || !source.readableEnded) throw interrupted()
    return Buffer.concat(chunks, size)
  } catch (error) {
    if (signal.aborted) throw interrupted()
    throw error
  } finally { source.destroy() }

}

/** The underlying FIL-03 download has already verified the entire immutable object.
 * Memory is bounded by length, not offset or total file size. */
export async function byteRange(source: Readable, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new RangeError('Invalid range')
  const chunks: Buffer[] = []
  let position = 0, size = 0
  try {
    for await (const chunk of source.iterator({ destroyOnReturn: false })) {
      if (!(chunk instanceof Uint8Array)) throw new FileTransferError('FILE_READ_INVALID', 'Byte chunks are required.')
      const start = Math.max(0, offset - position)
      const end = Math.min(chunk.byteLength, offset + length - position)
      if (end > start) { const part = Buffer.from(chunk.subarray(start, end)); chunks.push(part); size += part.length }
      position += chunk.byteLength
      if (position >= offset + length) break
    }
    return Buffer.concat(chunks, size)
  } finally {
    const closed = finished(source, { cleanup: true })
    source.destroy()
    await closed.catch((error: unknown) => {
      // An intentionally bounded read ends before EOF; original cleanup errors
      // still reject the read rather than allowing retained pins to escape.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
    })
  }
}
