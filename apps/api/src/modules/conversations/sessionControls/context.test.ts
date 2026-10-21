import { expect, it } from 'vitest'
import type { ContextSnapshot } from '@foreman-code/contracts'
import { mergeContextSnapshot } from './context.js'
const context: ContextSnapshot = { nativeSessionId: 'session', model: 'model', generation: 'connection', sequence: 4,
  source: 'codex', accuracy: 'native', usedTokens: 100, capacityTokens: null, lifetimeTokens: 400, cost: null,
  observedAt: '2026-10-04T00:00:00.000Z', stale: false }
it('rejects older and foreign usage while preserving unknown capacity', () => {
  expect(mergeContextSnapshot(context, { ...context, sequence: 3, usedTokens: 0 }, 'session', 'model')).toEqual(context)
  expect(mergeContextSnapshot(context, { ...context, nativeSessionId: 'foreign' }, 'session', 'model')).toEqual(context)
  expect(mergeContextSnapshot(context, { ...context, model: 'other' }, 'session', 'model')).toEqual(context)
})
it('marks a compaction snapshot stale without inventing zero usage and accepts a new connection', () => {
  expect(mergeContextSnapshot(context, { ...context, stale: true }, 'session', 'model')).toMatchObject({ usedTokens: 100, stale: true })
  expect(mergeContextSnapshot(context, { ...context, generation: 'reconnected', sequence: 0,
    observedAt: '2026-10-04T00:01:00.000Z', usedTokens: 80 }, 'session', 'model')).toMatchObject({ usedTokens: 80 })
})

it('keeps repeated reads of the same native snapshot stable', () => {
  expect(mergeContextSnapshot(context, { ...context, observedAt: '2026-10-04T00:01:00.000Z' }, 'session', 'model')).toEqual(context)
})
