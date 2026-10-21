import type { ReadObservation } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { reconcileKnownActivities } from '../src/modules/conversations/reconcileKnownActivities.js'
const session = { harness: 'codex' as const, providerVersion: 'pinned-fixture', nativeSessionId: 'original-session' }
const owner = { conversationId: 'conversation', requestId: 'older-A', activityId: 'older-tool', native: { harness: 'codex',
  sessionId: session.nativeSessionId, turnId: 'original-turn', itemId: 'older-tool' }, ownerNative: { harness: 'codex', sessionId: session.nativeSessionId, turnId: 'original-turn' } }
it('settles only preexisting original-owner items through the resident history path without cold allocation or current-root mutation', async () => {
  const activity = { unfinishedOwners: vi.fn(async () => ({ owners: [owner], hasMore: false })),
    settleKnownByNative: vi.fn(async () => undefined) } as unknown as PostgresOperatorActivityRepository
  const history = vi.fn(async () => ({ events: [{ sequence: 1, occurredAt: '2026-10-01T00:00:00Z', type: 'item.completed',
    payload: { threadId: session.nativeSessionId, turnId: 'original-turn', item: { id: 'older-tool', type: 'commandExecution', status: 'completed' } } }], pendingInteractions: [] }))
  const manager = { harness: 'codex', history, attachSession: vi.fn(), startTurn: vi.fn(), respond: vi.fn(), cancel: vi.fn() } as unknown as NativeHarnessSessionManager
  const input = { kind: 'agent' as const, conversationId: 'conversation', activity, signal: new AbortController().signal,
    observations: new Map<string, ReadObservation>(), onObservation: vi.fn(),
    runtimeFor: () => ({ manager, session }), publish: vi.fn() }
  await reconcileKnownActivities(input)
  expect(input.observations.get('conversation')).toMatchObject({ status: 'available', consecutiveFailures: 0 })
  expect(activity.settleKnownByNative).toHaveBeenCalledWith('conversation', expect.objectContaining({ id: 'older-tool', status: 'completed' }), owner.native, undefined)
  expect(manager.attachSession).not.toHaveBeenCalled(); expect(manager.startTurn).not.toHaveBeenCalled()
  expect(manager.respond).not.toHaveBeenCalled(); expect(manager.cancel).not.toHaveBeenCalled()
  history.mockClear()
  await reconcileKnownActivities({ ...input, runtimeFor: () => undefined })
  expect(history).not.toHaveBeenCalled()
})
