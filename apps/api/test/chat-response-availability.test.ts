import { expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { nativeInteractionAvailability } from '../src/modules/conversations/interactionAvailability.js'
const interaction = NATIVE_INTERACTION_FIXTURES.codex
const pending: PendingNativeInteraction = { session: { harness: interaction.harness, nativeSessionId: interaction.nativeSessionId,
  providerVersion: interaction.providerVersion }, turn: { nativeTurnId: 'turn', nativeRequestId: interaction.nativeRequestId },
  nativeRequestType: interaction.nativeRequestType, request: interaction.request, responseOptions: interaction.responseOptions }
it('shows actionable restart unavailability without probing/attaching replacement work', async () => {
  const unavailable = await nativeInteractionAvailability(pending, true, undefined, { isCurrent: () => true })
  expect(unavailable).toMatchObject({ available: false, status: 'recovery_required', reason: 'callback_lost', path: null })
  expect(unavailable.message).toContain('do not resubmit')
})
it('requires exact qualified live identity and response permission independently of pending state', async () => {
  const inspect = vi.fn(async () => ({ nativeSessionId: pending.session.nativeSessionId, nativeRequestId: interaction.nativeRequestId,
    nativeRequestType: pending.nativeRequestType, nativeTurnId: pending.turn.nativeTurnId, generation: 'current', qualified: true,
    state: 'available' as const, path: 'live_callback' as const, reason: 'live_callback' as const }))
  const manager = { inspectResponseAvailability: inspect } as unknown as NativeHarnessSessionManager
  const runtime = { manager, session: pending.session }
  expect((await nativeInteractionAvailability(pending, false, runtime, { isCurrent: () => true })).reason).toBe('unauthorized')
  expect(inspect).not.toHaveBeenCalled()
  expect((await nativeInteractionAvailability(pending, true, runtime, { isCurrent: () => true })).available).toBe(true)
  expect((await nativeInteractionAvailability(pending, true, runtime, { isCurrent: () => false })).available).toBe(false)
  expect((await nativeInteractionAvailability({ ...pending, turn: { nativeTurnId: 'turn' } }, true, runtime,
    { isCurrent: () => true })).reason).toBe('missing_request_identity')
})
it('requires the exact observed Claude callback message and generation for a persisted pending message', async () => {
  const pendingMessage: PendingNativeInteraction = { ...pending, session: { ...pending.session, harness: 'claude' },
    turn: { nativeMessageId: 'message-A', nativeRequestId: 'request' }, nativeRequestType: 'can_use_tool', request: { generation: 'generation-A' } }
  let generation = 'generation-A'
  let nativeMessageId: string | undefined = 'message-A'
  const inspect = vi.fn(async () => ({ nativeSessionId: pendingMessage.session.nativeSessionId, nativeRequestId: 'request',
    nativeRequestType: 'can_use_tool', ...(nativeMessageId !== undefined ? { nativeMessageId } : {}), generation, qualified: true, state: 'available' as const, path: 'live_callback' as const, reason: 'live_callback' as const }))
  const runtime = { manager: { inspectResponseAvailability: inspect } as unknown as NativeHarnessSessionManager, session: pendingMessage.session }
  expect((await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => true })).available).toBe(true)
  expect(inspect).toHaveBeenCalledWith(pendingMessage.session, { nativeRequestId: 'request', nativeRequestType: 'can_use_tool',
    expectedNativeMessageId: 'message-A', expectedGeneration: 'generation-A' }, undefined)
  nativeMessageId = undefined
  expect(await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => true })).toMatchObject({ available: false, reason: 'identity_mismatch' })
  nativeMessageId = 'message-B'
  expect(await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => true })).toMatchObject({ available: false, reason: 'identity_mismatch' })
  nativeMessageId = 'message-A'
  generation = 'generation-B'
  expect((await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => true }))).toMatchObject({ available: false, reason: 'identity_mismatch' })
  expect((await nativeInteractionAvailability({ ...pendingMessage, request: {} }, true, runtime, { isCurrent: () => true }))).toMatchObject({ available: false, reason: 'unqualified' })
  generation = 'generation-A'
  const callsBeforeDenied = inspect.mock.calls.length
  expect(await nativeInteractionAvailability(pendingMessage, false, runtime, { isCurrent: () => true })).toMatchObject({ available: false, reason: 'unauthorized' })
  expect(await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => false })).toMatchObject({ available: false, reason: 'session_closed' })
  const aborted = new AbortController(); aborted.abort()
  expect(await nativeInteractionAvailability(pendingMessage, true, runtime, { isCurrent: () => true, signal: aborted.signal })).toMatchObject({ available: false, reason: 'session_closed' })
  expect(inspect.mock.calls.length).toBe(callsBeforeDenied)
})
