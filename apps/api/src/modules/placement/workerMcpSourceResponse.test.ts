import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { negotiateDeviceExtensions, parseExtensionDescriptors } from '@foreman-code/contracts/device-application'
import { SOURCE_MANIFEST_MAX_BYTES, SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from '@foreman-code/contracts/source-materialization'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { WORKER_MCP_EXTENSION, encodeWorkerMcpResult, decodeWorkerMcpResult } from '@foreman-code/contracts/worker-mcp-relay'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { createSourceManifest } from '../sources/manifest.js'
import { nearLimitManifest } from '../../../test/helpers/sourceManifest.js'
import { selectedMainMcpForward } from './workerMcpRelay.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

function channelPair(server: DeviceExtensionRegistration) {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const client: DeviceExtensionRegistration = { ...WORKER_MCP_EXTENSION, role: 'client' }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([server]), extensionDescriptors([client]))
  const stop = new AbortController()
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: stop.signal,
    extensions, registrations: [server], revalidate: async () => {} })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: stop.signal,
    extensions, registrations: [client] })
  const running = [main.run(mainSocket.messages[Symbol.asyncIterator](), 1000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
  for (const task of running) void task.catch(() => {
    // ignore: closing the fixture aborts the reader tasks; close joins their outcomes below.
  })
  return { worker, async close() {
    stop.abort()
    main.close()
    worker.close()
    await Promise.allSettled(running)
    await Promise.all([main.join(), worker.join()])
  } }
}

it.each(['source_get', 'source_approve'])('relays %s with a supported near-limit manifest over the negotiated carrier', async name => {
  const manifest = nearLimitManifest()
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(SOURCE_MANIFEST_MAX_BYTES - 128)
  const source = ApprovedSourceSchema.parse({ version: 1, workspaceId: 'workspace', ownerPrincipalId: 'owner',
    approvedByPrincipalId: 'owner', locationRevision: 1, mainId: randomUUID(),
    originIdentityHash: `sha256:${'a'.repeat(64)}`, manifest,
    approvedAt: new Date().toISOString(), availability: 'retained' })
  const value = name === 'source_get' ? source : { value: source, replayed: false }
  // Operator presentation keeps large reads structured and approvals as a single JSON text item.
  const result = name === 'source_get' ? { content: [], structuredContent: value }
    : { content: [{ type: 'text', text: JSON.stringify(value) }] }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result })
  const app = Fastify()
  app.post('/mcp', (request, reply) => {
    if (request.headers.authorization !== 'Bearer source-test-token') return reply.code(401).send({ error: 'denied' })
    return reply.type('application/json').send(body)
  })
  let channels: ReturnType<typeof channelPair> | undefined
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const forward = selectedMainMcpForward(app)
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }
    const response = await forward.request(call, 'source-test-token')
    const carrier = encodeWorkerMcpResult(response)
    expect(carrier.bytes?.byteLength).toBe(Buffer.byteLength(body))
    expect(decodeWorkerMcpResult(carrier)).toEqual(response)
    channels = channelPair({ ...WORKER_MCP_EXTENSION, role: 'server',
      handle: async (payload, context) => encodeWorkerMcpResult(
        await forward.request(payload, 'source-test-token', undefined, context.signal)) })
    const received = decodeWorkerMcpResult(await channels.worker.request(WORKER_MCP_EXTENSION.namespace, call))
    expect(received).toEqual({ statusCode: 200, contentType: 'application/json', body })
    expect((await forward.request(call, 'foreign-token')).statusCode).toBe(401)
  } finally {
    await channels?.close()
    await app.close()
  }
})

it('fits approval text escaping and rejects responses beyond the bounded manifest relay budget', async () => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: Array.from({ length: 4096 }, (_, index) => ({ path: `src/${String(index).padStart(4, '0')}/${'"'.repeat(160)}.ts`,
      kind: 'file', byteSize: 0, sha256: 'a'.repeat(64), executable: false })) })
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify({ value: { manifest }, replayed: false }) }] } })
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(SOURCE_MANIFEST_MAX_BYTES)
  expect(Buffer.byteLength(body)).toBeGreaterThan(SOURCE_MANIFEST_MAX_BYTES)
  const response = { statusCode: 200, contentType: 'application/json' as const, body }
  expect(decodeWorkerMcpResult(encodeWorkerMcpResult(response))).toEqual(response)
  const limit = 2 * SOURCE_MATERIALIZATION_RECORD_MAX_BYTES
  expect(() => encodeWorkerMcpResult({ ...response, body: 'x'.repeat(limit + 1) })).toThrow()
  expect(() => encodeWorkerMcpResult({ ...response, body: '界'.repeat(Math.floor(limit / 3) + 1) })).toThrow()
  const app = Fastify()
  app.post('/mcp', (_request, reply) => reply.type('application/json').send('x'.repeat(limit + 1)))
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    await expect(selectedMainMcpForward(app).request({}, 'source-test-token'))
      .rejects.toMatchObject({ code: 'WORKER_MCP_RESPONSE_INVALID' })
  } finally { await app.close() }
})

it('keeps the larger binary allowance confined to the MCP namespace', () => {
  const maxBinaryBytes = 4 * Math.ceil(MAX_FILE_BYTES / 3) + 64 * 1024
  expect(WORKER_MCP_EXTENSION.maxBinaryBytes).toBe(maxBinaryBytes)
  expect(parseExtensionDescriptors([{ ...WORKER_MCP_EXTENSION, maxBinaryBytes, role: 'client' }]))
    .toMatchObject([{ maxBinaryBytes }])
  expect(() => parseExtensionDescriptors([{ ...WORKER_MCP_EXTENSION,
    namespace: 'other-extension', maxBinaryBytes, role: 'client' }])).toThrow('Invalid device extension')
  expect(() => parseExtensionDescriptors([{ ...WORKER_MCP_EXTENSION,
    maxBinaryBytes: maxBinaryBytes + 1, role: 'client' }])).toThrow('Invalid device extension')
})
