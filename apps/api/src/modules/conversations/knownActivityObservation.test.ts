import { expect, it, vi } from 'vitest'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { reconcileKnownActivities } from './reconcileKnownActivities.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'

it('reports failed history reads, counts retries and still settles independent owners', async () => {
  const owners = ['blocked', 'healthy'].map(conversationId => ({ conversationId, requestId: 'request', activityId: 'tool',
    ownerNative: { harness: 'codex', sessionId: conversationId, turnId: 'turn' },
    native: { harness: 'codex', sessionId: conversationId, turnId: 'turn', itemId: 'tool' } }))
  const settled = { activity: {}, revision: 1 }
  const activity = { unfinishedOwners: async () => ({ owners, hasMore: false }),
    settleKnownByNative: vi.fn(async () => settled) } as unknown as PostgresOperatorActivityRepository
  const event = { type: 'item.completed', payload: { threadId: 'healthy', turnId: 'turn',
    item: { id: 'tool', type: 'commandExecution', command: 'echo ready', status: 'completed', exitCode: 0 } } }
  const blocked = { harness: 'codex', history: vi.fn().mockRejectedValue(
    Object.assign(new Error('provider-token must stay private'), { code: 'NATIVE_HISTORY_UNAVAILABLE' })) }
  const healthy = { harness: 'codex', history: vi.fn().mockResolvedValue({ events: [event] }) }
  const observations = new Map()
  const publish = vi.fn()
  const onObservation = vi.fn()
  const input = { kind: 'operator' as const, activity, signal: AbortSignal.timeout(1000), observations, publish, onObservation,
    runtimeFor: (id: string) => ({ manager: (id === 'blocked' ? blocked : healthy) as unknown as NativeHarnessSessionManager,
      session: { harness: 'codex' as const, nativeSessionId: id, providerVersion: 'codex-cli 1.2.3' }, redact: nativePersistenceRedactor(['provider-token']) }) }
  expect(await reconcileKnownActivities(input)).toBe(true)
  expect(observations.get('blocked')).toMatchObject({ status: 'unavailable', consecutiveFailures: 1,
    lastError: expect.stringContaining('NATIVE_HISTORY_UNAVAILABLE'), failedAt: expect.any(String), lastSuccess: null })
  expect(onObservation).toHaveBeenCalledWith('blocked')
  expect(JSON.stringify(observations.get('blocked'))).not.toContain('provider-token')
  expect(publish).toHaveBeenCalledWith('healthy', settled)
  await reconcileKnownActivities(input)
  expect(observations.get('blocked').consecutiveFailures).toBe(2)
  blocked.history.mockResolvedValue({ events: [] })
  await reconcileKnownActivities(input)
  expect(observations.get('blocked')).toMatchObject({ status: 'available', lastError: null,
    consecutiveFailures: 0, failedAt: null, lastSuccess: expect.any(String) })
})
