import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { BrowserPairingAuthority, BrowserInstallationBinding } from '../browser-profiles/keys.js'
import { DomainError } from '../errors.js'
import type { BrowserMediaSource, BrowserMediaFrame } from './mediaSocket.js'
import type { BrowserControl, BrowserRuntimeView, BrowserHostFrame } from './types.js'
import type { BrowserMediaService } from './media.js'
import type { BrowserBroker } from './broker.js'

/** Private projection of C0's dedicated paired browser-media envelope, not an ordinary device RPC. */
export type BrowserHostMediaMessage =
  | { kind: 'open'; id: string; ownerId: string; sessionId: string; viewId: string }
  | { kind: 'close'; id: string; disconnected: boolean }
  | { kind: 'opened'; id: string; view: BrowserRuntimeView }
  | { kind: 'snapshot_end'; id: string }
  | { kind: 'control'; id: string; control: BrowserControl }
  | { kind: 'frame'; id: string; frame: BrowserMediaFrame; offset: number; bytes: Uint8Array }
  | { kind: 'error'; id: string; reason: string }
export interface BrowserHostMediaCodec {
  decode(value: Uint8Array | string): BrowserHostMediaMessage
  encode(value: BrowserHostMediaMessage): Uint8Array | string
}
const bytesOf = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
async function send(socket: WebSocket, codec: BrowserHostMediaCodec, value: BrowserHostMediaMessage): Promise<void> {
  const encoded = codec.encode(value), size = typeof encoded === 'string' ? Buffer.byteLength(encoded) : encoded.byteLength
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 262_144 || size > (typeof encoded === 'string' ? 16_384 : 262_144)) {
    throw new DomainError('BROWSER_MEDIA_BOUND', 'The dedicated host media stream exceeded its bound.', 429)
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Host media send timed out')) }, 5000)
    socket.send(encoded, { binary: typeof encoded !== 'string' }, error => { clearTimeout(timer); if (error) reject(error)
      else resolve() })
  })
}
function incoming(data: RawData, binary: boolean, codec: BrowserHostMediaCodec): BrowserHostMediaMessage {
  const bytes = bytesOf(data)
  if (bytes.byteLength > (binary ? 262_144 : 16_384)) throw new DomainError('BROWSER_MEDIA_BOUND', 'The host media message exceeded its bound.', 413)
  return codec.decode(binary ? bytes : bytes.toString('utf8'))
}

interface RemoteView {
  sessionId: string; viewId: string; view?: BrowserRuntimeView; control?: BrowserControl
  latest: (BrowserHostFrame & { sequence: number }) | null
  partial?: { frame: BrowserMediaFrame; data: Uint8Array; received: number }
  changed: () => void; ready: () => void; failed: (error: unknown) => void; error?: unknown
}
interface PairedPeer { binding: BrowserInstallationBinding; socket: WebSocket; subscriptions: Map<string, RemoteView> }

