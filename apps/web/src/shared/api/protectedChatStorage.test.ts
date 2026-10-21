import { describe, expect, it, vi } from 'vitest'
import { bindProtectedChatInstance, identityEpoch, protectedKey } from './protectedChatStorage'

describe('protected chat instance binding', () => {
  it('migrates release bindings across documents without losing drafts or the original uncertain envelope', async () => {
    localStorage.clear()
    const installationId = 'd95abeb8-598a-49a4-8c3c-c6e3533053e8'
    localStorage.setItem('graphql.chat-instance-binding', `${'a'.repeat(64)}:${installationId}`)
    localStorage.setItem('graphql.identity-epoch', 'recoverable-epoch')
    vi.resetModules()
    const first = await import('./protectedChatStorage')
    const draft = first.protectedKey('draft', 'conversation')
    const outbox = first.protectedKey('outbox', 'conversation')
    const envelope = JSON.stringify({ requestId: 'original-request', text: 'Uncertain message' })
    localStorage.setItem(draft, 'Unsent draft')
    localStorage.setItem(outbox, envelope)
    expect(first.bindProtectedChatInstance(`installation:${installationId}`)).toBe(false)
    expect(first.identityEpoch()).toBe('recoverable-epoch')
    vi.resetModules()
    const second = await import('./protectedChatStorage')
    expect(second.bindProtectedChatInstance(`installation:${installationId}`)).toBe(false)
    expect(localStorage.getItem(second.protectedKey('draft', 'conversation'))).toBe('Unsent draft')
    expect(localStorage.getItem(second.protectedKey('outbox', 'conversation'))).toBe(envelope)
    expect(second.bindProtectedChatInstance('installation:a95abeb8-598a-49a4-8c3c-c6e3533053e8')).toBe(true)
    expect(localStorage.getItem(second.protectedKey('outbox', 'conversation'))).toBeNull()
    expect(localStorage.getItem(outbox)).toBe(envelope)
  })
  it('fails closed when the new binding cannot be persisted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
    try { expect(() => bindProtectedChatInstance('unpersistable-instance')).toThrow('Storage blocked') }
    finally { setItem.mockRestore() }
  })
  it('isolates legacy and changed database identities without deleting drafts or pending sends', () => {
    localStorage.clear()
    const draft = protectedKey('draft', 'chat')
    const outbox = protectedKey('outbox', 'chat')
    localStorage.setItem(draft, 'draft')
    localStorage.setItem(outbox, 'pending receipt')
    const initialEpoch = identityEpoch()
    expect(bindProtectedChatInstance('checkout:installation-a')).toBe(true)
    expect(identityEpoch()).not.toBe(initialEpoch)
    const boundEpoch = identityEpoch()
    // StrictMode repeats still report that this document must reload.
    expect(bindProtectedChatInstance('checkout:installation-a')).toBe(true)
    expect(identityEpoch()).toBe(boundEpoch)
    expect(bindProtectedChatInstance('checkout:installation-b')).toBe(true)
    expect(identityEpoch()).not.toBe(boundEpoch)
    expect(localStorage.getItem(protectedKey('draft', 'chat'))).toBeNull()
    expect(localStorage.getItem(protectedKey('outbox', 'chat'))).toBeNull()
    expect(localStorage.getItem(draft)).toBe('draft')
    expect(localStorage.getItem(outbox)).toBe('pending receipt')
  })
})
