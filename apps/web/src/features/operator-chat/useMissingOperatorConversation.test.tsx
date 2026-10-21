import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { identityEpochKey, protectedKey } from '../../shared/api/protectedChatStorage'
import { useOperatorChatStore } from './operatorChatStore'
import { isMissingOperatorConversation, useMissingOperatorConversation } from './useMissingOperatorConversation'

afterEach(() => { cleanup(); localStorage.clear(); useOperatorChatStore.getState().reset() })
describe('missing Operator selection recovery', () => {
  it('accepts only an explicit missing conversation, never auth or network failures', () => {
    expect(isMissingOperatorConversation(new ApiError({ code: 'CONVERSATION_NOT_FOUND', message: 'Missing' }, 404))).toBe(true)
    for (const error of [new Error('offline'), new ApiError({ code: 'ACCESS_DENIED', message: 'Denied' }, 403),
      new ApiError({ code: 'CONVERSATION_NOT_FOUND', message: 'Denied' }, 403),
      new ApiError({ code: 'NOT_FOUND', message: 'Route missing' }, 404)]) expect(isMissingOperatorConversation(error)).toBe(false)
  })
  it('clears and persists only the selection, retaining draft and uncertain outbox verbatim', () => {
    useOperatorChatStore.getState().select('missing-chat')
    const draft = protectedKey('draft', 'missing-chat')
    const outbox = protectedKey('outbox', 'missing-chat')
    localStorage.setItem(draft, 'Unsent draft')
    localStorage.setItem(outbox, '{"uncertain":"receipt"}')
    const { rerender, result } = renderHook(({ id }) => useMissingOperatorConversation(id, true), { initialProps: { id: 'missing-chat' as string | undefined } })
    expect(useOperatorChatStore.getState().selectedConversationId).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(protectedKey('ui'))!)).not.toHaveProperty('selectedConversationId')
    expect(localStorage.getItem(draft)).toBe('Unsent draft')
    expect(localStorage.getItem(outbox)).toBe('{"uncertain":"receipt"}')
    const generation = useOperatorChatStore.getState().navigationGeneration
    rerender({ id: undefined })
    expect(result.current).toBe(true)
    expect(useOperatorChatStore.getState().navigationGeneration).toBe(generation)
  })
  it('does not clear a selection made after the missing request began', () => {
    useOperatorChatStore.getState().select('new-chat')
    renderHook(() => useMissingOperatorConversation('old-chat', true))
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat')
  })
  it('leaves selections intact on other failures and hides old recovery notice across identities', () => {
    useOperatorChatStore.getState().select('chat')
    const { rerender, result } = renderHook(({ missing, id }) => useMissingOperatorConversation(id, missing),
      { initialProps: { missing: false, id: 'chat' as string | undefined } })
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('chat')
    rerender({ missing: true, id: 'chat' })
    rerender({ missing: false, id: undefined })
    expect(result.current).toBe(true)
    act(() => { localStorage.setItem(identityEpochKey, 'different-instance-session') })
    rerender({ missing: false, id: undefined })
    expect(result.current).toBe(false)
  })
})