function receiveHostMedia(peer: PairedPeer, codec: BrowserHostMediaCodec, authorize: () => Promise<void>,
  receive: (message: BrowserHostMediaMessage) => void, reportFailure: (error: unknown) => void): void {
  const queue: Array<{ message: BrowserHostMediaMessage; size: number }> = []
  const discarded = new Map<string, number>()
  let queuedBytes = 0, pumping = false, closed = false
  const discardFrame = (id: string, sequence: number) => {
    discarded.set(id, Math.max(sequence, discarded.get(id) ?? 0))
    for (let index = queue.length - 1; index >= 0; index--) {
      const entry = queue[index]!
      if (entry.message.kind === 'frame' && entry.message.id === id && entry.message.frame.sequence <= sequence) {
        queuedBytes -= entry.size
        queue.splice(index, 1)
      }
    }
  }
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (!closed && queue.length) {
        const entry = queue.shift()!
        try {
          await authorize()
          const message = entry.message
          if (!closed && (message.kind !== 'frame' || message.frame.sequence > (discarded.get(message.id) ?? 0))) receive(message)
        } finally { queuedBytes -= entry.size }
      }
    } catch (error) {
      reportFailure(error)
      peer.socket.close(1008, 'Invalid host media')
    } finally { pumping = false }
  }
  peer.socket.on('message', (data, binary) => {
    try {
      const bytes = bytesOf(data)
      const message = incoming(bytes, binary, codec)
      if (!peer.subscriptions.has(message.id)) return
      if (message.kind === 'frame') {
        if (message.frame.sequence <= (discarded.get(message.id) ?? 0)) return
        discardFrame(message.id, message.frame.sequence - 1)
      }
      while (queuedBytes + bytes.byteLength > 524_288) {
        const oldest = queue.find(entry => entry.message.kind === 'frame')?.message
        if (oldest?.kind !== 'frame') {
          if (message.kind === 'frame') { discardFrame(message.id, message.frame.sequence); return }
          throw new DomainError('BROWSER_MEDIA_BOUND', 'Host media commands exceeded the ingress bound.', 429)
        }
        discardFrame(oldest.id, oldest.frame.sequence)
      }
      queuedBytes += bytes.byteLength
      queue.push({ message, size: bytes.byteLength })
      void pump()
    } catch (error) { reportFailure(error); peer.socket.close(1008, 'Invalid host media') }
  })
  peer.socket.once('close', () => { closed = true; queue.length = 0; discarded.clear() })
}

/** Main receives one authenticated, installation-bound host socket independently of the eight RPC slots. */
export class BrowserPairedMediaHub<Principal> {
  private readonly peers = new Map<string, PairedPeer>()
  constructor(private readonly pairing: BrowserPairingAuthority, private readonly codec: BrowserHostMediaCodec,
    private readonly ownerId: (principal: Principal) => string,
    private readonly authorize: (principal: Principal, sessionId: string) => Promise<void>,
    private readonly reportFailure: (error: unknown) => void) {}

  async attach(binding: BrowserInstallationBinding, socket: WebSocket): Promise<void> {
    await this.pairing.assertCurrent(binding)
    this.peers.get(binding.computerId)?.socket.close(1008, 'Host media binding replaced')
    const peer: PairedPeer = { binding, socket, subscriptions: new Map() }; this.peers.set(binding.computerId, peer)
    let alive = true
    const timer = setInterval(() => {
      if (!alive) { socket.terminate(); return }
      alive = false; socket.ping()
      void this.pairing.assertCurrent(binding).catch(error => { this.reportFailure(error); socket.close(1008, 'Host binding changed') })
    }, 15_000)
    socket.on('pong', () => { alive = true })
    receiveHostMedia(peer, this.codec, () => this.pairing.assertCurrent(binding),
      message => this.receive(peer, message), this.reportFailure)
    socket.on('error', this.reportFailure)
    socket.once('close', () => {
      clearInterval(timer)
      if (this.peers.get(binding.computerId) === peer) this.peers.delete(binding.computerId)
      for (const view of peer.subscriptions.values()) {
        view.error = new DomainError('BROWSER_COMPUTER_OFFLINE', 'The browser computer disconnected.', 503)
        view.latest = null; delete view.partial; view.failed(view.error); view.changed()
      }
      peer.subscriptions.clear()
    })
  }

