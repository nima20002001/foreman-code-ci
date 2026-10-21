import { expect, it } from 'vitest'
import { MessageSchema } from '@foreman-code/contracts'
import { conversationPublicationItems } from '../src/modules/conversations/activityItems.js'
it('dispatches finalized publication receipts with the original provider identity', () => {
  const message = MessageSchema.parse({ id: 'message', conversationId: 'conversation', role: 'user', content: 'Request', createdAt: '2026-10-01T00:00:00.000Z', requestId: 'request', sequence: '4' })
  const receipt = { receiptId: 'receipt', messageId: message.id, fileId: 'file', fileRevisionId: 'revision', nativeSessionId: 'session', fileActivityRevision: '7', fileState: 'ready' }
  const codex = conversationPublicationItems('conversation', [message], [{ ...receipt, nativeTurnId: 'original-turn' }])[0]!
  const claude = conversationPublicationItems('conversation', [message], [{ ...receipt, nativeMessageId: 'original-message' }])[0]!
  expect(codex.native).toEqual({ harness: 'codex', sessionId: 'session', turnId: 'original-turn' })
  expect(claude.native).toEqual({ harness: 'claude', sessionId: 'session', messageId: 'original-message' })
  expect(claude.owner).toEqual(codex.owner)
  expect(claude.id).toBe(codex.id)
  expect(claude.revision).toBe('7')
  expect(conversationPublicationItems('conversation', [], [{ ...receipt, nativeMessageId: 'original-message' }])).toEqual([])
})
