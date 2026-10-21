import type { z } from 'zod'
import type { AgentChatHistoryPageSchema } from '@foreman-code/contracts/agent-chat'

export const CHAT_HISTORY_BATCH_PAGES = 8

type HistoryPage = z.infer<typeof AgentChatHistoryPageSchema>

/** A logical "earlier" operation may cross several real pages overlapping the state window.
 * Keep each server page intact and use only returned cursors, never opaque message ids. */
export async function readEarlierChatHistory(readPage: (before: string | undefined) => Promise<HistoryPage>,
  before: string | undefined, oldestMessageId: string | undefined) {
  const pages: HistoryPage[] = []
  let crossedOldest = before !== undefined || oldestMessageId === undefined
  for (;;) {
    const page = await readPage(before)
    pages.push(page)
    const oldestIndex = page.messages.findIndex((message) => message.id === oldestMessageId)
    const hasEarlier = crossedOldest && page.messages.length > 0 || oldestIndex > 0
    if (page.nextCursor !== null && before !== undefined && BigInt(page.nextCursor) >= BigInt(before)) {
      throw new Error('Earlier history did not advance its cursor. Refresh before trying again.')
    }
    if (hasEarlier || page.nextCursor === null || pages.length >= CHAT_HISTORY_BATCH_PAGES) return { pages, nextCursor: page.nextCursor }
    crossedOldest ||= oldestIndex === 0
    before = page.nextCursor
  }
}