  private receive(peer: PairedPeer, message: BrowserHostMediaMessage): void {
    const view = peer.subscriptions.get(message.id)
    if (!view) return
    if (message.kind === 'opened') {
      if (message.view.id !== view.viewId || message.view.sessionId !== view.sessionId) throw new DomainError('BROWSER_VIEW_SCOPE', 'The host returned another view.', 403)
      view.view = message.view; view.changed(); return
    }
    if (message.kind === 'snapshot_end') {
      if (view.view && view.control) view.ready()
      return
    }
    if (message.kind === 'error') {
      view.error = new DomainError('BROWSER_VIEW_CLOSED', 'The owned host view is unavailable.', 409)
      view.latest = null; delete view.partial; view.failed(view.error); view.changed(); return
    }
    if (message.kind === 'control') {
      if (message.control.sessionId !== view.sessionId) throw new DomainError('BROWSER_VIEW_SCOPE', 'The host returned another session control.', 403)
      view.control = message.control; view.changed(); return
    }
    if (message.kind !== 'frame' || !view.view) return
    const frame = message.frame
    if (frame.sessionId !== view.sessionId || frame.tabId !== view.view.tabId || frame.browserGeneration !== view.view.browserGeneration
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || !Number.isSafeInteger(frame.byteLength)
      || frame.byteLength < 1 || frame.byteLength > 2 * 1024 * 1024 || message.bytes.byteLength > 196_608) {
      throw new DomainError('BROWSER_MEDIA_FRAME', 'The host frame identity or size is invalid.', 409)
    }
    if (frame.sequence <= (view.latest?.sequence ?? 0)) return
    if (!view.partial || frame.sequence > view.partial.frame.sequence) {
      if (message.offset !== 0) throw new DomainError('BROWSER_MEDIA_FRAME', 'A host frame is missing its first bytes.', 409)
      view.partial = { frame, data: new Uint8Array(frame.byteLength), received: 0 }
    }
    const partial = view.partial
    if (frame.sequence < partial.frame.sequence) return
    if (partial.received !== message.offset || frame.byteLength !== partial.data.byteLength
      || message.offset + message.bytes.byteLength > partial.data.byteLength) throw new DomainError('BROWSER_MEDIA_FRAME', 'Host frame chunks arrived out of order.', 409)
    partial.data.set(message.bytes, message.offset); partial.received += message.bytes.byteLength
    if (partial.received === partial.data.byteLength) {
      view.latest = { data: partial.data, mimeType: frame.mimeType, width: frame.width, height: frame.height,
        viewportOffsetTop: frame.viewportOffsetTop, capturedAt: frame.capturedAt, sequence: frame.sequence }
      delete view.partial; view.changed()
    }
  }

  source(binding: BrowserInstallationBinding): BrowserMediaSource<Principal> {
    return { open: async (principal, sessionId, viewId, changed) => {
      await this.authorize(principal, sessionId); await this.pairing.assertCurrent(binding)
      const peer = this.peers.get(binding.computerId)
      if (!peer || peer.binding.installationId !== binding.installationId || peer.binding.connectionId !== binding.connectionId) {
        throw new DomainError('BROWSER_MEDIA_OFFLINE', 'The computer’s dedicated browser media connection is unavailable.', 503)
      }
      const id = randomUUID()
      let ready!: () => void, failed!: (error: unknown) => void
      const opened = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
      const value: RemoteView = { sessionId, viewId, latest: null, changed, ready, failed }
      peer.subscriptions.set(id, value)
      const timeout = setTimeout(() => failed(new Error('Host media subscribe timed out')), 5000)
      try {
        await send(peer.socket, this.codec, { kind: 'open', id, sessionId, viewId, ownerId: this.ownerId(principal) })
        await opened
      } catch (error) {
        peer.subscriptions.delete(id)
        if (peer.socket.readyState === WebSocket.OPEN) await send(peer.socket, this.codec, { kind: 'close', id, disconnected: false })
        throw error
      } finally { clearTimeout(timeout) }
      return {
        read: async after => {
          await this.authorize(principal, sessionId); await this.pairing.assertCurrent(binding)
          if (value.error) throw value.error
          if (!value.view || !value.control) throw new DomainError('BROWSER_MEDIA_PENDING', 'The host has not delivered current control state.', 503)
          return { view: value.view, control: value.control, frame: value.latest && value.latest.sequence > after ? value.latest : null }
        },
        close: async disconnected => {
          peer.subscriptions.delete(id); value.latest = null; delete value.partial
          if (peer.socket.readyState === WebSocket.OPEN) await send(peer.socket, this.codec, { kind: 'close', id, disconnected })
        },
      }
    } }
  }
}

