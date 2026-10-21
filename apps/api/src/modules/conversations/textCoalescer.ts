import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

export const TEXT_STREAM_LIMITS = { bytes: 64 * 1024, items: 1024, latencyMs: 50 } as const
const keyOf = (operation: ActivityTextOperation) => canonicalJson(operation.identity)

/** Request-owned presentation buffer. Persistence must precede push(final) and every barrier.
 * Unknown source order is delivered separately; it is never assigned a synthetic sequence. */
export function createTextCoalescer(publish: (operation: ActivityTextOperation) => void,
  reconcile: () => void, limits: { bytes: number; items: number; latencyMs: number } = TEXT_STREAM_LIMITS) {
  if (limits.bytes < 1 || limits.items < 1 || limits.latencyMs < 1) throw new Error('Text stream limits must be positive.')
  const states = new Map<string, { final: boolean; connectionId: string | undefined; sequence: number | undefined }>()
  const seen = new Set<string>()
  let pending: ActivityTextOperation | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  const flush = () => {
    clearTimeout(timer); timer = undefined
    const operation = pending; pending = undefined
    if (!disposed && operation) publish(operation)
  }
  const push = (operation: ActivityTextOperation) => {
    if (disposed) return
    const key = keyOf(operation), previous = states.get(key)
    if (Buffer.byteLength(key) > limits.bytes) { flush(); if (!disposed) reconcile(); return }
    if (previous?.final) return
    const eventKey = operation.source?.eventId ? JSON.stringify([key, operation.source.eventId]) : undefined
    if (eventKey && Buffer.byteLength(eventKey) > limits.bytes) { flush(); if (!disposed) reconcile(); return }
    if (eventKey && seen.has(eventKey)) return
    if (eventKey && seen.size >= limits.items && operation.mode === 'append') { flush(); if (!disposed) reconcile(); return }
    if (eventKey && seen.size < limits.items) seen.add(eventKey)
    if (!previous && states.size >= limits.items) { flush(); if (!disposed) reconcile(); return }
    if (operation.source?.connectionId && operation.source.sequence !== undefined && previous?.connectionId === operation.source.connectionId
      && previous.sequence !== undefined && operation.source.sequence <= previous.sequence) return
    // Across a connection change, final snapshots remain authoritative; provisional deltas need readback.
    if (previous?.connectionId && operation.source && previous.connectionId !== operation.source.connectionId && operation.mode === 'append') {
      flush(); if (!disposed) reconcile(); return
    }
    states.set(key, { final: operation.final, connectionId: operation.source?.connectionId, sequence: operation.source?.sequence })
    const bytes = Buffer.byteLength(JSON.stringify(operation))
    if (operation.mode === 'replace' || operation.final || !operation.source?.connectionId || operation.source.sequence === undefined || bytes > limits.bytes) {
      flush(); if (!disposed) publish(operation); return
    }
    const compatible = pending && keyOf(pending) === key && pending.mode === 'append'
      && pending.source?.connectionId === operation.source.connectionId
      && pending.source.sequence !== undefined && pending.source.sequence + 1 === operation.source.sequence
      && Buffer.byteLength(JSON.stringify({ ...operation, text: pending.text + operation.text })) <= limits.bytes
    if (!compatible) flush()
    if (disposed) return
    pending = compatible ? { ...operation, text: pending!.text + operation.text } : operation
    timer ??= setTimeout(flush, limits.latencyMs)
  }
  return { push, flush, seal(operation: ActivityTextOperation) {
    if (disposed) return
    const key = keyOf(operation), previous = states.get(key)
    if (Buffer.byteLength(key) > limits.bytes) { reconcile(); return }
    if (previous || states.size < limits.items) states.set(key, { final: true, connectionId: previous?.connectionId, sequence: previous?.sequence })
    else reconcile()
  }, dispose() { disposed = true; clearTimeout(timer); timer = undefined; pending = undefined; states.clear(); seen.clear() } }
}
