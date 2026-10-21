import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DEVICE_JSON_CONTINUATION_BYTES, DEVICE_JSON_CONTINUATION_LIMIT, DeviceJsonContinuationSchema,
  type DeviceJsonContinuation, type DeviceJsonContinuationRequest } from '@foreman-code/contracts/device-application'
import { DomainError } from '../../errors.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type ContinuationOptions = { maxBytes?: number }
function continuationSchema(options: ContinuationOptions) {
  if (options.maxBytes === undefined) return DeviceJsonContinuationSchema
  return DeviceJsonContinuationSchema.extend({ byteSize: z.number().int().safe().positive().max(options.maxBytes) })
}

export function pageJsonContinuation(value: unknown, request?: DeviceJsonContinuationRequest,
  options: ContinuationOptions = {}): DeviceJsonContinuation {
  const bytes = Buffer.from(JSON.stringify(value))
  return pageJsonContinuationBytes(bytes, request, options)
}

export function pageJsonContinuationBytes(bytes: Uint8Array,
  request?: DeviceJsonContinuationRequest, options: ContinuationOptions = {}): DeviceJsonContinuation {
  return createJsonContinuationPager(bytes, options)(request)
}

/** Retains one response snapshot and hashes it once for all continuation pages. */
export function createJsonContinuationPager(bytes: Uint8Array, options: ContinuationOptions = {}) {
  const maxBytes = options.maxBytes ?? DEVICE_JSON_CONTINUATION_LIMIT
  if (bytes.byteLength > maxBytes) {
    throw new DomainError('payload-too-large', 'JSON continuation exceeds its size limit.', 413,
      { byteSize: bytes.byteLength, maxBytes })
  }
  const contentDigest = digest(bytes)
  const schema = continuationSchema(options)
  return (request?: DeviceJsonContinuationRequest): DeviceJsonContinuation => {
    const offset = request?.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) {
      throw new DomainError('conflict', 'JSON continuation offset is outside the reply.', 409,
        { offset, byteSize: bytes.byteLength })
    }
    if (request && request.digest !== contentDigest) {
      throw new DomainError('conflict', 'JSON continuation changed.', 409, { reason: 'digest_changed' })
    }
    return schema.parse({ digest: contentDigest, byteSize: bytes.byteLength,
      offset, data: Buffer.from(bytes.subarray(offset, offset + DEVICE_JSON_CONTINUATION_BYTES)).toString('base64') })
  }
}

export async function readJsonContinuation(first: DeviceJsonContinuation,
  read: (request: DeviceJsonContinuationRequest) => Promise<DeviceJsonContinuation>, signal?: AbortSignal,
  options: ContinuationOptions = {}): Promise<unknown> {
  const schema = continuationSchema(options)
  const original = schema.parse(first)
  const parts: Buffer[] = []
  let offset = 0
  let chunk = original
  while (true) {
    signal?.throwIfAborted()
    if (chunk.digest !== original.digest || chunk.byteSize !== original.byteSize || chunk.offset !== offset
      || chunk.downloadId !== original.downloadId)
      throw new Error('JSON continuation identity changed')
    const bytes = Buffer.from(chunk.data, 'base64')
    if (!bytes.byteLength || bytes.byteLength > DEVICE_JSON_CONTINUATION_BYTES
      || bytes.toString('base64') !== chunk.data || offset + bytes.byteLength > original.byteSize)
      throw new Error('Invalid JSON continuation bytes')
    parts.push(bytes)
    offset += bytes.byteLength
    if (offset === original.byteSize) break
    chunk = schema.parse(await read({ digest: original.digest, offset,
      ...(original.downloadId === undefined ? {} : { downloadId: original.downloadId }) }))
  }
  const bytes = Buffer.concat(parts)
  if (digest(bytes) !== original.digest) throw new Error('JSON continuation digest changed')
  return JSON.parse(bytes.toString('utf8')) as unknown
}
