import { assertSession, sessionGeneration, sessionSignal } from '../../shared/api/sessionBoundary'
import { workflowChatEventSchema, workflowChatRoot, type WorkflowChatEvent, type WorkflowChatScope } from './client'

export function subscribeWorkflowChat(scope: WorkflowChatScope, listeners: {
  event(event: WorkflowChatEvent): void
  reconnect(): void
  connection(state: 'connected' | 'reconnecting' | 'unavailable'): void
}): () => void {
  if (typeof EventSource === 'undefined') { listeners.connection('unavailable'); return () => {} }
  const generation = sessionGeneration(), signal = sessionSignal()
  const source = new EventSource(`${workflowChatRoot(scope)}/events`)
  let closed = false
  const valid = () => {
    try { assertSession(generation); return !closed && !signal.aborted }
    catch { return false /* ignore: session replacement closes this subscription. */ }
  }
  const receive = (event: Event) => {
    if (!valid()) return
    try {
      if (!('data' in event) || typeof event.data !== 'string') throw new Error('Missing event data')
      listeners.event(workflowChatEventSchema.parse(JSON.parse(event.data)))
    } catch { listeners.reconnect() }
  }
  const open = () => { if (valid()) { listeners.connection('connected'); listeners.reconnect() } }
  const error = () => { if (valid()) { listeners.connection('reconnecting'); listeners.reconnect() } }
  source.addEventListener('open', open)
  source.addEventListener('error', error)
  for (const name of ['message', 'post', 'receipt', 'change']) source.addEventListener(name, receive)
  const close = () => {
    closed = true; source.close(); signal.removeEventListener('abort', close)
    source.removeEventListener('open', open); source.removeEventListener('error', error)
    for (const name of ['message', 'post', 'receipt', 'change']) source.removeEventListener(name, receive)
  }
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return close
}
