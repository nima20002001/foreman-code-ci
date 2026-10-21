import { z } from 'zod'
import { MAX_FILE_BYTES } from './files.js'
import type { DeviceApplicationResult } from './deviceApplication.js'

const ReferenceArgumentsSchema = z.object({ contentBase64: z.string() }).passthrough()
const ReferenceCallSchema = z.object({ method: z.literal('tools/call'), params: z.object({
  name: z.literal('reference_file_add'), arguments: ReferenceArgumentsSchema,
}).passthrough() }).passthrough()
const ReferenceMetadataSchema = ReferenceCallSchema.extend({ params: ReferenceCallSchema.shape.params.extend({
  arguments: ReferenceArgumentsSchema.omit({ contentBase64: true }).refine(args => !('contentBase64' in args)),
}) })
const ReferenceCarrierSchema = z.object({
  operation: z.enum(['worker-mcp.request', 'conversation-mcp.request']),
  bodyEncoding: z.literal('reference'), bodyBytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  body: ReferenceMetadataSchema,
}).passthrough()

function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  // Multiples of three keep padding confined to the final part.
  for (let offset = 0; offset < bytes.byteLength; offset += 24_576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))))
  }
  return parts.join('')
}

export function encodeWorkerMcpReference(input: Record<string, unknown>): DeviceApplicationResult | undefined {
  const parsed = ReferenceCallSchema.safeParse(input.body)
  if (!parsed.success) return undefined
  const body = parsed.data
  const { contentBase64, ...metadata } = body.params.arguments
  if (contentBase64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw new Error('MCP reference exceeds its byte limit')
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset)
  if (bytes.byteLength > MAX_FILE_BYTES || base64(bytes) !== contentBase64) {
    throw new Error('MCP reference content must be canonical base64 within its byte limit')
  }
  const payload = ReferenceCarrierSchema.parse({ ...input, bodyEncoding: 'reference', bodyBytes: bytes.byteLength,
    body: { ...body, params: { ...body.params, arguments: metadata } } })
  return { payload, bytes }
}

export function decodeWorkerMcpReference(result: DeviceApplicationResult): unknown {
  const metadata = ReferenceCarrierSchema.parse(result.payload)
  if (result.bytes === undefined || result.bytes.byteLength !== metadata.bodyBytes) {
    throw new Error('MCP binary request length differs from its metadata')
  }
  const { body } = metadata
  const payload: Record<string, unknown> = { ...metadata, body: { ...body, params: { ...body.params,
    arguments: { ...body.params.arguments, contentBase64: base64(result.bytes) } } } }
  delete payload.bodyEncoding
  delete payload.bodyBytes
  return payload
}
