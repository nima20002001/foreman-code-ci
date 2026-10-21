// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { apiClient } from '../../shared/api/client'
import { getOperatorConversationHistory } from '../../shared/api/operatorChatHistory'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { readPendingOperatorMessage, reserveOperatorMessage } from './operatorOutbox'

let currentInstance: string
let accepted: { requestId: string; content: string } | undefined
let submissions: number
let originalLocks: PropertyDescriptor | undefined
function historyResponse() {
  return Response.json({ conversationId: 'chat', revision: 2, activeRequestId: accepted!.requestId, nextCursor: null,
    entries: [{ sequence: '1', message: { id: 'message', conversationId: 'chat', role: 'user', content: accepted!.content },
      receipt: { requestId: accepted!.requestId, inputHash: 'a'.repeat(64), outcome: null, retryable: false } }] })
}
beforeEach(() => {
  finishSessionChange(); window.localStorage.clear(); currentInstance = 'a'; accepted = undefined; submissions = 0
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, options: LockOptions, work: (lock: Lock) => unknown) => {
      options.signal?.throwIfAborted(); return work({ name: 'outbox', mode: 'exclusive' })
    },
  } })
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') {
      accepted = JSON.parse(String(options.body)); submissions++
      throw new TypeError('Server accepted; HTTP response was lost')
    }
    return currentInstance === 'a' ? historyResponse()
      : Response.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation was not found.' } }, { status: 404 })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); finishSessionChange(); window.localStorage.clear()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})
async function loseAcknowledgement() {
  const command = await reserveOperatorMessage('chat', 'Run this exactly once', '/original-route')
  await expect(apiClient.request('/api/operator/conversations/chat/messages', SendOperatorMessageResponseSchema,
    { method: 'POST', body: command })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  return command
}

describe('app-instance recovery through server receipts', () => {
  it('recovers the original receipt without adopting or replaying the previous outbox', async () => {
    const command = await loseAcknowledgement(), oldKey = protectedKey('outbox', 'chat')
    beginSessionChange(); finishSessionChange()
    expect(protectedKey('outbox', 'chat')).not.toBe(oldKey)
    expect(readPendingOperatorMessage('chat').command).toBeUndefined()
    const recovered = await getOperatorConversationHistory('chat')
    expect(recovered.entries[0]?.receipt?.requestId).toBe(command.requestId)
    expect(recovered.activeRequestId).toBe(command.requestId)
    expect(submissions).toBe(1)
    expect(readPendingOperatorMessage('chat').command).toBeUndefined() // GET never manufactures a retry.
  })
  it('a different app instance cannot retrieve the prior command or its receipt', async () => {
    await loseAcknowledgement()
    beginSessionChange(); currentInstance = 'b'; finishSessionChange()
    await expect(getOperatorConversationHistory('chat')).rejects.toMatchObject({ status: 404 })
    expect(readPendingOperatorMessage('chat').command).toBeUndefined()
    expect(submissions).toBe(1)
  })
  it('rejects a late previous-instance history response even when fetch ignores its aborted signal', async () => {
    await loseAcknowledgement()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return historyResponse() }))
    const previousInstanceRead = getOperatorConversationHistory('chat').catch((error: unknown) => error)
    beginSessionChange(); currentInstance = 'b'; finishSessionChange()
    release()
    expect(await previousInstanceRead).toMatchObject({ name: 'AbortError' })
    expect(submissions).toBe(1)
  })
})
