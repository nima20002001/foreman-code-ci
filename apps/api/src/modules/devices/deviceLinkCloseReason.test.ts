import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceApplicationChannel } from './deviceApplicationChannel.js'
import { adaptDeviceSocket, DeviceConnectionError } from './deviceWire.js'

/** In-memory WebSocket pair: frames sent before close() still reach the peer, as with a real close handshake. */
class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    if (this.closed) throw new Error('socket closed')
    queueMicrotask(() => this.peer?.deliver(text))
  }
  deliver(text: string) { if (!this.closed) this.emit('message', Buffer.from(text), false) }
  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => { this.emit('close'); this.peer?.close() })
  }
}

function link() {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const mainRaw = new Socket(), workerRaw = new Socket()
  mainRaw.peer = workerRaw; workerRaw.peer = mainRaw
  let mainChannel!: DeviceApplicationChannel
  const open = (side: 'main' | 'worker', raw: Socket) => {
    const socket = adaptDeviceSocket(raw)
    const channel = new DeviceApplicationChannel({ side, binding, socket, signal: new AbortController().signal,
      extensions: [], registrations: [] })
    if (side === 'main') mainChannel = channel
    return channel.run(socket.messages[Symbol.asyncIterator](), 15_000)
  }
  return { main: open('main', mainRaw), worker: open('worker', workerRaw), workerRaw,
    revoke: () => mainChannel.close(new DeviceConnectionError('revoked')) }
}

it('tells the Worker why Main closed the device link instead of reporting a bare transport loss', async () => {
  const f = link()
  const main = expect(f.main).rejects.toMatchObject({ code: 'malformed-frame' })
  const worker = expect(f.worker).rejects.toMatchObject({ code: 'malformed-frame' })
  f.workerRaw.send(JSON.stringify({ type: 'application-ack', id: 'not-an-application-id', offset: 0 }))
  await main
  await worker
})


it('delivers revocation before stopping the active synchronous consumer', async () => {
  const f = link()
  const main = expect(f.main).rejects.toMatchObject({ code: 'revoked' })
  const worker = expect(f.worker).rejects.toMatchObject({ code: 'revoked' })
  f.revoke()
  await main
  await worker
})
