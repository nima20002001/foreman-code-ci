import { assertSession, documentInstallationId, sessionGeneration, sessionIsSwitching,
  sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'
import type { BrowserControl, BrowserViewObserver, PageFrame } from './types'

type FrameHeader = Omit<PageFrame, 'image'> & { mimeType: string; byteLength: number }
export type BrowserMediaRead = { kind: 'frame'; frame: FrameHeader; offset: number; bytes: Uint8Array }
  | { kind: 'control'; control: BrowserControl } | { kind: 'closed' }

export interface BrowserMediaCodec {
  hello(viewId: string, installationId: string | undefined): string
  decode(data: string | ArrayBuffer): BrowserMediaRead
}

const maxJsonBytes = 16_384, maxBinaryBytes = 262_144, maxFrameBytes = 2 * 1024 * 1024

/** One bounded partial frame. Newer sequences replace it; incomplete older frames are discarded. */
function frameAssembler(sessionId: string, emit: (frame: PageFrame) => void) {
  let partial: { header: FrameHeader; bytes: Uint8Array; received: number } | undefined
  let delivered = 0
  return (read: Extract<BrowserMediaRead, { kind: 'frame' }>) => {
    const { frame, offset, bytes } = read
    if (frame.sessionId !== sessionId || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
      || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > maxFrameBytes
      || !Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength < 1 || offset + bytes.byteLength > frame.byteLength
      || !['image/jpeg', 'image/png', 'image/webp'].includes(frame.mimeType)) throw new Error('Invalid browser frame chunk.')
    if (frame.sequence <= delivered || (partial && frame.sequence < partial.header.sequence)) return
    if (!partial || frame.sequence > partial.header.sequence) {
      if (offset !== 0) return
      partial = { header: frame, bytes: new Uint8Array(frame.byteLength), received: 0 }
    }
    const header = partial.header
    if (frame.browserGeneration !== header.browserGeneration || frame.tabId !== header.tabId
      || frame.width !== header.width || frame.height !== header.height
      || (frame.viewportOffsetTop ?? 0) !== (header.viewportOffsetTop ?? 0)
      || frame.byteLength !== header.byteLength || frame.mimeType !== header.mimeType
      || frame.capturedAt !== header.capturedAt || offset !== partial.received) throw new Error('Out-of-order browser frame chunk.')
    partial.bytes.set(bytes, offset); partial.received += bytes.byteLength
    if (partial.received === header.byteLength) {
      const complete = new Uint8Array(partial.bytes.byteLength); complete.set(partial.bytes)
      const image = new Blob([complete], { type: header.mimeType })
      delivered = header.sequence; partial = undefined
      const metadata: Omit<PageFrame, 'image'> = { sessionId: header.sessionId, tabId: header.tabId,
        browserGeneration: header.browserGeneration, sequence: header.sequence, width: header.width, height: header.height,
        capturedAt: header.capturedAt, ...(header.viewportOffsetTop === undefined ? {} : { viewportOffsetTop: header.viewportOffsetTop }) }
      emit({ ...metadata, image })
    }
  }
}

/** Dedicated receive-only socket. Host media is never queued in ordinary command slots. */
export function connectBrowserView({ sessionId, viewId, observer, signal, codec, origin, socket: Socket = WebSocket }: {
  sessionId: string; viewId: string; observer: BrowserViewObserver; signal: AbortSignal; codec: BrowserMediaCodec
  origin?: string; socket?: typeof WebSocket
}): { close(): void } {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration(), identity = sessionSignal()
  const url = new URL(`/api/browser/sessions/${encodeURIComponent(sessionId)}/view`, origin ?? globalThis.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new Socket(url.toString())
  socket.binaryType = 'arraybuffer'
  let closed = false
  const acceptFrame = frameAssembler(sessionId, frame => observer.frame(frame))
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', retired); identity.removeEventListener('abort', identityChanged)
    socket.close(1000, 'View retired')
  }
  const retired = () => close()
  const identityChanged = () => { observer.disconnected(new SessionChangedError()); close() }
  socket.onopen = () => {
    try {
      assertSession(generation); signal.throwIfAborted(); identity.throwIfAborted()
      const hello = codec.hello(viewId, documentInstallationId())
      if (new TextEncoder().encode(hello).byteLength > maxJsonBytes) throw new Error('Browser view handshake is oversized.')
      socket.send(hello)
    } catch (error) { observer.disconnected(error); close() }
  }
  socket.onmessage = event => {
    if (closed) return
    try {
      assertSession(generation); signal.throwIfAborted(); identity.throwIfAborted()
      const data: unknown = event.data
      if (!(typeof data === 'string' || data instanceof ArrayBuffer)
        || (typeof data === 'string' ? new TextEncoder().encode(data).byteLength > maxJsonBytes : data.byteLength > maxBinaryBytes)) {
        throw new Error('The browser view sent an unsupported or oversized message.')
      }
      const read = codec.decode(data)
      if (read.kind === 'closed') throw new Error('The browser view closed. Reconnect before continuing.')
      if (read.kind === 'control') observer.control(read.control)
      if (read.kind === 'frame') {
        if (typeof data === 'string') throw new Error('Browser images require the bounded binary channel.')
        acceptFrame(read)
      }
    } catch (error) { observer.disconnected(error); close() }
  }
  socket.onerror = () => { if (!closed) { observer.disconnected(new Error('Browser view connection lost. Reconnect before continuing.')); close() } }
  socket.onclose = () => { if (!closed) { observer.disconnected(new Error('Browser view disconnected. Browser actions remain paused.')); close() } }
  signal.addEventListener('abort', retired, { once: true }); identity.addEventListener('abort', identityChanged, { once: true })
  if (signal.aborted || identity.aborted) { if (identity.aborted) identityChanged(); else close() }
  return { close }
}
