import { OperatorConversationStateSchema, OperatorConversationStreamEventSchema,
  type OperatorConversationState, type OperatorConversationStreamEvent } from '@foreman-code/contracts'
import { ApiError, apiClient } from './client'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal } from './sessionBoundary'

export type OperatorChatConnection = 'connecting' | 'connected' | 'reconnecting' | 'unavailable'

export function subscribeOperatorChat(id: string, listeners: {
  snapshot(state: OperatorConversationState): void
  event(event: OperatorConversationStreamEvent): void
  reconnect(): void
  recover?(): Promise<void>
  connection?(state: OperatorChatConnection): void
}): () => void {
  if (sessionIsSwitching()) return () => {}
  if (typeof EventSource === 'undefined') {
    listeners.connection?.('unavailable')
    return () => {}
  }
  const generation = sessionGeneration()
  const signal = sessionSignal()
  let ready = false
  let highWater = -1
  let closed = false
  let retries = 0
  let recovering = false
  let source: EventSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const seen = new Set<number>()
  const bindings: Array<[string, EventListener]> = []
  const detach = () => {
    for (const [type, listener] of bindings) source?.removeEventListener(type, listener)
    bindings.length = 0
    source?.close()
    source = undefined
  }
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    detach()
    signal.removeEventListener('abort', close)
    if (typeof window !== 'undefined') window.removeEventListener('online', schedule)
  }
  const valid = () => {
    try { assertSession(generation); return !closed && !signal.aborted }
    catch { close(); return false }
  }
  const recover = async () => {
    if (!valid() || typeof navigator !== 'undefined' && navigator.onLine === false) return
    recovering = true
    let retry = false
    try {
      if (listeners.recover) await listeners.recover()
      else {
        const state = await apiClient.getOperatorConversation(id, { signal })
        if (valid()) listeners.snapshot(state)
      }
      if (valid()) connect()
    } catch (error) {
      if (!valid()) return
      if (ApiError.is(error) && [401, 403, 404].includes(error.status)) {
        listeners.connection?.('unavailable')
        close()
        return
      }
      retry = true
    } finally {
      recovering = false
      if (retry) schedule()
    }
  }
  function schedule() {
    if (!valid() || timer || source || recovering) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const delay = Math.min(1_000 * 2 ** retries, 10_000)
    retries = Math.min(retries + 1, 4)
    timer = setTimeout(() => { timer = undefined; void recover() }, delay)
  }
  const refresh = () => {
    if (!valid()) return
    ready = false
    const terminal = source?.readyState === EventSource.CLOSED
    listeners.connection?.(terminal ? 'unavailable' : 'reconnecting')
    if (valid()) listeners.reconnect()
    if (terminal) { detach(); schedule() }
  }
  function connect() {
    if (!valid()) return
    ready = false
    highWater = -1
    seen.clear()
    const active = new EventSource(`/api/operator/conversations/${encodeURIComponent(id)}/events`)
    source = active
    const bind = (type: string, listener: EventListener) => {
      const scoped: EventListener = event => { if (source === active && valid()) listener(event) }
      bindings.push([type, scoped])
      active.addEventListener(type, scoped)
    }
    bind('open', () => {
      ready = false
      highWater = -1
      seen.clear()
      listeners.connection?.('reconnecting')
      if (valid()) listeners.reconnect()
    })
    bind('snapshot', wire => {
      const event = wire as MessageEvent<string>
      try {
        const state = OperatorConversationStateSchema.parse(JSON.parse(event.data))
        if (state.conversation.id !== id) { refresh(); return }
        ready = true
        retries = 0
        highWater = -1
        seen.clear()
        listeners.snapshot(state)
        if (valid()) listeners.connection?.('connected')
      } catch { refresh() }
    })
    for (const type of ['delta', 'message', 'state', 'error', 'activity']) bind(type, event => {
      // Transport errors lack data; provider JSON errors still belong to a live stream.
      if (!('data' in event) || typeof event.data !== 'string') { refresh(); return }
      try {
        const data = OperatorConversationStreamEventSchema.parse(JSON.parse(event.data))
        if (data.conversationId !== id) { refresh(); return }
        if (!ready) {
          if (data.type !== 'state' || data.data.snapshotRequired !== true) { refresh(); return }
          ready = true
          retries = 0
          highWater = -1
          seen.clear()
          listeners.reconnect()
          if (valid()) listeners.connection?.('connected')
          return
        }
        if (seen.has(data.id)) return
        seen.add(data.id)
        if (seen.size > 256) seen.delete(seen.values().next().value!)
        if (data.id <= highWater) { if (valid()) listeners.reconnect(); return }
        if (highWater >= 0 && data.id > highWater + 1 && valid()) listeners.reconnect()
        highWater = data.id
        if (valid()) listeners.event(data)
        if (valid()) listeners.connection?.('connected')
      } catch { refresh() }
    })
    listeners.connection?.(retries ? 'reconnecting' : 'connecting')
  }
  signal.addEventListener('abort', close, { once: true })
  if (typeof window !== 'undefined') window.addEventListener('online', schedule)
  connect()
  if (signal.aborted) close()
  return close
}
