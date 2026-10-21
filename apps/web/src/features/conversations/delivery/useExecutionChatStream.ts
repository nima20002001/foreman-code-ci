import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { EngineChatReadback } from '@foreman-code/contracts'
import { createStreamReadback } from '../../../shared/api/streamReadback'
import { sessionSignal } from '../../../shared/api/sessionBoundary'
import { isApiAccessError } from '../../../shared/api/accessError'
import { boundedNativeWindow } from './nativeMessageWindow'
import { sameDeliveryTarget } from '../../workflow-chat/draft'
import { executionChatNoticeSchema, messageBelongsToExecution, type ExecutionChatSource, type ExecutionChatTarget,
  type ExecutionChatNotice } from './executionChatSource'

export function useExecutionChatStream(target: ExecutionChatTarget, source: ExecutionChatSource,
  key: readonly unknown[], enabled: boolean, onDenied: (error: Error) => void) {
  const cache = useQueryClient()
  const [historyReady, setHistoryReady] = useState(true)
  const requestReadback = useRef<() => void>(() => {})
  useEffect(() => {
    if (!enabled) return
    let disposed = false, buffered: ExecutionChatNotice[] = [], timer: ReturnType<typeof setTimeout> | undefined
    let seen = -1
    const controller = new AbortController(), identitySignal = sessionSignal()
    const abort = () => controller.abort()
    identitySignal.addEventListener('abort', abort, { once: true })
    const readback = createStreamReadback(async () => {
      if (disposed) return
      await cache.cancelQueries({ queryKey: key, exact: true })
      if (!disposed) await cache.refetchQueries({ queryKey: key, exact: true })
      if (!disposed) {
        if (cache.getQueryState(key)?.status === 'success') setHistoryReady(true)
        void cache.invalidateQueries({ queryKey: ['chat-delivery-inputs', key[1], key[2]] })
        void cache.invalidateQueries({ queryKey: ['chat-delivery-receipt', key[1], key[2]] })
      }
    })
    requestReadback.current = readback.request
    const flush = () => {
      clearTimeout(timer); timer = undefined
      const events = buffered; buffered = []
      if (disposed) return
      cache.setQueryData<EngineChatReadback>(key, previous => {
        if (!previous || !('messages' in previous)) { readback.request(); return previous }
        const messages = new Map(previous.messages.map(message => [message.id, message]))
        let revision = previous.revision
        for (const event of events) {
          const message = event.message
          if (!message || event.revision < previous.revision || !messageBelongsToExecution(message, target)) continue
          const prior = messages.get(message.id)
          if (prior && (message.revision === undefined || prior.revision !== undefined && BigInt(message.revision) <= BigInt(prior.revision)
            || prior.nativeMessageComplete && !message.nativeMessageComplete)) continue
          messages.set(message.id, message)
          revision = Math.max(revision, event.revision)
        }
        const window = boundedNativeWindow([...messages.values()])
        if (!window) { readback.request(); return previous }
        // An opaque cursor belongs to the authoritative page, never to our locally evicted rows.
        if (window.omitted) { setHistoryReady(false); readback.request() }
        return { ...previous, revision, messages: window.messages, hasMore: previous.hasMore || window.omitted }
      })
    }
    const close = source.subscribe(target, input => {
      const parsed = executionChatNoticeSchema.safeParse(input)
      if (disposed || controller.signal.aborted) return
      if (!parsed.success || !sameDeliveryTarget(parsed.data.target, target)) { buffered = []; readback.request(); return }
      const event = parsed.data
      const sequence = event.sequence ?? event.revision
      if (event.snapshotRequired || !event.message || seen >= 0 && sequence > seen + 1
        || !messageBelongsToExecution(event.message, target) || event.message.revision === undefined
        || event.message.sequence === undefined
        || new TextEncoder().encode(JSON.stringify(event)).byteLength > 64 * 1024) {
        buffered = []; readback.request(); seen = Math.max(seen, sequence); return
      }
      seen = Math.max(seen, sequence)
      buffered.push(event)
      if (buffered.length > 100 || new TextEncoder().encode(JSON.stringify(buffered)).byteLength > 256 * 1024) { buffered = []; readback.request(); return }
      timer ??= setTimeout(flush, 100)
    }, { signal: controller.signal, reconnect: () => { buffered = []; seen = -1; readback.request() },
      error: error => {
        if (disposed) return
        buffered = []; clearTimeout(timer); timer = undefined
        if (isApiAccessError(error)) {
          disposed = true; controller.abort(); readback.dispose(); onDenied(error)
        } else readback.request()
      } })
    if (!disposed) readback.request()
    return () => { disposed = true; requestReadback.current = () => {}; clearTimeout(timer); buffered = []; readback.dispose(); close(); controller.abort(); identitySignal.removeEventListener('abort', abort) }
  }, [cache, enabled, key, onDenied, source, target])
  return { historyReady, refresh: () => requestReadback.current() }
}
