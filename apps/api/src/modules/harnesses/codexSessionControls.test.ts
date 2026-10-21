import { expect, it } from 'vitest'
import { codexCollaborationMode, codexCompactionNotification, codexContextSnapshot } from './codexSessionControls.js'

it('uses native mode settings and restores the regular preset without permission overrides', () => {
  expect(codexCollaborationMode('plan', 'model', 'high')).toEqual({ mode: 'plan',
    settings: { model: 'model', reasoning_effort: 'high', developer_instructions: null } })
  expect(codexCollaborationMode('regular', 'model', 'high').mode).toBe('default')
})
it('uses latest context occupancy separately from lifetime totals', () => {
  const value = { threadId: 'thread', tokenUsage: { last: { totalTokens: 120 }, total: { totalTokens: 950 }, modelContextWindow: 1000 } }
  expect(codexContextSnapshot(value, 'thread', 'model', 4)).toMatchObject({ usedTokens: 120, lifetimeTokens: 950, capacityTokens: 1000 })
  expect(codexContextSnapshot(value, 'foreign', 'model', 4)).toBeNull()
})
it('requires correlated native completion rather than the dispatch acknowledgement', () => {
  const initial = { requestId: 'control', nativeSessionId: 'thread', nativeOperationId: null, status: 'accepted' as const,
    beforeTokens: 120, message: '', observedAt: '2026-10-04T00:00:00.000Z' }
  const running = codexCompactionNotification(initial, 'turn/started', { threadId: 'thread', turn: { id: 'compact-turn' } })
  expect(running.status).toBe('running')
  expect(codexCompactionNotification(running, 'turn/completed', { threadId: 'foreign', turn: { id: 'compact-turn' } })).toEqual(running)
  expect(codexCompactionNotification(running, 'turn/completed', { threadId: 'thread',
    turn: { id: 'compact-turn', status: 'completed', items: [{ type: 'contextCompaction' }] } }).status).toBe('completed')
})
