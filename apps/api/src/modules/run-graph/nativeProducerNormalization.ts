import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { canonicalGraphJson, type NativeGraphObservation, type NativeGraphProjectionKey,
  type RunGraphScope } from '@foreman-code/contracts/wave25'
import { selectNativeGraphEvidence } from './nativeEvidence.js'
import { nativeProjectionId } from './nativeProjection.js'

/** Matches the complete-JSON bound used by graphSourceDigest, not the much
 * smaller semantic-evidence bound. Ordinary transcripts keep their raw payload. */
export const NATIVE_PRODUCER_MAX_BYTES = 8 * 1024 * 1024
export const NATIVE_PRODUCER_REJECTION_TYPE = 'graph.native.source_rejected'
export const NATIVE_PRODUCER_REJECTION_VERSION = 'br1-002/v1'

type RejectionCode = 'GRAPH_EVIDENCE_TOO_LARGE' | 'GRAPH_EVIDENCE_INVALID'
export interface NormalizedNativeProducerEvent {
  event: HarnessNativeEvent
  rejected: boolean
}

/** Negative bookkeeping only: this envelope cannot acknowledge or finish work.
 * Never copy rejected arguments, text, paths, error bodies or a JSON prefix.
 * The original source tuple and timestamp are retained, without allocating a
 * replacement connection/sequence. Invalid identities still fail schema parsing
 * at the persistence boundary; they are not repaired or guessed here. */
function rejectedEvent(input: HarnessNativeEvent, code: RejectionCode): NormalizedNativeProducerEvent {
  const identity: Record<string, unknown> = {}
  for (const key of ['executionId', 'connectionId', 'sequence', 'occurredAt'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor) continue
    if (!('value' in descriptor)) throw new Error('GRAPH_EVIDENCE_INVALID')
    if (descriptor.value !== undefined) identity[key] = descriptor.value
  }
  const event = { ...identity, type: NATIVE_PRODUCER_REJECTION_TYPE,
    payload: { normalization: NATIVE_PRODUCER_REJECTION_VERSION, code } }
  // An invalid/unbounded identity cannot be represented as an honest receipt.
  canonicalGraphJson(event, 4096)
  return { event: event as unknown as HarnessNativeEvent, rejected: true }
}

/** Match JSON's omission of optional undefined object fields without first doing
 * an unbounded stringify. Provider frames are plain structured values; reject
 * accessors, cycles and executable/custom serialization rather than invoking them.
 * The character count is a cheap lower bound; canonicalGraphJson checks exact
 * UTF-8/escape bytes after this bounded traversal. */
function nativeJson(input: unknown): unknown {
  const seen = new Set<object>()
  let nodes = 0, characters = 0
  const count = (size: number) => {
    characters += size
    if (characters > NATIVE_PRODUCER_MAX_BYTES) throw new Error('GRAPH_JSON_LIMIT')
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > 100_000) throw new Error('GRAPH_JSON_LIMIT')
    if (value === null || typeof value === 'boolean') { count(4); return value }
    if (typeof value === 'number' && Number.isFinite(value)) { count(1); return value }
    if (typeof value === 'string') { count(value.length + 2); return value }
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('GRAPH_JSON_INVALID')
    if (Object.getOwnPropertySymbols(value).length) throw new Error('GRAPH_JSON_INVALID')
    const array = Array.isArray(value), keys = Object.keys(value)
    if (keys.length > 100_000 - nodes) throw new Error('GRAPH_JSON_LIMIT')
    if (array ? keys.length !== value.length || keys.some((key, index) => key !== String(index))
        || Object.getOwnPropertyNames(value).length !== value.length + 1
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertyNames(value).length !== keys.length) throw new Error('GRAPH_JSON_INVALID')
    seen.add(value)
    count(2)
    const entries: [string, unknown][] = []
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor)) throw new Error('GRAPH_JSON_INVALID')
      if (descriptor.value === undefined && !array) continue
      count((entries.length ? 1 : 0) + (array ? 0 : key.length + 3))
      entries.push([key, visit(descriptor.value === undefined ? null : descriptor.value, depth + 1)])
    }
    seen.delete(value)
    return array ? entries.map(([, value]) => value) : Object.fromEntries(entries)
  }
  return visit(input, 0)
}

/** One stateless normalization for workflow/reviewer live callbacks, retained
 * history and the graph ingester. Call AFTER existing secret redaction and BEFORE
 * recursive schema parsing/serialization. Never modify a provider's retained
 * history object: later history must produce the same rejection envelope.
 * No outcome, session, correlation, owner or generation is inferred here. */
export function normalizeNativeProducerEvent(input: HarnessNativeEvent): NormalizedNativeProducerEvent {
  let event: HarnessNativeEvent
  try {
    event = nativeJson(input) as HarnessNativeEvent
    canonicalGraphJson(event, NATIVE_PRODUCER_MAX_BYTES)
  } catch (error) {
    return rejectedEvent(input, error instanceof Error && error.message === 'GRAPH_JSON_LIMIT'
      ? 'GRAPH_EVIDENCE_TOO_LARGE' : 'GRAPH_EVIDENCE_INVALID')
  }
  // Use the same semantic selector as ingestion. A small raw frame can still
  // contain an oversized identity/action list that projection must reject.
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return rejectedEvent(input, 'GRAPH_EVIDENCE_INVALID')
  }
  const type = typeof event.type === 'string' ? event.type.trim() : ''
  const selected = selectNativeGraphEvidence(type, event.payload)
  if (selected.kind === 'invalid') return rejectedEvent(input, selected.code)
  return { event, rejected: type === NATIVE_PRODUCER_REJECTION_TYPE
    && event.payload.normalization === NATIVE_PRODUCER_REJECTION_VERSION }
}

/** The adapter's explicit closed-transport event is a negative observation.
 * Generic idle/keepalive/history-window events cannot create or restore work. */
export function nativeDisconnectObservation(scope: RunGraphScope, work: NativeGraphProjectionKey,
  event: HarnessNativeEvent, generation: string): NativeGraphObservation | undefined {
  if (event.type !== 'transport.disconnected') return undefined
  return { scope, work, source: { sourceKind: 'native_event',
    sourceId: nativeProjectionId('native', event.executionId, event.connectionId ?? null, event.sequence), sourceRevision: '0' },
    sourceStreamId: nativeProjectionId('stream', event.executionId, event.connectionId ?? null),
    sourcePosition: String(event.sequence), connectionGeneration: generation,
    observedAt: event.occurredAt, kind: 'transport', transport: 'closed' }
}
