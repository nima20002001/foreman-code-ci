import WebSocket from 'ws'
import { DomainError } from '../errors.js'

export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }

/** Private local CDP connection. Nothing from this class is exposed as a tool or public URL. */
export class BrowserCdpConnection {
  private sequence = 0
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private disconnected = false
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', bytes => {
      let value: { id?: number; result?: unknown; error?: unknown; method?: string; params?: Record<string, unknown>; sessionId?: string }
      try { value = JSON.parse(bytes.toString()) as typeof value } catch { this.fail(); return }
      if (value.id !== undefined) {
        const pending = this.pending.get(value.id)
        if (!pending) return
        this.pending.delete(value.id); clearTimeout(pending.timer)
        if (value.error) pending.reject(new DomainError('BROWSER_NATIVE_FAILURE', 'The browser rejected this operation.', 502))
        else pending.resolve(value.result)
        return
      }
      if (value.method) for (const listener of this.listeners) listener({ method: value.method,
        params: value.params ?? {}, ...(value.sessionId ? { sessionId: value.sessionId } : {}) })
    })
    socket.on('close', () => this.fail()); socket.on('error', () => this.fail())
  }

  static async connect(endpoint: string): Promise<BrowserCdpConnection> {
    const url = new URL(endpoint)
    if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      throw new DomainError('BROWSER_ENDPOINT_INVALID', 'The private browser endpoint must be local.', 503)
    }
    const socket = new WebSocket(endpoint, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return new BrowserCdpConnection(socket)
  }

  private fail(): void {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer); value.reject(new DomainError('BROWSER_DISCONNECTED', 'The browser connection was lost.', 503))
    }
    this.pending.clear()
    if (!this.disconnected) {
      this.disconnected = true
      for (const listener of this.disconnectListeners) listener()
    }
  }

  onEvent(listener: (event: CdpEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onDisconnected(listener: () => void): () => void {
    if (this.disconnected) listener(); else this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new DomainError('BROWSER_DISCONNECTED', 'The browser connection is unavailable.', 503))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new DomainError('BROWSER_NATIVE_TIMEOUT', 'The browser operation did not settle.', 504))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(id); reject(error)
      })
    })
  }

  close(): void { this.fail(); this.socket.close() }
}
