import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { DomainError } from '../errors.js'
import type { BrowserSessionService } from './service.js'
import type { BrowserControl, BrowserHostFrame, BrowserRuntimeView } from './types.js'

export interface BrowserMediaFrame extends Omit<BrowserHostFrame, 'data'> {
  sessionId: string; tabId: string; browserGeneration: number; sequence: number; byteLength: number
}
/** Canonical C0 wire parsing/encoding is injected; buffering, ownership and lifecycle stay in B. */
export interface BrowserMediaWireCodec {
  decodeHello(value: unknown): { viewId: string }
  frame(value: { kind: 'frame'; frame: BrowserMediaFrame; offset: number; bytes: Uint8Array }): Uint8Array
  control(value: { kind: 'control'; control: BrowserControl }): string
  closed(value: { kind: 'closed' }): string
}
export interface BrowserMediaSource<Principal> {
  open(principal: Principal, sessionId: string, viewId: string, changed: () => void): Promise<{
    read(after: number): Promise<{ view: BrowserRuntimeView; frame: (BrowserHostFrame & { sequence: number }) | null; control: BrowserControl }>
    close(disconnected: boolean): Promise<void>
  }>
}

export function localBrowserMediaSource<Principal>(service: BrowserSessionService<Principal>): BrowserMediaSource<Principal> {
  return {
    async open(principal, sessionId, viewId, changed) {
      const ownerId = service.authority.callerId(principal), view = service.media.describe(viewId, ownerId)
      if (view.sessionId !== sessionId) throw new DomainError('BROWSER_VIEW_SCOPE', 'This view belongs to another browser session.', 403)
      await service.authorize(principal, sessionId, false)
      const mediaStop = service.media.subscribe(viewId, ownerId, changed)
      const sessionStop = service.broker.subscribe(sessionId, () => changed())
      return {
        async read(after) {
          const { control } = await service.authorize(principal, sessionId, false)
          return { ...service.media.read(viewId, ownerId, after), control }
        },
        async close(disconnected) { mediaStop(); sessionStop(); if (disconnected) await service.media.close(viewId, ownerId, true) },
      }
    },
  }
}

const rawBytes = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
function boundedSend(socket: WebSocket, value: string | Uint8Array): Promise<void> {
  const length = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
  if (length > (typeof value === 'string' ? 16_384 : 262_144) || socket.bufferedAmount > 262_144) {
    return Promise.reject(new DomainError('BROWSER_MEDIA_BOUND', 'The browser viewer cannot keep up with its bounded stream.', 429))
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Browser viewer send timed out')) }, 5000)
    socket.send(value, { binary: typeof value !== 'string' }, error => { clearTimeout(timeout); if (error) reject(error)
      else resolve() })
  })
}

async function streamViewer<Principal>(socket: WebSocket, principal: Principal, sessionId: string, viewId: string,
  source: BrowserMediaSource<Principal>, codec: BrowserMediaWireCodec, assertCurrent: () => Promise<void>, reportFailure: (error: unknown) => void) {
  let dirty = true, pumping = false, closed = false, after = 0, controlIdentity = '', alive = true
  let subscription: Awaited<ReturnType<BrowserMediaSource<Principal>['open']>> | undefined
  const retire = async () => {
    if (closed) return
    closed = true; clearInterval(heartbeat)
    try { await subscription?.close(true) } catch (error) { reportFailure(error) }
  }
  const pump = async () => {
    if (pumping || closed || !subscription) return
    pumping = true
    try {
      while (dirty && !closed) {
        dirty = false; await assertCurrent()
        const value = await subscription.read(after), identity = JSON.stringify(value.control)
        if (identity !== controlIdentity) {
          await boundedSend(socket, codec.control({ kind: 'control', control: value.control })); controlIdentity = identity
        }
        if (!value.frame) continue
        const { data, ...metadata } = value.frame
        if (data.byteLength > 2 * 1024 * 1024) throw new DomainError('BROWSER_MEDIA_BOUND', 'The browser frame exceeds its bounded stream.', 413)
        const frame: BrowserMediaFrame = { ...metadata, sessionId: value.view.sessionId, tabId: value.view.tabId,
          browserGeneration: value.view.browserGeneration, byteLength: data.byteLength }
        for (let offset = 0; offset < data.byteLength && !closed; offset += 196_608) {
          await assertCurrent()
          await boundedSend(socket, codec.frame({ kind: 'frame', frame, offset, bytes: data.subarray(offset, offset + 196_608) }))
        }
        after = frame.sequence
      }
    } catch (error) { reportFailure(error); socket.close(1008, 'Browser view is unavailable'); await retire() } finally { pumping = false }
  }
  const changed = () => { dirty = true; void pump() }
  const heartbeat = setInterval(() => {
    if (!alive) { socket.terminate(); void retire(); return }
    alive = false; socket.ping()
    void assertCurrent().catch(error => { reportFailure(error); socket.close(1008, 'Browser authorization changed'); void retire() })
  }, 15_000)
  socket.on('pong', () => { alive = true })
  socket.on('close', () => { void retire() })
  socket.on('error', error => { reportFailure(error); void retire() })
  // Frames/control travel only downstream. Input and Stop use their independent canonical request paths.
  socket.on('message', () => socket.close(1008, 'Unexpected browser media message'))
  try {
    subscription = await source.open(principal, sessionId, viewId, changed)
    if (closed) await subscription.close(true); else await pump()
  } catch (error) { reportFailure(error); socket.close(1008, 'Browser view is unavailable'); await retire() }
}

/** Mount at the existing server's upgrade dispatch; it handles only this exact browser viewer path. */
export function createBrowserViewerUpgrade<Principal>(options: {
  source: BrowserMediaSource<Principal>; codec: BrowserMediaWireCodec
  authenticate(request: IncomingMessage, hello: unknown): Promise<{ principal: Principal; assertCurrent(): Promise<void> }>
  reportFailure(error: unknown): void
}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false })
  return {
    handle(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      const path = new URL(request.url ?? '/', 'http://browser.invalid').pathname
      const match = /^\/api\/browser\/sessions\/([^/]+)\/view$/.exec(path)
      if (!match) return false
      server.handleUpgrade(request, socket, head, client => {
        const timeout = setTimeout(() => client.close(1008, 'Browser viewer hello timed out'), 5000)
        client.once('close', () => clearTimeout(timeout))
        client.once('message', (data, binary) => {
          clearTimeout(timeout)
          void (async () => {
            if (binary) throw new DomainError('BROWSER_VIEW_HELLO', 'A canonical browser viewer hello is required.', 400)
            const hello: unknown = JSON.parse(rawBytes(data).toString('utf8'))
            const identity = await options.authenticate(request, hello), decoded = options.codec.decodeHello(hello)
            await identity.assertCurrent()
            await streamViewer(client, identity.principal, decodeURIComponent(match[1]!), decoded.viewId,
              options.source, options.codec, identity.assertCurrent, options.reportFailure)
          })().catch(error => { options.reportFailure(error); client.close(1008, 'Browser viewer authentication failed') })
        })
      })
      return true
    },
    close() { for (const socket of server.clients) socket.close(1001, 'Browser service closing'); server.close() },
  }
}
