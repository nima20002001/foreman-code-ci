import { ResumableByteTransferService, TransferExpiredError } from './service.js'
import { EventEmitter } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { TransferContextSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { authenticatedTransferAuthority, BYTE_TRANSFER_NAMESPACE, createAuthenticatedTransferReceiver,
  createChannelTransferClient, transferContextForBinding } from './carrier.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: string[] = []
  send(text: string) { this.frames.push(text); queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) }) }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer?.close() }
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
async function stagingRoot() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'byte-carrier-'))
  roots.push(root)
  return root
}
function binding(): DeviceSessionBinding {
  return { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 77 }
}
function intentFor(bound: DeviceSessionBinding, bytes: Uint8Array): TransferIntent {
  return { ...transferContextForBinding(bound), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-main', byteClass: 'source', sha256: hash(bytes), byteSize: bytes.byteLength,
    manifestDigest: hash(bytes), chunkBytes: 8192, expiresAt: new Date(Date.now() + 60_000).toISOString() }
}
function pair(bound: DeviceSessionBinding, server: DeviceExtensionRegistration) {
  const rawMain = new Socket(), rawWorker = new Socket(); rawMain.peer = rawWorker; rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain), workerSocket = adaptDeviceSocket(rawWorker), stop = new AbortController()
  const client: DeviceExtensionRegistration = { ...server, role: 'client' }; delete client.handle
  const extensions = negotiateDeviceExtensions(extensionDescriptors([server]), extensionDescriptors([client]))
  const main = new DeviceApplicationChannel({ side: 'main', binding: bound, socket: mainSocket, signal: stop.signal, extensions, registrations: [server], revalidate: async () => {} })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: bound, socket: workerSocket, signal: stop.signal, extensions, registrations: [client] })
  const runs = Promise.allSettled([
    main.run(mainSocket.messages[Symbol.asyncIterator](), 1000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000),
  ])
  return { worker, rawWorker, async close() {
    stop.abort()
    main.close()
    worker.close()
    await Promise.all([main.join(), worker.join()])
    await expect(runs).resolves.toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'transport' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'transport' }) },
    ])
  } }
}
it('retains the actual UUID epoch and rejects numeric generation substitution', () => {
  const actual = binding(), context = transferContextForBinding(actual)
  expect(context.connectionEpoch).toBe(actual.connectionEpoch)
  expect(context.bootId).toBe(actual.bootId)
  expect(context).not.toHaveProperty('connectionGeneration')
  expect(TransferContextSchema.safeParse({ ...context, connectionEpoch: actual.connectionGeneration }).success).toBe(false)
})
it('fences a replaced UUID session even when numeric generation is unchanged', async () => {
  let actual = binding(); const original = actual, intent = intentFor(actual, Buffer.from('data'))
  const authority = authenticatedTransferAuthority(() => actual, { authorize: async () => { actual = { ...actual, connectionEpoch: randomUUID() } } })
  await expect(authority.authorize(intent, transferContextForBinding(original), 'append')).rejects.toThrow('changed during authorization')
  expect(actual.connectionGeneration).toBe(original.connectionGeneration)
  await expect(authority.authorize(intent, transferContextForBinding(original), 'status')).rejects.toThrow('differs')
})
it.each([0, 1_100])('moves immutable source-package bytes over the existing binary carrier and verifies server-derived receipt after %i ms of delayed work', async delayMs => {
  const bytes = Buffer.alloc(20_000, 7), original = binding(), intent = intentFor(original, bytes)
  let current = original, granted = true
  const root = await stagingRoot()
  const receiver = createAuthenticatedTransferReceiver({ stagingRoot: root, current: () => current, accepted: {
    intent: async id => { if (id !== intent.transferId) throw new Error('Unknown accepted intent'); return intent },
    authorize: async accepted => { if (!granted || !isDeepStrictEqual(accepted, intent)) throw new Error('Denied original operation grant') },
  } })
  // Carrier assertions control transport time; filesystem latency must not expire the heartbeat.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const channels = pair(original, receiver.extension), client = createChannelTransferClient(channels.worker)
  try {
    const receipt = await client.sender({ read: async (_, offset, length) => bytes.subarray(offset, offset + length) }).send(intent)
    const context = transferContextForBinding(original)
    expect(await receiver.receiver.resolveVerifiedReceipt(intent.transferId, context)).toEqual(receipt)
    const stream = await receiver.receiver.openVerified(receipt, context), received: Buffer[] = []
    for await (const chunk of stream) received.push(chunk)
    expect(Buffer.concat(received)).toEqual(bytes)
    expect(channels.rawWorker.frames.every(frame => Buffer.byteLength(frame) <= 16384)).toBe(true)
    await expect(receiver.receiver.openVerified({ ...receipt, receiptId: randomUUID() }, context)).rejects.toThrow('Unrecognized')
    await expect(channels.worker.request(BYTE_TRANSFER_NAMESPACE, { method: 'status', transferId: intent.transferId, context })).rejects.toThrow()
    granted = false
    await expect(client.receiver.status(intent.transferId, context)).rejects.toThrow()
    granted = true; current = { ...original, connectionEpoch: randomUUID(), bootId: randomUUID() }
    await expect(client.receiver.status(intent.transferId, context)).rejects.toThrow()
    expect((await receiver.receiver.status(intent.transferId, transferContextForBinding(current))).durableOffset).toBe(bytes.length)
    const saved = JSON.parse(await readFile(join(root, `${intent.transferId}.json`), 'utf8'))
    expect(saved.payload.intent.connectionEpoch).toBe(original.connectionEpoch)
    expect(saved.payload.receipt.intent.connectionEpoch).toBe(original.connectionEpoch)
    await wait(delayMs)
  } finally { await channels.close(); await receiver.receiver.close() }
})
it('rejects an old captured sender context before dispatching through a replacement channel', async () => {
  const original = binding(), root = await stagingRoot()
  const bytes = Buffer.from('data'), intent = intentFor(original, bytes), receiver = createAuthenticatedTransferReceiver({ stagingRoot: root,
    current: () => original, accepted: { intent: async () => intent, authorize: async () => {} } })
  const channels = pair(original, receiver.extension)
  try {
    const client = createChannelTransferClient(channels.worker)
    await expect(client.receiver.start(intent, { ...transferContextForBinding(original), connectionEpoch: randomUUID() })).rejects.toThrow('transport')
    expect(channels.rawWorker.frames.filter(frame => String(JSON.parse(frame).type).startsWith('application-'))).toHaveLength(0)
  } finally { await channels.close(); await receiver.receiver.close() }
})

