import { expect, it } from 'vitest'
import type { ActivitySnapshotV1 } from '@foreman-code/contracts'
import { chatBackgroundWork } from './chatWorkStatus'

it('marks retained native activity unconfirmed while history observation is pending', () => {
  const snapshot = { schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: 'conversation' },
    revision: '1', active: [{ ref: { kind: 'tool', itemId: 'tool' }, phase: 'active', outcome: null,
      delivery: null, evidence: 'confirmed', startedAt: null }], queued: [], latest: null,
    pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false },
    observation: { status: 'unavailable', lastError: 'Native activity observation failed (NATIVE_HISTORY_UNAVAILABLE).',
      failedAt: '2026-10-14T00:00:00Z', lastSuccess: null, consecutiveFailures: 3 },
  } as ActivitySnapshotV1
  expect(chatBackgroundWork(snapshot)).toMatchObject({ evidence: 'unknown',
    label: 'Activity observation pending', message: expect.stringContaining('NATIVE_HISTORY_UNAVAILABLE') })
  expect(chatBackgroundWork(snapshot)?.message).toContain('3 consecutive failed reads')
})
