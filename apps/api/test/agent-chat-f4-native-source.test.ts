import { describe, expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'

import { nativeSourceContent } from './helpers/agentChatNativeSource.js'

describe('full native source-history comparison', () => {
  const session: NativeSessionReference = {
    harness: 'codex', nativeSessionId: 'source', providerVersion: 'fixture',
  }
  const record = () => ({
    id: 'turn', itemsView: 'full', items: [{ id: 'message', type: 'agentMessage', text: 'KIWI' }],
  })
  it('detects changed contents and identities despite unchanged record counts', () => {
    const before = nativeSourceContent(session, [record()])
    expect(nativeSourceContent(session, [record()])).toBe(before)
    const changedContent = JSON.parse(JSON.stringify(record()).replace('KIWI', 'MANGO')) as Record<string, unknown>
    const changedIdentity = JSON.parse(JSON.stringify(record()).replace('message', 'another-message')) as Record<string, unknown>
    expect(nativeSourceContent(session, [changedContent])).not.toBe(before)
    expect(nativeSourceContent(session, [changedIdentity])).not.toBe(before)
    expect(() => nativeSourceContent(session, [])).toThrow(/empty/)
    expect(() => nativeSourceContent(session, [record(), record()])).toThrow(/repeated/)
  })
  it('rejects partial Codex items', () => {
    expect(() => nativeSourceContent(session, [{ id: 'turn', itemsView: 'summary', items: [] }])).toThrow(/full/)
  })
})
