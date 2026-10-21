import { expect, it, vi } from 'vitest'
import { connectBrowserView, type BrowserMediaCodec, type BrowserMediaRead } from './viewTransport'
import { frame } from './testFixtures'
import type { BrowserViewObserver } from './types'

class SocketFixture {
  static last: SocketFixture
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  binaryType = 'arraybuffer'
  send = vi.fn()
  close = vi.fn()
  constructor(readonly url: string) { SocketFixture.last = this }
}

function view(codec: BrowserMediaCodec) {
  const observer: BrowserViewObserver = { frame: vi.fn(), control: vi.fn(), disconnected: vi.fn() }
  const abort = new AbortController()
  const connection = connectBrowserView({ sessionId: 'session', viewId: 'view', observer, signal: abort.signal, codec,
    origin: 'https://fixture.test', socket: SocketFixture as unknown as typeof WebSocket })
  return { observer, connection, socket: SocketFixture.last, abort }
}

it('assembles bounded contiguous chunks once and discards an incomplete older frame', async () => {
  const { image, ...metadata } = frame('session', 'tab', 1)
  expect(image).toBeInstanceOf(Blob)
  let value: BrowserMediaRead = { kind: 'frame', frame: { ...metadata, byteLength: 4, mimeType: 'image/png' }, offset: 0, bytes: new Uint8Array([1, 2]) }
  const codec: BrowserMediaCodec = { hello: () => '{}', decode: () => value }
  const { observer, connection, socket } = view(codec)
  socket.onopen!()
  socket.onmessage!(new MessageEvent('message', { data: new ArrayBuffer(20) }))
  expect(observer.frame).not.toHaveBeenCalled()
  value = { kind: 'frame', frame: { ...metadata, sequence: 2, byteLength: 2, mimeType: 'image/png' }, offset: 0, bytes: new Uint8Array([8, 9]) }
  socket.onmessage!(new MessageEvent('message', { data: new ArrayBuffer(20) }))
  expect(observer.frame).toHaveBeenCalledTimes(1)
  const delivered = vi.mocked(observer.frame).mock.calls[0]![0]
  expect(delivered.sequence).toBe(2)
  expect(new Uint8Array(await delivered.image.arrayBuffer())).toEqual(new Uint8Array([8, 9]))
  value = { kind: 'frame', frame: { ...metadata, byteLength: 4, mimeType: 'image/png' }, offset: 2, bytes: new Uint8Array([3, 4]) }
  socket.onmessage!(new MessageEvent('message', { data: new ArrayBuffer(20) }))
  expect(observer.frame).toHaveBeenCalledTimes(1)
  connection.close()
})

it.each([['JSON', 'x'.repeat(16_385)], ['binary', new ArrayBuffer(262_145)]])('closes oversized %s before any C0 decoder or observer frame runs', (_kind, data) => {
  const codec: BrowserMediaCodec = { hello: () => '{}', decode: vi.fn(() => ({ kind: 'closed' as const })) }
  const { observer, socket } = view(codec)
  socket.onmessage!(new MessageEvent('message', { data }))
  expect(codec.decode).not.toHaveBeenCalled()
  expect(observer.frame).not.toHaveBeenCalled()
  expect(observer.disconnected).toHaveBeenCalledTimes(1)
  expect(socket.close).toHaveBeenCalledTimes(1)
})
