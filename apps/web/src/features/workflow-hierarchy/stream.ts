import { WorkflowHierarchyChangeSchema } from '@foreman-code/contracts'
import { assertSession, sessionGeneration, sessionSignal, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { hierarchyPath } from './client'

export function subscribeHierarchy(scope: { workspaceId: string; workflowId: string; runId: string },
  listeners: { changed(): void; unavailable(): void; connection(connected: boolean): void }): () => void {
  if (sessionIsSwitching() || typeof EventSource === 'undefined') return () => {}
  const generation = sessionGeneration(), signal = sessionSignal()
  const source = new EventSource(`${hierarchyPath(scope)}/events?${new URLSearchParams({ runId: scope.runId })}`)
  let closed = false, cursor: string | undefined
  const valid = () => { try { assertSession(generation); return !closed && !signal.aborted } catch { return false } }
  const close = () => { closed = true; source.close(); signal.removeEventListener('abort', close) }
  const receive = (wire: MessageEvent<string>) => {
    if (!valid()) return
    try {
      const event = WorkflowHierarchyChangeSchema.parse(JSON.parse(wire.data))
      if (event.runId !== scope.runId) throw new Error('Report scope changed')
      if (event.cursor !== cursor) { cursor = event.cursor; listeners.changed() }
      listeners.connection(true)
    } catch { listeners.connection(false); listeners.changed() }
  }
  source.addEventListener('changed', receive)
  source.addEventListener('open', () => { if (valid()) { listeners.connection(true); listeners.changed() } })
  source.addEventListener('error', () => { if (valid()) listeners.connection(false) })
  source.addEventListener('unavailable', () => {
    if (!valid()) return
    close()
    listeners.connection(false)
    listeners.unavailable()
  })
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return close
}
