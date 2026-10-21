import { expect, it } from 'vitest'
import { activitySnapshotFixtures } from '@foreman-code/contracts'
import { qualifyChatActivity } from '../src/modules/conversations/qualifiedActivity.js'
import type { NativeInteractionResponseAvailability } from '@foreman-code/contracts/interaction-activity'
import { chatInteractionSummary } from '../src/modules/conversations/activityItems.js'
it('preserves a Claude pending message generation and rejects availability from its successor', () => {
  const base = structuredClone(activitySnapshotFixtures.activeBeforeNewerQueued)
  const pendingInteractions = chatInteractionSummary({ conversationId: 'conversation', requestId: 'A', revision: '7', pending: {
    session: { harness: 'claude', providerVersion: 'version', nativeSessionId: 'session' },
    turn: { nativeMessageId: 'message-A', nativeRequestId: 'request' }, nativeRequestType: 'can_use_tool',
    request: { generation: 'generation-A' }, responseOptions: [{ optionId: 'approve', label: 'Approve', semantic: 'approve_once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
  } })
  expect(pendingInteractions[0]?.native).toEqual({ harness: 'claude', sessionId: 'session', messageId: 'message-A', generation: 'generation-A', requestId: 'request' })
  const response: NativeInteractionResponseAvailability = { nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'can_use_tool',
    generation: 'generation-A', available: true, status: 'available', path: 'live_callback', reason: 'live_callback', message: 'Available.' }
  const snapshot = { ...base, pendingInteractions }
  expect(qualifyChatActivity(snapshot, response).pendingInteractions[0]?.responseAvailability).toBe('available')
  expect(qualifyChatActivity(snapshot, { ...response, generation: 'generation-B' }).pendingInteractions[0]?.responseAvailability).toBe('unavailable')
  expect(qualifyChatActivity(snapshot, { ...response, generation: undefined }).pendingInteractions[0]?.responseAvailability).toBe('unavailable')
})
it('qualifies only the exact pending owner and preserves independent recorded evidence', () => {
  const base = structuredClone(activitySnapshotFixtures.activeBeforeNewerQueued)
  const pending = { id: 'persisted-native-source', revision: '7', owner: base.active[0]!.ref,
    native: { harness: 'codex', sessionId: 'session', turnId: 'turn', requestId: 'native-request' },
    delivery: 'pending' as const, answerRecorded: false, providerAcknowledged: false, workerAcknowledged: false,
    responseAvailability: 'unknown' as const }
  const snapshot = { ...base, pendingInteractions: [pending] }
  const response: NativeInteractionResponseAvailability = { nativeSessionId: 'session', nativeTurnId: 'turn',
    nativeRequestId: 'native-request', nativeRequestType: 'approval', available: true, status: 'available', path: 'live_callback',
    generation: 'current', reason: 'live_callback', message: 'Available.' }
  const qualified = qualifyChatActivity(snapshot, response)
  expect(qualified.pendingInteractions[0]).toEqual({ ...pending, responseAvailability: 'available' })
  expect(qualified.active).toEqual(base.active)
  expect(qualified.queued).toEqual(base.queued)
  expect(qualified.revision).toBe(base.revision)
  expect(qualifyChatActivity(snapshot, { ...response, nativeRequestId: 'previous-request' }).pendingInteractions[0]!.responseAvailability).toBe('unavailable')
  expect(qualifyChatActivity(snapshot, { ...response, available: false, status: 'recovery_required', path: null,
    reason: 'callback_lost' }).pendingInteractions[0]!.responseAvailability).toBe('recovery_required')
})
