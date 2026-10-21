import { expect, it } from 'vitest'
import { MAX_FILE_BYTES } from './files.js'
import { decodeWorkerMcpRequest, encodeWorkerMcpRequest } from './workerMcpRelay.js'
import { encodeWorkerMcpReference } from './workerMcpReference.js'

function referenceRequest(bytes: Uint8Array) {
  return { operation: 'conversation-mcp.request', token: 'scoped-token', body: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reference_file_add', arguments: {
      scope: { kind: 'workspace_reference', workspaceId: 'workspace' },
      upload: { byteSize: bytes.byteLength, filename: 'reference.bin' },
      contentBase64: Buffer.from(bytes).toString('base64'),
    } },
  } }
}

it('transfers reference content as raw bytes and restores the original MCP request', () => {
  const bytes = Buffer.alloc(25 * 1024 + 1)
  for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 256
  const request = referenceRequest(bytes)
  const carrier = encodeWorkerMcpReference(request)!
  expect(carrier.bytes?.byteLength).toBe(bytes.byteLength)
  expect(Buffer.compare(Buffer.from(carrier.bytes!), bytes)).toBe(0)
  expect(JSON.stringify(carrier.payload).length).toBeLessThan(1024)
  expect(decodeWorkerMcpRequest(carrier)).toEqual(request)
})

it('selects the raw reference carrier when the request exceeds the JSON carrier limit', () => {
  const bytes = Buffer.alloc(800 * 1024, 7)
  const request = referenceRequest(bytes)
  const carrier = encodeWorkerMcpRequest(request)
  expect(carrier.payload).toMatchObject({ bodyEncoding: 'reference' })
  expect(carrier.bytes?.byteLength).toBe(bytes.byteLength)
  expect(decodeWorkerMcpRequest(carrier)).toEqual(request)
})

it('accepts the advertised reference size bound and rejects one byte above it', () => {
  const payload = { operation: 'conversation-mcp.request', bodyEncoding: 'reference', bodyBytes: MAX_FILE_BYTES,
    body: { method: 'tools/call', params: { name: 'reference_file_add', arguments: {} } } }
  const bytes = new Uint8Array()
  // At the limit, metadata passes validation and decoding reaches the missing-content check.
  expect(() => decodeWorkerMcpRequest({ payload, bytes }))
    .toThrow('MCP binary request length differs from its metadata')
  expect(() => decodeWorkerMcpRequest({ payload: { ...payload, bodyBytes: MAX_FILE_BYTES + 1 }, bytes }))
    .toThrow(expect.objectContaining({ issues: [expect.objectContaining({
      code: 'too_big', path: ['bodyBytes'], maximum: MAX_FILE_BYTES,
    })] }))
})

it('rejects incomplete reference binary carriers', () => {
  const request = referenceRequest(Buffer.alloc(257))
  const carrier = encodeWorkerMcpReference(request)!
  expect(() => decodeWorkerMcpRequest({ payload: carrier.payload })).toThrow('missing')
  expect(() => decodeWorkerMcpRequest({ payload: carrier.payload, bytes: carrier.bytes!.subarray(1) }))
    .toThrow('length')
})

it('keeps unrelated binary MCP bodies intact', () => {
  const request = { operation: 'worker-mcp.request', applicationAccess: { token: 'scoped-token' },
    body: { method: 'tools/call', params: { name: 'other_tool', arguments: { text: 'x'.repeat(2 * 1024 * 1024) } } } }
  expect(decodeWorkerMcpRequest(encodeWorkerMcpRequest(request))).toEqual(request)
})
