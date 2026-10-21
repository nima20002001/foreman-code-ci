import type { PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'

/** Native pending-list absence after restart is callback absence, never a response receipt. */
export function pendingInteractionAfterHistory(previous: PendingNativeInteraction | null | undefined,
  history: NativeHistory): PendingNativeInteraction | undefined {
  const pending = history.pendingInteraction ?? history.pendingInteractions[0]
  if (pending) return pending
  if (!previous || history.terminalResult) return undefined
  const requestId = previous.turn.nativeRequestId
  if (requestId && history.canceledRequestIds?.includes(requestId)) return undefined
  const proofs = (history.responseDeliveries ?? []).filter((proof) => proof.nativeSessionId === previous.session.nativeSessionId
    && proof.nativeRequestId === requestId)
  if (proofs.length && proofs.every((proof) => (proof.source === 'provider_acknowledgement' || proof.source === 'provider_history')
    && proof.harness === previous.session.harness && proof.providerVersion === previous.session.providerVersion
    && proof.nativeRequestType === previous.nativeRequestType
    && previous.responseOptions.some((option) => option.optionId === proof.optionId && option.semantic === proof.semantic))) return undefined
  return previous
}