it('shares the supplied original canonical journal with fallback and preserves its accepted/current fences', async () => {
  const root = await stagingRoot()
  const original = binding(), bytes = Buffer.from('data'), intent = intentFor(original, bytes)
  let bound = original, denied = false
  const accepted = { intent: async () => intent, authorize: async () => { if (denied) throw new Error('Denied original grant') } }
  const canonical = new ResumableByteTransferService(root, accepted)
  const carrier = createAuthenticatedTransferReceiver({ stagingRoot: root, current: () => bound, accepted, receiver: canonical })
  try {
    expect(carrier.receiver).toBe(canonical)
    const context = transferContextForBinding(original), frame = { binding: original, signal: new AbortController().signal }
    await canonical.reserve(intent, context, { kind: 'rsync-receiver', byteSize: intent.byteSize * 3 })
    await carrier.handle({ method: 'start', transferId: intent.transferId }, frame)
    await carrier.handle({ method: 'append', transferId: intent.transferId, offset: 0, sha256: hash(bytes), byteLength: bytes.length }, { ...frame, bytes })
    const receipt = (await carrier.handle({ method: 'finish', transferId: intent.transferId }, frame)).payload
    expect(await canonical.resolveVerifiedReceipt(intent.transferId, context)).toEqual(receipt)
    const journal = JSON.parse(await readFile(join(root, `${intent.transferId}.json`), 'utf8'))
    expect(journal.payload).toMatchObject({ canonical: true, external: { 'rsync-receiver': { byteSize: bytes.length * 3, released: false } } })
    denied = true
    await expect(carrier.handle({ method: 'status', transferId: intent.transferId }, frame)).rejects.toThrow('Denied')
    denied = false; bound = { ...original, connectionGeneration: 78 }
    await expect(carrier.handle({ method: 'status', transferId: intent.transferId }, frame)).rejects.toThrow('stale')
  } finally { await canonical.close() }
})

it('reports an idle-expired receiver transfer to the sender as expired, not as a generic rejection', async () => {
  const original = binding(), root = await stagingRoot()
  const bytes = Buffer.from('data'), intent = { ...intentFor(original, bytes), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  let now = Date.now()
  const receiver = createAuthenticatedTransferReceiver({ stagingRoot: root, current: () => original, clock: () => now,
    accepted: { intent: async () => intent, authorize: async () => {} } })
  const channels = pair(original, receiver.extension)
  try {
    await receiver.receiver.start(intent, transferContextForBinding(original))
    now += 6 * 60_000
    const send = createChannelTransferClient(channels.worker).sender({ read: async (_, offset, length) => bytes.subarray(offset, offset + length) }).send(intent)
    await expect(send).rejects.toBeInstanceOf(TransferExpiredError)
  } finally { await channels.close(); await receiver.receiver.close() }
})

it('waits for the device to reconnect instead of spending its retries while the channel is absent', async () => {
  const original = binding(), root = await stagingRoot()
  const bytes = Buffer.from('data'), intent = intentFor(original, bytes)
  const receiver = createAuthenticatedTransferReceiver({ stagingRoot: root, current: () => original,
    accepted: { intent: async () => intent, authorize: async () => {} } })
  vi.useFakeTimers()
  let channels: ReturnType<typeof pair> | undefined
  const reconnect = setTimeout(() => { channels = pair(original, receiver.extension) }, 1_000)
  try {
    const client = createChannelTransferClient({ captureRequest: namespace => channels?.worker.captureRequest(namespace) })
    const read = vi.fn(async (_: TransferIntent, offset: number, length: number) => bytes.subarray(offset, offset + length))
    const result = Promise.allSettled([client.sender({ read }).send(intent)])
    await vi.advanceTimersByTimeAsync(750)
    expect(read).not.toHaveBeenCalled()
    // Process due timers before delivering queued socket frames.
    vi.advanceTimersByTime(250)
    vi.useRealTimers()
    await expect(result).resolves.toEqual([{ status: 'fulfilled', value: expect.objectContaining({ byteSize: bytes.length }) }])
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    clearTimeout(reconnect)
    vi.useRealTimers()
    await channels?.close()
    await receiver.receiver.close()
  }
})
