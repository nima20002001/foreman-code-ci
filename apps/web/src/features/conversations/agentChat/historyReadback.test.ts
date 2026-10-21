import { describe, expect, it, vi } from 'vitest'
import { CHAT_HISTORY_BATCH_PAGES, readEarlierChatHistory } from './historyReadback'
describe('bounded overlapping history reads', () => {
  it('returns cursor progress after the bounded empty/oversized window without losing server cursors', async () => {
    let cursor = 100
    const read = vi.fn(async () => ({ conversationId: 'chat-a', messages: [], nextCursor: String(--cursor) }))
    const batch = await readEarlierChatHistory(read, undefined, 'oldest-live')
    expect(read).toHaveBeenCalledTimes(CHAT_HISTORY_BATCH_PAGES)
    expect(batch.pages).toHaveLength(CHAT_HISTORY_BATCH_PAGES)
    expect(batch.nextCursor).toBe(String(100 - CHAT_HISTORY_BATCH_PAGES))
  })
  it('rejects nonprogressing cursors and preserves expired/cross-scope server errors', async () => {
    await expect(readEarlierChatHistory(async () => ({ conversationId: 'chat-a', messages: [], nextCursor: '10' }), '10', undefined)).rejects.toThrow(/advance/)
    const error = new Error('ACTIVITY_CURSOR_EXPIRED')
    await expect(readEarlierChatHistory(async () => { throw error }, '10', undefined)).rejects.toBe(error)
  })
})
