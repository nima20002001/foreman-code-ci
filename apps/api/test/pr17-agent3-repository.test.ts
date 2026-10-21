import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

describe('F7 repository terminal transition without assistant identity', () => {
  for (const nativeMessageId of [undefined, 'real-id']) it.each(['', { text: '' }, { content: '' }])(
    `settles once without text %j; nativeMessageId=${nativeMessageId}`, async (output) => {
    let active: string | null = 'request'
    let savedResult: unknown
    const messages: unknown[] = []
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes('from operator_conversation_turns where conversation_id=$1')) return { rows: [{ matches: true }], rowCount: 1 }
        if (sql.startsWith('select * from operator_conversations')) return { rows: [{ id: 'chat', active_request_id: active }] }
        // There is genuinely no earlier native message: a positive rowCount here
        // used to hide empty-text insertion behind the duplicate-message guard.
        if (sql.startsWith('select 1 from operator_conversation_messages')) return { rows: [], rowCount: 0 }
        if (sql.startsWith('select coalesce(max(sequence)')) return { rows: [{ sequence: '0' }], rowCount: 1 }
        if (sql.startsWith('insert into operator_conversation_messages')) messages.push(JSON.parse(String(values[4])))
        if (sql.startsWith('update operator_conversation_turns set result')) savedResult = JSON.parse(String(values[2]))
        if (sql.includes('set active_request_id=null')) active = null
        return { rows: [], rowCount: 1 }
      },
      release() {},
    }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    const result = { outcome: 'succeeded' as const, output }
    expect(await repository.finish('chat', 'request', result, nativeMessageId)).toBe(true)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded' }, nativeMessageId)).toBe(false)
    expect(messages).toEqual([])
    expect(savedResult).toEqual(result)
    expect(active).toBeNull()
  })
  it.each(['Exact\nprovider text', '   '])('retains exact nonempty provider text %j without trimming it', async (content) => {
    const messages: unknown[] = []
    const client = { query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('from operator_conversation_turns where conversation_id=$1')) return { rows: [{ matches: true }], rowCount: 1 }
      if (sql.startsWith('select * from operator_conversations')) return { rows: [{ id: 'chat', active_request_id: 'request' }], rowCount: 1 }
      if (sql.startsWith('select 1 from operator_conversation_messages')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('select coalesce(max(sequence)')) return { rows: [{ sequence: '0' }], rowCount: 1 }
      if (sql.startsWith('insert into operator_conversation_messages')) messages.push(JSON.parse(String(values[4])))
      return { rows: [], rowCount: 1 }
    }, release() {} }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded', output: { text: content } }, 'real-id')).toBe(true)
    expect(messages).toEqual([expect.objectContaining({ content, requestId: 'request', nativeMessageId: 'real-id', role: 'assistant' })])
  })
  it('does not fabricate a provider ID even when terminal result text exists', async () => {
    const messages: unknown[] = []
    const client = { query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('from operator_conversation_turns where conversation_id=$1')) return { rows: [{ matches: true }], rowCount: 1 }
      if (sql.startsWith('insert into operator_conversation_messages')) messages.push(JSON.parse(String(values[4])))
      return { rows: sql.startsWith('select') ? [{ active_request_id: 'request' }] : [], rowCount: 1 }
    }, release() {} }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded', output: { text: 'Real text but no provider message identity' } })).toBe(true)
    expect(messages).toEqual([])
  })
})
