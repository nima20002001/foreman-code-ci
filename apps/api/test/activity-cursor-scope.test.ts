import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { assertConversationCursor } from '../src/modules/conversations/activityCursor.js'
describe('conversation source cursor anchors', () => {
  it.each(['messages', 'turns', 'activity'] as const)('%s cursor rejects a different owner and a missing anchor', async (source) => {
    const query = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as unknown as Pick<pg.PoolClient, 'query'>
    await expect(assertConversationCursor(query([{ conversation_id: 'other' }]), 'conversation', '4', source)).rejects.toMatchObject({ status: 409 })
    await expect(assertConversationCursor(query([]), 'conversation', '4', source)).rejects.toMatchObject({ status: 410 })
    await expect(assertConversationCursor(query([{ conversation_id: 'conversation' }]), 'conversation', '4', source)).resolves.toBeUndefined()
  })
})
