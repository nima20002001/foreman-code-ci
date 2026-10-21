import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'

import type { NativeResponseAvailability, NativeResponseAvailabilityQuery }
  from '@foreman-code/contracts/remote-execution-rpc'
export type { NativeResponseAvailability, NativeResponseAvailabilityQuery }
  from '@foreman-code/contracts/remote-execution-rpc'

/** Read-only inspection must not attach, start, auto-reply or reconcile a response. */
export interface ResponseAvailabilityInspector {
  inspectResponseAvailability?(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
    signal?: AbortSignal): Promise<NativeResponseAvailability>
}

export function unavailableNativeResponse(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
  reason: NativeResponseAvailability['reason'] = 'callback_lost'): NativeResponseAvailability {
  return { nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
    nativeRequestType: query.nativeRequestType, ...(query.expectedNativeTurnId ? { nativeTurnId: query.expectedNativeTurnId } : {}),
    qualified: false, state: 'unavailable', path: null, reason }
}

/** A persistence row is provenance, not proof of an available callback. Missing inspectors fail closed. */
export async function inspectNativeResponse(manager: ResponseAvailabilityInspector,
  session: NativeSessionReference, query: NativeResponseAvailabilityQuery, input: { signal?: AbortSignal; isCurrent(): boolean }): Promise<NativeResponseAvailability> {
  if (!input.isCurrent() || input.signal?.aborted) return unavailableNativeResponse(session, query, 'session_closed')
  if (!manager.inspectResponseAvailability) return unavailableNativeResponse(session, query, 'unsupported')
  let result: NativeResponseAvailability
  try { result = await manager.inspectResponseAvailability(session, query, input.signal) }
  catch (error) {
    logIgnoredError('harness', 'inspect native response availability', error)
    return unavailableNativeResponse(session, query, 'callback_lost')
  }
  if (!input.isCurrent() || input.signal?.aborted) return unavailableNativeResponse(session, query, 'session_closed')
  return normalizeResponseAvailability(session, query, result)
}

export function normalizeResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
  result: NativeResponseAvailability): NativeResponseAvailability {
  if (result.nativeSessionId !== session.nativeSessionId || result.nativeRequestId !== query.nativeRequestId
    || result.nativeRequestType !== query.nativeRequestType
    || query.expectedNativeTurnId !== undefined && result.nativeTurnId !== query.expectedNativeTurnId
    || query.expectedNativeMessageId !== undefined && result.nativeMessageId !== query.expectedNativeMessageId
    || query.expectedGeneration !== undefined && result.generation !== query.expectedGeneration) {
    return unavailableNativeResponse(session, query, 'identity_mismatch')
  }
  if (result.state === 'available' && (!result.qualified || !result.generation || !result.path
    || result.reason !== result.path)) {
    return unavailableNativeResponse(session, query, 'unqualified')
  }
  return result
}

export function pendingResponseQuery(pending: PendingNativeInteraction): NativeResponseAvailabilityQuery | undefined {
  if (!pending.turn.nativeRequestId) return undefined
  const generation = pending.session.harness === 'claude' && pending.request && typeof pending.request === 'object'
    && !Array.isArray(pending.request) && typeof pending.request.generation === 'string' && pending.request.generation.length
    ? pending.request.generation : undefined
  return { nativeRequestId: pending.turn.nativeRequestId, nativeRequestType: pending.nativeRequestType,
    ...(pending.turn.nativeTurnId ? { expectedNativeTurnId: pending.turn.nativeTurnId } : {}),
    ...(pending.turn.nativeMessageId ? { expectedNativeMessageId: pending.turn.nativeMessageId } : {}),
    ...(generation ? { expectedGeneration: generation } : {}) }
}
