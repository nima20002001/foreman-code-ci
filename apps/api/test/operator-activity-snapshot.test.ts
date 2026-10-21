import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { readOperatorActivitySnapshot } from '../src/modules/conversations/operatorActivitySnapshot.js'

const startedAt = new Date('2026-10-01T00:00:00Z')
describe('persisted Operator activity', () => {
  it('projects exact older active owner, immutable start, latest receipt and response fence independently', async () => {
    const query = { query: async (text: string) => {
      if (text.startsWith('select id,revision')) return { rows: [{ id: 'conversation', revision: '9007199254740993', harness: 'codex',
        native_session_id: 'session', active_request_id: 'A', active_native_turn_id: 'turn-A', cancel_requested: false, turn_state: 'active',
        response_delivery: 'submitted', pending_interaction: { session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'session' },
          turn: { nativeTurnId: 'turn-A', nativeRequestId: 'question' }, nativeRequestType: 'approval', request: {}, responseOptions: [{ optionId: 'approve', label: 'Approve', semantic: 'approve_once' }] } }] }
      if (text.includes('from operator_conversation_turns') && text.includes('order by')) return { rows: [{ request_id: 'B', sequence: '2', started_at: null, outcome: 'succeeded', native_turn_id: null }] }
      if (text.includes('from operator_conversation_turns')) return { rows: [{ request_id: 'A', sequence: '1', started_at: startedAt, outcome: null, native_turn_id: 'turn-A' }] }
      if (text.includes('from operator_conversation_messages')) return { rows: [{ record: { id: 'text', conversationId: 'conversation', requestId: 'A',
        role: 'assistant', content: '', nativeMessageId: 'native-text', nativeMessageComplete: true, revision: '4', sequence: '3' } }] }
      if (text.startsWith('with candidates as materialized (')) return { rows: [] }
      if (text.includes('operator_conversation_activity')) return { rows: [] }
      throw new Error(`Unexpected SQL ${text}`)
    } } as unknown as Pick<pg.PoolClient, 'query'>
    const result = await readOperatorActivitySnapshot({} as pg.Pool, query, 'conversation')
    expect(result?.active[0]).toMatchObject({ ref: { requestId: 'A' }, phase: 'waiting', startedAt: startedAt.toISOString() })
    expect(result?.latest).toMatchObject({ requestId: 'B' }); expect(result?.queued).toEqual([])
    expect(result?.pendingInteractions[0]).toMatchObject({ native: { requestId: 'question' }, delivery: 'delivery_pending', answerRecorded: false, providerAcknowledged: false })
    expect(result?.activities[0]).toMatchObject({ kind: 'text', text: '', revision: '4', finality: 'authoritative_final' })
    expect(result?.activities[0]?.native).toEqual({ harness: 'codex', sessionId: 'session', turnId: 'turn-A', itemId: 'native-text' })
  })
})