/** Host side of the dedicated socket. Pairing authenticates Main; only Main-registered owned view IDs are usable. */
export async function attachBrowserHostMedia(socket: WebSocket, binding: BrowserInstallationBinding,
  pairing: BrowserPairingAuthority, codec: BrowserHostMediaCodec, media: BrowserMediaService, broker: BrowserBroker,
  reportFailure: (error: unknown) => void): Promise<void> {
  await pairing.assertCurrent(binding)
  const subscriptions = new Map<string, { viewId: string; ownerId: string; after: number; stop(): void }>()
  const dirty = new Set<string>(); let pumping = false, closed = false
  const stop = async (id: string, disconnected: boolean) => {
    const value = subscriptions.get(id)
    if (!value) return
    subscriptions.delete(id); dirty.delete(id); value.stop()
    if (disconnected) await media.close(value.viewId, value.ownerId, true)
  }
  const pump = async () => {
    if (pumping || closed) return
    pumping = true
    try {
      while (dirty.size && !closed) {
        const id = dirty.values().next().value as string; dirty.delete(id)
        const subscription = subscriptions.get(id)
        if (!subscription) continue
        await pairing.assertCurrent(binding)
        try {
          const value = media.read(subscription.viewId, subscription.ownerId, subscription.after), { control } = broker.read(value.view.sessionId)
          await send(socket, codec, { kind: 'control', id, control })
          if (!value.frame) { await send(socket, codec, { kind: 'snapshot_end', id }); continue }
          const { data, ...frame } = value.frame
          for (let offset = 0; offset < data.byteLength && subscriptions.has(id) && !closed; offset += 196_608) {
            await pairing.assertCurrent(binding)
            await send(socket, codec, { kind: 'frame', id, frame: { ...frame, sessionId: value.view.sessionId,
              tabId: value.view.tabId, browserGeneration: value.view.browserGeneration, byteLength: data.byteLength },
            offset, bytes: data.subarray(offset, offset + 196_608) })
          }
          subscription.after = frame.sequence
          await send(socket, codec, { kind: 'snapshot_end', id })
        } catch (error) {
          reportFailure(error); await stop(id, true); await send(socket, codec, { kind: 'error', id, reason: 'Owned browser view unavailable.' })
        }
      }
    } catch (error) { reportFailure(error); socket.close(1008, 'Host media stopped') } finally { pumping = false }
  }
  const change = (id: string) => { dirty.add(id); void pump() }
  let tail = Promise.resolve(), queuedBytes = 0
  socket.on('message', (data, binary) => {
    const bytes = bytesOf(data)
    queuedBytes += bytes.byteLength
    if (bytes.byteLength > (binary ? 262_144 : 16_384) || queuedBytes > 524_288) { socket.close(1009, 'Host media ingress bound exceeded'); return }
    tail = tail.then(async () => {
      try {
        if (closed) return
        await pairing.assertCurrent(binding)
        const message = incoming(bytes, binary, codec)
        if (message.kind === 'close') { await stop(message.id, message.disconnected); return }
        if (message.kind !== 'open') throw new DomainError('BROWSER_MEDIA_INPUT', 'Unexpected host media command.', 400)
        if (subscriptions.has(message.id)) return
        const view = media.describe(message.viewId, message.ownerId)
        if (view.sessionId !== message.sessionId) throw new DomainError('BROWSER_VIEW_SCOPE', 'The requested view belongs to another session.', 403)
        const offMedia = media.subscribe(view.id, message.ownerId, () => change(message.id))
        const offSession = broker.subscribe(view.sessionId, () => change(message.id))
        subscriptions.set(message.id, { viewId: view.id, ownerId: message.ownerId, after: 0, stop: () => { offMedia(); offSession() } })
        await send(socket, codec, { kind: 'control', id: message.id, control: broker.read(view.sessionId).control })
        await send(socket, codec, { kind: 'opened', id: message.id, view }); change(message.id)
      } finally { queuedBytes -= bytes.byteLength }
    }).catch(error => { reportFailure(error); socket.close(1008, 'Host media command denied') })
  })
  socket.on('error', reportFailure)
  socket.once('close', () => {
    closed = true
    void Promise.allSettled([...subscriptions.keys()].map(id => stop(id, true))).then(results => {
      for (const result of results) if (result.status === 'rejected') reportFailure(result.reason)
    })
  })
}
