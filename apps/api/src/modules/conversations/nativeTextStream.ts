import { TextTruncationSchema } from '@foreman-code/contracts/activity-text'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { ActivityTextIdentity, ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { completedNativeAssistantMessage, nativeAssistantText } from './operatorText.js'
import { createTextCoalescer, TEXT_STREAM_LIMITS } from './textCoalescer.js'

/** The same normalization/coalescing path for admitted Operator, Agent and execution owners.
 * Call before() before publishing nontext transitions, push() only after canonical persistence.
 * Authorization/redaction stays with the owning service. Unknown native item identity requests readback. */
export function createNativeTextStream(input: {
  owner: () => Omit<ActivityTextIdentity, 'itemId' | 'partId' | 'parentId' | 'channel'>
  harness: 'codex' | 'claude'
  signal?: AbortSignal
  publish(operation: ActivityTextOperation): void
  reconcile(): void
}) {
  const parents = new Map<string, string>()
  const stream = createTextCoalescer(input.publish, input.reconcile)
  let disposed = false
  const dispose = () => {
    disposed = true
    parents.clear()
    stream.dispose()
    input.signal?.removeEventListener('abort', dispose)
  }
  input.signal?.addEventListener('abort', dispose, { once: true })
  if (input.signal?.aborted) dispose()

  return {
    before(event: NativeHarnessEvent) {
      if (disposed) return
      // Inspection must not consume/deduplicate the event before its canonical commit.
      const deltas = nativeAssistantText(event)
      if (!deltas.length || deltas.some((delta) => delta.mode !== 'append')) stream.flush()
    },
    push(event: NativeHarnessEvent) {
      if (disposed) return
      for (const operation of normalizeNativeTextOperations(event, { ...input, parents })) {
        if (operation) stream.push(operation)
        else { stream.flush(); if (!disposed) input.reconcile() }
      }
    },
    rejected(event: NativeHarnessEvent) {
      if (disposed) return
      for (const operation of normalizeNativeTextOperations(event, { ...input, parents })) if (operation?.final) stream.seal(operation)
      if (!disposed) input.reconcile()
    },
    flush: stream.flush,
    dispose,
  }
}

export function normalizeNativeTextOperations(event: NativeHarnessEvent, input: {
  harness: 'codex' | 'claude'; owner: () => Omit<ActivityTextIdentity, 'itemId' | 'partId' | 'parentId' | 'channel'>
  parents: Map<string, string>
}): Array<ActivityTextOperation | undefined> {
  const { parents } = input
  const deltas = nativeAssistantText(event)
  const completed = completedNativeAssistantMessage(event, input.harness)
  return deltas.map((delta): ActivityTextOperation | undefined => {
    const payload = event.payload
    const truncation = TextTruncationSchema.optional().parse(payload.truncation)
    const item = payload.item && typeof payload.item === 'object' ? payload.item as Record<string, unknown> : {}
    const nativeItemId = payload.itemId ?? item.id
    if (typeof nativeItemId !== 'string' || !nativeItemId) return undefined
    if (!parents.has(nativeItemId) && typeof payload.messageId === 'string' && parents.size >= TEXT_STREAM_LIMITS.items) return undefined
    if (event.type === 'claude.text' && typeof payload.messageId === 'string') parents.set(nativeItemId, payload.messageId)
    const parentId = parents.get(nativeItemId)
    const source = payload.source && typeof payload.source === 'object' ? payload.source as Record<string, unknown> : {}
    const eventId = typeof source.eventId === 'string' ? source.eventId : undefined
    const nativeSequence = typeof source.sequence === 'string' ? source.sequence : undefined
    const index = payload.summaryIndex ?? payload.contentIndex
    const partId = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? String(index) : undefined
    return { observedAt: event.occurredAt, identity: { ...input.owner(), ...(typeof payload.nativeSessionId === 'string' ? { sessionId: payload.nativeSessionId } : {}),
      ...(typeof payload.nativeTurnId === 'string' ? { turnId: payload.nativeTurnId } : {}), ...(typeof payload.nativeGeneration === 'string' ? { generation: payload.nativeGeneration } : {}), itemId: nativeItemId, ...(partId ? { partId } : {}),
      ...(parentId ? { parentId } : {}), channel: delta.partId.startsWith('thinking:') ? 'reasoning' : 'assistant' },
    ...(truncation ? { truncation } : {}), mode: delta.mode, text: delta.text, final: !!completed && completed.complete !== false,
    ...(event.connectionId || eventId || nativeSequence ? { source: {
      ...(event.connectionId ? { connectionId: event.connectionId, sequence: event.sequence } : {}),
      ...(eventId ? { eventId } : {}), ...(nativeSequence ? { nativeSequence } : {}),
    } } : {}) }
  })
}
