import { expect, it, vi } from 'vitest'
import { PendingNativeInteractionSchema } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { inspectNativeResponse, pendingResponseQuery, type NativeResponseAvailability, type ResponseAvailabilityInspector } from '../src/modules/harnesses/responseAvailability.js'
const session = { harness: 'codex' as const, providerVersion: 'pinned', nativeSessionId: 'session' }
const query = { nativeRequestId: 'request', nativeRequestType: 'approval', expectedNativeTurnId: 'turn' }
const live: NativeResponseAvailability = { nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'approval',
  nativeTurnId: 'turn', generation: 'generation-one', qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }
function manager(result: NativeResponseAvailability) {
  return { inspectResponseAvailability: vi.fn(async () => result), pending: vi.fn(() => { throw new Error('Inspection must not auto reply') }),
    respond: vi.fn(), attachSession: vi.fn(), startTurn: vi.fn() } as unknown as NativeHarnessSessionManager & ResponseAvailabilityInspector
}
it('requires exact positive current callback identity and performs no other native operation', async () => {
  const native = manager(live)
  expect(await inspectNativeResponse(native, session, query, { isCurrent: () => true })).toEqual(live)
  expect(native.inspectResponseAvailability).toHaveBeenCalledTimes(1)
  expect(native.pending).not.toHaveBeenCalled()
  expect(native.respond).not.toHaveBeenCalled()
  expect(native.attachSession).not.toHaveBeenCalled()
  expect(native.startTurn).not.toHaveBeenCalled()
  for (const mismatch of [{ nativeSessionId: 'other' }, { nativeRequestId: 'predecessor' }, { nativeTurnId: 'old-turn' },
    { qualified: false }, { generation: '' }, { path: null }]) {
    expect((await inspectNativeResponse(manager({ ...live, ...mismatch }), session, query, { isCurrent: () => true })).state).toBe('unavailable')
  }
})
it('fences a callback disposed while inspection was in flight and treats restart absence explicitly unavailable', async () => {
  let current = true
  const native = manager(live)
  native.inspectResponseAvailability = vi.fn(async () => { current = false; return live })
  expect((await inspectNativeResponse(native, session, query, { isCurrent: () => current })).reason).toBe('session_closed')
  const absent = {} as NativeHarnessSessionManager
  expect((await inspectNativeResponse(absent, session, query, { isCurrent: () => true })).reason).toBe('unsupported')
  expect((await inspectNativeResponse(manager({ ...live, state: 'recovery_required', path: null, reason: 'callback_lost' }), session, query,
    { isCurrent: () => true })).state).toBe('recovery_required')
})

it('fences message callbacks with the original pending message and generation', async () => {
  const pending = PendingNativeInteractionSchema.parse({ session: { ...session, harness: 'claude' },
    turn: { nativeMessageId: 'original-message', nativeRequestId: 'request' }, nativeRequestType: 'approval',
    request: { generation: 'original-generation' }, responseOptions: [{ optionId: 'allow', label: 'Allow', semantic: 'approve_once',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }] })
  const expected = pendingResponseQuery(pending)!
  expect(expected).toEqual({ nativeRequestId: 'request', nativeRequestType: 'approval',
    expectedNativeMessageId: 'original-message', expectedGeneration: 'original-generation' })
  const callback: NativeResponseAvailability = { ...live, nativeMessageId: 'original-message', generation: 'original-generation' }
  delete callback.nativeTurnId
  expect((await inspectNativeResponse(manager(callback), pending.session, expected, { isCurrent: () => true })).state).toBe('available')
  const missingMessage = { ...callback }, missingGeneration = { ...callback }
  delete missingMessage.nativeMessageId; delete missingGeneration.generation
  for (const mismatch of [{ ...callback, nativeMessageId: 'later-message' }, missingMessage,
    { ...callback, generation: 'later-generation' }, missingGeneration]) {
    expect((await inspectNativeResponse(manager(mismatch), pending.session, expected,
      { isCurrent: () => true })).reason).toBe('identity_mismatch')
  }
})
