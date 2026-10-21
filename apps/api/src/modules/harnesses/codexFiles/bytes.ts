import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { posix, win32 } from 'node:path'
import type { RegisteredCodexCopy } from './port.js'
import { reportOperationProgress } from '../../operationProgress.js'

export class CodexFileDeliveryError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'CodexFileDeliveryError'
  }
}
export function fail(code: string): never { throw new CodexFileDeliveryError(code) }
export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Own chunks synchronously at delivery, before a producer can reuse its buffer. */
export async function collectCodexFileBytes(stream: Readable, maximum: number,
  signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail('CODEX_FILE_SIZE_LIMIT')
  if (signal.aborted) { stream.destroy(); signal.throwIfAborted() }
  return new Promise<Buffer>((resolve, reject) => {
    let length = 0, settled = false
    const chunks: Buffer[] = []
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      stream.off('data', data); stream.off('end', end); stream.off('error', finish); stream.off('close', close)
      stream.destroy()
      if (error !== undefined) reject(error)
      else resolve(Buffer.concat(chunks, length))
    }
    const abort = () => finish(new CodexFileDeliveryError('CODEX_FILE_TRANSFER_ABORTED'))
    const close = () => finish(new CodexFileDeliveryError('CODEX_FILE_TRANSFER_INCOMPLETE'))
    const end = () => finish()
    const data = (chunk: unknown) => {
      try {
        if (!(chunk instanceof Uint8Array)) fail('CODEX_FILE_BYTES_REQUIRED')
        const bytes = chunk as Uint8Array
        length += bytes.byteLength
        if (length > maximum) fail('CODEX_FILE_SIZE_LIMIT')
        if (bytes.byteLength) {
          chunks.push(Buffer.from(bytes))
          reportOperationProgress(bytes.byteLength)
        }
      } catch (error) { finish(error) }
    }
    signal.addEventListener('abort', abort, { once: true })
    stream.once('end', end); stream.once('error', finish); stream.once('close', close)
    if (stream.destroyed || stream.readableEnded) { close(); return }
    stream.on('data', data)
    if (signal.aborted) abort()
  })
}

export function assertRegisteredCodexCopy(copy: RegisteredCodexCopy, expected: {
  executionHostId: string; pathStyle: 'posix' | 'win32'; writable: boolean; byteSize: number; sha256: string
}): void {
  const path = expected.pathStyle === 'posix' ? posix : win32
  if (!copy.registrationId || copy.registrationId.length > 500 || copy.executionHostId !== expected.executionHostId
    || copy.writable !== expected.writable || copy.byteSize !== expected.byteSize || copy.sha256 !== expected.sha256
    || !copy.executionPath || copy.executionPath.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(copy.executionPath)
    || !path.isAbsolute(copy.executionPath) || path.normalize(copy.executionPath) !== copy.executionPath) {
    fail('CODEX_FILE_HOST_RECEIPT_INVALID')
  }
}
