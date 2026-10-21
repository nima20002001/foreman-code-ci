import { expect, it } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type PendingNativeInteraction } from '@foreman-code/contracts'
import { pendingInteractionAfterHistory } from '../src/modules/conversations/pendingInteractionReadback.js'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
const source = NATIVE_INTERACTION_FIXTURES.codex
const pending: PendingNativeInteraction = { session: { harness: source.harness, providerVersion: source.providerVersion,
  nativeSessionId: source.nativeSessionId }, turn: { nativeTurnId: 'turn', nativeRequestId: source.nativeRequestId },
  nativeRequestType: source.nativeRequestType, request: source.request, responseOptions: source.responseOptions }
const empty: NativeHistory = { events: [], pendingInteractions: [] }
it('retains durable pending provenance after callback loss or empty history and clears only exact positive disposition', () => {
  expect(pendingInteractionAfterHistory(pending, empty)).toEqual(pending)
  expect(pendingInteractionAfterHistory(pending, { ...empty, canceledRequestIds: ['predecessor'] })).toEqual(pending)
  expect(pendingInteractionAfterHistory(pending, { ...empty, canceledRequestIds: [source.nativeRequestId] })).toBeUndefined()
  const option = source.responseOptions[0]!
  const proof = { source: 'provider_acknowledgement' as const, harness: source.harness, providerVersion: source.providerVersion,
    nativeSessionId: source.nativeSessionId, nativeRequestId: source.nativeRequestId, nativeRequestType: source.nativeRequestType,
    optionId: option.optionId, semantic: option.semantic }
  expect(pendingInteractionAfterHistory(pending, { ...empty, responseDeliveries: [proof] })).toBeUndefined()
  expect(pendingInteractionAfterHistory(pending, { ...empty, responseDeliveries: [{ ...proof, nativeSessionId: 'different' }] })).toEqual(pending)
  expect(pendingInteractionAfterHistory(pending, { ...empty, responseDeliveries: [{ ...proof, optionId: 'unoffered' }] })).toEqual(pending)
  expect(pendingInteractionAfterHistory(pending, { ...empty, terminalResult: { outcome: 'canceled' } })).toBeUndefined()
})
