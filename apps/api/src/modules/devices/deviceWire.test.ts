import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { DEVICE_BUFFER_BYTES, DEVICE_FRAME_BYTES, DEVICE_QUEUE_DEPTH } from '@foreman-code/contracts/device-connection'
import { adaptDeviceSocket, DeviceConnectionError } from './deviceWire.js'

class RawSocket extends EventEmitter {
  bufferedAmount = 0
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  receive(text: string, binary = false) { this.emit('message', Buffer.from(text), binary) }
}

it('hands queued frames from the handshake iterator to the ordered synchronous reader', async () => {
  const raw = new RawSocket()
  const socket = adaptDeviceSocket(raw)
  const iterator = socket.messages[Symbol.asyncIterator]()
  raw.receive('hello')
  expect(await iterator.next()).toEqual({ done: false, value: 'hello' })
  raw.receive('already queued')
  const received: string[] = []
  const consuming = iterator.consume(text => { received.push(text) }, new AbortController().signal)
  for (let i = 0; i < 32; i++) raw.receive(String(i).padEnd(DEVICE_FRAME_BYTES, 'x'))
  expect(received).toEqual(['already queued', ...Array.from({ length: 32 }, (_, i) =>
    String(i).padEnd(DEVICE_FRAME_BYTES, 'x'))])
  expect(raw.closed).toBe(false)
  raw.close()
  await consuming
})

it.each([
  { name: 'bytes', size: DEVICE_FRAME_BYTES, count: DEVICE_BUFFER_BYTES / DEVICE_FRAME_BYTES + 1 },
  { name: 'depth', size: 1, count: DEVICE_QUEUE_DEPTH + 1 },
])('preserves the unread queue $name limit before a reader takes over', async ({ size, count }) => {
  const raw = new RawSocket()
  const iterator = adaptDeviceSocket(raw).messages[Symbol.asyncIterator]()
  for (let i = 0; i < count; i++) raw.receive('x'.repeat(size))
  await expect(iterator.next()).rejects.toMatchObject({ code: 'backpressure' })
  expect(raw.closed).toBe(true)
})

it.each([
  { name: 'oversized', size: DEVICE_FRAME_BYTES + 1, binary: false, code: 'backpressure' },
  { name: 'binary', size: 1, binary: true, code: 'malformed-frame' },
])('rejects $name frames during synchronous consumption', async ({ size, binary, code }) => {
  const raw = new RawSocket()
  const iterator = adaptDeviceSocket(raw).messages[Symbol.asyncIterator]()
  const received: string[] = []
  const consuming = iterator.consume(text => { received.push(text) }, new AbortController().signal)
  const checked = expect(consuming).rejects.toMatchObject({ code })
  raw.receive('x'.repeat(size), binary)
  await checked
  expect(received).toEqual([])
  expect(raw.closed).toBe(true)
})

it('closes the socket and reports synchronous reader failures', async () => {
  const raw = new RawSocket()
  const iterator = adaptDeviceSocket(raw).messages[Symbol.asyncIterator]()
  const failure = new DeviceConnectionError('malformed-frame')
  const consuming = iterator.consume(() => { throw failure }, new AbortController().signal)
  const checked = expect(consuming).rejects.toBe(failure)
  raw.receive('invalid')
  await checked
  expect(raw.closed).toBe(true)
})
