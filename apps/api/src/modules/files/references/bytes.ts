import type { Readable } from 'node:stream'

/** Buffer's permissive decoder is NOT validation. A bounded round trip rejects whitespace,
 * URL-safe variants, missing padding, nonzero pad bits and ignored invalid characters. */
export function decodeReferenceBytes(contentBase64: string, byteSize: number, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maximumBytes
    || contentBase64.length !== 4 * Math.ceil(byteSize / 3)) {
    throw new RangeError('Base64 content does not match the declared byte size.')
  }
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.length !== byteSize || bytes.toString('base64') !== contentBase64) {
    throw new TypeError('Canonical padded base64 is required.')
  }
  return bytes
}

/** The caller validates the frozen range limit. Allocate only the requested range, not the file.
 * The input is an already verified storage descriptor, never an arbitrary host path. */
export async function readReferenceRange(source: Readable, offset: number, length: number, totalSize: number): Promise<Buffer> {
  try {
    if (![offset, length, totalSize].every(Number.isSafeInteger) || offset < 0 || length < 1
      || totalSize < 0 || offset > totalSize) throw new RangeError('The range is outside this revision.')
    const count = Math.min(length, totalSize - offset)
    const result = Buffer.alloc(count)
    if (count === 0) return result
    let position = 0, written = 0
    for await (const raw of source) {
      if (!(raw instanceof Uint8Array)) throw new TypeError('Expected a binary storage stream.')
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const start = Math.max(0, offset - position)
      const end = Math.min(chunk.length, offset + count - position)
      if (end > start) { chunk.copy(result, written, start, end); written += end - start }
      position += chunk.length
      if (written === count) break
    }
    if (written !== count) throw new Error('The verified revision ended before its requested range.')
    return result
  } finally { source.destroy() }
}
