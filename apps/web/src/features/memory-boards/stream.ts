import type { z } from 'zod'
import { assertSession, sessionGeneration, sessionSignal, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import type { MemoryChange, MemoryStreamListeners } from './ports'

/** One visible owner, no hidden polling. `ready` permits a bounded snapshot
 * after registration, or an honest offline/reconnecting fallback. */
export function subscribeMemoryBoard(boardId: string, schema: z.ZodType<MemoryChange>, listeners: MemoryStreamListeners): () => void {
  if (sessionIsSwitching()) return () => undefined
  const generation = sessionGeneration(), signal = sessionSignal()
  let source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let closed = false, failures = 0
  const valid = () => {
    try { assertSession(generation); return !closed && !signal.aborted } catch { return false }
  }
  const offline = () => typeof navigator !== 'undefined' && !navigator.onLine
  const disconnect = () => { source?.close(); source = undefined; clearTimeout(timer); timer = undefined }
  const reconnect = () => {
    if (!valid()) return
    disconnect()
    listeners.connection(offline() ? 'offline' : 'reconnecting')
    // A failed stream cannot make API-owned memory unavailable. Read a bounded
    // snapshot with the reconnecting label; the next open reconciles again.
    listeners.ready()
    if (!offline()) timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)))
  }
  function connect() {
    if (!valid()) return
    if (offline()) { listeners.connection('offline'); listeners.ready(); return }
    if (typeof EventSource === 'undefined') {
      listeners.connection('unavailable'); listeners.ready(); return
    }
    listeners.connection(failures ? 'reconnecting' : 'connecting')
    const current = new EventSource(`/api/memory-boards/${encodeURIComponent(boardId)}/events`)
    source = current
    current.addEventListener('open', () => {
      if (!valid() || source !== current) return
      failures = 0
      listeners.ready()
      listeners.connection('connected')
    })
    const receive = (wire: MessageEvent<string>) => {
      if (!valid() || source !== current) return
      try {
        const change = schema.parse(JSON.parse(wire.data))
        if (change.boardId !== boardId) { listeners.reset(); return }
        listeners.change(change)
      } catch { listeners.reset() }
    }
    current.addEventListener('change', receive)
    current.addEventListener('message', receive)
    current.addEventListener('reset', () => { if (valid() && source === current) listeners.reset() })
    current.addEventListener('error', () => { if (valid() && source === current) reconnect() })
  }
  const onOffline = () => { if (valid()) { disconnect(); listeners.connection('offline'); listeners.ready() } }
  const onOnline = () => { if (valid()) { disconnect(); connect() } }
  const close = () => {
    closed = true; disconnect()
    signal.removeEventListener('abort', close)
    window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline)
  }
  signal.addEventListener('abort', close, { once: true })
  window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline)
  if (signal.aborted) close(); else connect()
  return close
}
