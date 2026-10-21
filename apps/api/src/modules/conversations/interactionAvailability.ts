import type { NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import { NativeInteractionResponseAvailabilitySchema, type NativeInteractionResponseAvailability } from '@foreman-code/contracts/interaction-activity'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { inspectNativeResponse, pendingResponseQuery, type ResponseAvailabilityInspector } from '../harnesses/responseAvailability.js'

const messages: Record<NativeInteractionResponseAvailability['reason'], string> = {
  live_callback: 'The exact current native request can be answered.',
  qualified_recovery: 'The provider has qualified recovery for this exact native request.',
  request_consumed: 'This native request is no longer pending. Reload the conversation for its recorded outcome.',
  callback_lost: 'The original native callback is unavailable. Reconcile the conversation before responding; do not resubmit the answer.',
  session_closed: 'The owning native session is no longer live. Reload or reconcile this conversation; do not start replacement work to answer it.',
  unqualified: 'This provider has not qualified response delivery for the current native request.',
  identity_mismatch: 'The current native request no longer matches this readback. Reload the conversation before responding.',
  response_in_flight: 'A response is submitted or uncertain. Reconcile its recorded outcome; do not send the answer again.',
  unsupported: 'This provider cannot inspect the exact request safely. Response availability is unqualified.',
  unauthorized: 'Your current grants do not allow responding to this interaction.',
  missing_request_identity: 'The persisted interaction has no exact native request identity. Reconcile it before responding.',
}
export interface CurrentResponseRuntime {
  manager: NativeHarnessSessionManager & ResponseAvailabilityInspector
  session: NativeSessionReference
}
export async function nativeInteractionAvailability(pending: PendingNativeInteraction, authorized: boolean,
  runtime: CurrentResponseRuntime | undefined, input: { signal?: AbortSignal; isCurrent(): boolean }): Promise<NativeInteractionResponseAvailability> {
  const base = { nativeSessionId: pending.session.nativeSessionId, nativeRequestType: pending.nativeRequestType,
    ...(pending.turn.nativeRequestId ? { nativeRequestId: pending.turn.nativeRequestId } : {}), nativeTurnId: pending.turn.nativeTurnId }
  const unavailable = (reason: NativeInteractionResponseAvailability['reason'], status: 'unavailable' | 'recovery_required' = 'unavailable') =>
    NativeInteractionResponseAvailabilitySchema.parse({ ...base, available: false, status, path: null, reason, message: messages[reason] })
  if (!authorized) return unavailable('unauthorized')
  const query = pendingResponseQuery(pending)
  if (!query) return unavailable('missing_request_identity')
  if (!runtime) return unavailable('callback_lost', 'recovery_required')
  if (runtime.session.nativeSessionId !== pending.session.nativeSessionId || runtime.session.harness !== pending.session.harness
    || runtime.session.providerVersion !== pending.session.providerVersion) return unavailable('identity_mismatch')
  const response = await inspectNativeResponse(runtime.manager, runtime.session, query, input)
  if (pending.session.harness === 'claude' && response.state === 'available') {
    const request = pending.request
    const generation = request && typeof request === 'object' && !Array.isArray(request) && typeof request.generation === 'string' ? request.generation : undefined
    if (!pending.turn.nativeMessageId || !generation) return unavailable('unqualified')
    if (response.generation !== generation) return unavailable('identity_mismatch')
  }
  return NativeInteractionResponseAvailabilitySchema.parse({ ...base, available: response.state === 'available', status: response.state,
    path: response.state === 'available' ? response.path : null, ...(response.generation ? { generation: response.generation } : {}),
    reason: response.reason, message: messages[response.reason] })
}
