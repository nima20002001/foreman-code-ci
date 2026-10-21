import { expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, type NativeSessionReference, type PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { reviewOwnsPermission } from './reviewerCleanup.js'

it('does not authorize retired native permission controls from saved message lineage', () => {
  const session: NativeSessionReference = {
    harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'saved-session',
  }
  const request: PendingNativeInteraction = {
    session, turn: { nativeTurnId: 'saved-assistant', nativeRequestId: 'saved-permission' },
    nativeRequestType: 'permission.asked', responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE, request: {
      id: 'saved-permission', sessionID: session.nativeSessionId, tool: { messageID: 'saved-assistant' },
    },
  }
  const history: NativeHistory = {
    events: [{ sequence: 0, type: 'message.updated', occurredAt: '2026-10-01T00:00:00.000Z',
      payload: { info: { id: 'saved-assistant', sessionID: session.nativeSessionId,
        role: 'assistant', parentID: 'saved-user' } } }],
    pendingInteractions: [request],
  }
  const saved = structuredClone({ request, history })
  expect(reviewOwnsPermission(session, 'saved-user', request, history)).toBe(false)
  expect({ request, history }).toEqual(saved)
})
