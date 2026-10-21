import { describe, expect, it } from 'vitest'
import { SessionControlRequestSchema, SessionPreferencesSchema, compactionBlocksSend } from './sessionControls.js'

describe('session controls', () => {
  it('rejects client supplied native session identities', () => {
    expect(SessionControlRequestSchema.safeParse({ kind: 'compact', requestId: 'control-123', expectedRevision: 0,
      nativeSessionId: 'foreign' }).success).toBe(false)
  })
  it('keeps manual compaction independent of the automatic budget', () => {
    expect(SessionPreferencesSchema.parse({ autoCompact: 'off', autoCompactTokens: 500000 })).toMatchObject({
      autoCompact: 'off', autoCompactTokens: 500000, contextBudget: null,
    })
    expect(SessionPreferencesSchema.safeParse({ autoCompactTokens: '500k' }).success).toBe(false)
    expect(SessionPreferencesSchema.safeParse({ autoCompactTokens: 99999 }).success).toBe(false)
  })
  it('fences uncertain compaction but allows follow-up after native completion', () => {
    const state = { requestId: 'control-123', nativeSessionId: 'session', nativeOperationId: null,
      message: '', beforeTokens: null, observedAt: '2026-10-04T00:00:00.000Z' }
    expect(compactionBlocksSend({ ...state, status: 'uncertain' })).toBe(true)
    expect(compactionBlocksSend({ ...state, status: 'completed' })).toBe(false)
    expect(compactionBlocksSend(null)).toBe(false)
  })
})
