import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { WORKER_MCP_EXTENSION, decodeWorkerMcpRequest } from '@foreman-code/contracts/worker-mcp-relay'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors,
  type DeviceApplicationRequestOptions, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

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

function channels(server: DeviceExtensionRegistration) {
  const mainRaw = new Socket()
  const workerRaw = new Socket()
  mainRaw.peer = workerRaw
  workerRaw.peer = mainRaw
  const mainSocket = adaptDeviceSocket(mainRaw)
  const workerSocket = adaptDeviceSocket(workerRaw)
  const client: DeviceExtensionRegistration = { ...WORKER_MCP_EXTENSION, role: 'client' }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([server]), extensionDescriptors([client]))
  const stop = new AbortController()
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: stop.signal,
    extensions, registrations: [server], revalidate: async () => {} })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: stop.signal,
    extensions, registrations: [client] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 1000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
  for (const task of tasks) void task.catch(() => {
    // ignore: closing aborts readers; cleanup joins every task below.
  })
  cleanups.push(async () => {
    stop.abort()
    main.close()
    worker.close()
    await Promise.allSettled(tasks)
    await Promise.all([main.join(), worker.join()])
  })
  return worker
}

function referenceCall(byteSize: number) {
  const bytes = Buffer.alloc(byteSize, 97)
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reference_file_add', arguments: {
    scope: { kind: 'workspace_reference', workspaceId: 'workspace' },
    upload: { requestId: randomUUID(), filename: 'reference.pdf', mediaType: 'application/pdf',
      byteSize, sha256: createHash('sha256').update(bytes).digest('hex') }, contentBase64: bytes.toString('base64'),
  } } }
}

it('carries an advertised full-size reference through the bounded Worker channel request', async () => {
  const f = workerConversationFixture()
  const call = referenceCall(MAX_FILE_BYTES)
  let received: unknown
  const channel = channels({ ...WORKER_MCP_EXTENSION, role: 'server', handle: async (raw, context) => {
    const payload = decodeWorkerMcpRequest({ payload: raw, ...(context.bytes ? { bytes: context.bytes } : {}) }) as {
      operation: string; token: string; body?: unknown
    }
    expect(payload.token).toBe('operator-token')
    if (payload.operation === 'conversation-mcp.authorize') {
      return { payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() } }
    }
    received = payload.body
    return { payload: { statusCode: 200, contentType: 'application/json', body: '{"result":"stored"}' } }
  } })
  const relay = await prepareWorkerConversationMcp({ source: { method: 'conversation.status',
    binding: { ...f.binding, appMcpAccess: 'scoped' }, admissionId: randomUUID() },
  token: 'operator-token', signal: new AbortController().signal,
  request: async (namespace, raw, options: DeviceApplicationRequestOptions) => {
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxJsonBytes)
    expect(options.bytes?.byteLength ?? 0).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxBinaryBytes)
    return channel.request(namespace, raw, options)
  } })
  expect(await relay.request(call)).toMatchObject({ statusCode: 200, body: '{"result":"stored"}' })
  expect(received).toEqual(call)
})

it('accepts a reference larger than one MiB on the authenticated private HTTP endpoint', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-reference-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const call = referenceCall(1024 * 1024)
  let received: unknown
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(directory, 'launcher.mjs'),
    signal: new AbortController().signal, relay: {
      environment: { agentId: 'operator', variables: { FOREMAN_CODE_MCP_TOKEN: 'operator-token' } },
      expiresAt: new Date(Date.now() + 600_000).toISOString(), request: async body => {
        received = body
        return { statusCode: 200, contentType: 'application/json', body: '{"result":"stored"}' }
      },
    } })
  cleanups.unshift(() => endpoint.close())
  const response = await fetch(endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer operator-token' },
    body: JSON.stringify(call) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ result: 'stored' })
  expect(received).toEqual(call)
  expect((await fetch(endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer other' },
    body: JSON.stringify(call) })).status).toBe(401)
})

it('rejects malformed binary request carriers instead of forwarding partial or oversized bodies', () => {
  const metadata = { operation: 'conversation-mcp.request', bodyEncoding: 'utf8', bodyBytes: 2 }
  expect(() => decodeWorkerMcpRequest({ payload: metadata })).toThrow('missing')
  expect(() => decodeWorkerMcpRequest({ payload: metadata, bytes: Buffer.from('{') })).toThrow('length')
  expect(() => decodeWorkerMcpRequest({ payload: { ...metadata, bodyBytes: WORKER_MCP_EXTENSION.maxBinaryBytes + 1 },
    bytes: Buffer.from('{}') })).toThrow()
  expect(() => decodeWorkerMcpRequest({ payload: { ...metadata, operation: 'conversation-mcp.authorize' },
    bytes: Buffer.from('{}') })).toThrow()
  expect(() => decodeWorkerMcpRequest({ payload: metadata, bytes: Buffer.from([0xff, 0xff]) })).toThrow()
})
