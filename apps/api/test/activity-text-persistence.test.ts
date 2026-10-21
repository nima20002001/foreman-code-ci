import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { appendConversationTextOperation } from '../src/modules/conversations/conversationTextRepository.js'

function fixture() {
  let revision = 0; let item: { id: string; record: Record<string, unknown>; content: string; text_provenance: unknown; revision: string } | undefined
  const writes: string[] = []
  const owner = { kind: 'agent', harness: 'codex', revision: '0', workspace_id: 'ws', workflow_id: 'wf', workflow_node_id: 'node', agent_id: 'agent',
    origin_run_id: null, origin_execution_id: null, native_session_id: 'session', active_native_turn_id: 'turn' }
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('select * from operator_conversations')) return { rows: [{ ...owner, id: 'conversation', active_request_id: 'A' }], rowCount: 1 }
    if (sql.startsWith('select record from operator_conversation_messages')) return { rows: item ? [{ record: structuredClone(item.record) }] : [], rowCount: item ? 1 : 0 }
    if (sql.startsWith('select kind')) return { rows: [{ ...owner, revision: String(revision) }], rowCount: 1 }
    if (sql.startsWith('select id,record,content')) return { rows: item ? [structuredClone(item)] : [], rowCount: item ? 1 : 0 }
    if (sql.startsWith('select coalesce(max')) return { rows: [{ sequence: '3' }], rowCount: 1 }
    if (sql.startsWith('insert into operator_conversation_messages')) {
      writes.push(sql); item = { id: String(values[0]), record: JSON.parse(String(values[5])) as Record<string, unknown>, content: String(values[3]),
        text_provenance: JSON.parse(String(values[6])), revision: String(item ? Number(item.revision) + 1 : 0) }
      return { rows: [{ revision: item.revision }], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversation_messages set content=')) {
      writes.push(sql); item!.content = String(values[2]); item!.record = JSON.parse(String(values[3])) as Record<string, unknown>
      if (values[4] === true && item!.text_provenance) item!.text_provenance = { ...(item!.text_provenance as object), final: true }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversation_messages set text_provenance')) {
      item!.text_provenance = JSON.parse(String(values[2])); return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversations')) { revision++; return { rows: [{ revision: String(revision) }], rowCount: 1 } }
    if (!['begin', 'commit', 'rollback'].includes(sql)) throw new Error(`Unexpected SQL ${sql}`)
    return { rows: [], rowCount: 0 }
  }
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  return { pool, writes, owner, finalizeHistory: (content: string) => { item!.content = content; item!.record.content = content; item!.record.nativeMessageComplete = true }, state: () => ({ revision, item: structuredClone(item) }) }
}
const operation = (sequence: number, text: string, final = false): ActivityTextOperation => ({
  identity: { scope: { kind: 'agent_chat', conversationId: 'conversation', workspaceId: 'ws', workflowId: 'wf', nodeId: 'node', agentId: 'agent' },
    requestId: 'A', sessionId: 'session', turnId: 'turn', itemId: 'item', channel: 'assistant' },
  mode: final ? 'replace' : 'append', text, final, source: { connectionId: 'connection', sequence, eventId: `event-${sequence}` },
})
describe('existing message text persistence', () => {
  it('commits provisional deltas, authoritative shorter/empty final and rejects late deltas', async () => {
    const f = fixture()
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(1, 'long provisional')))?.status).toBe('committed')
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(2, 'short', true)))?.status).toBe('committed')
    const final = f.state()
    expect(final.item?.content).toBe('short'); expect(final.item?.record.nativeMessageComplete).toBe(true)
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(3, 'late')))?.status).toBe('ignored')
    expect(f.state()).toEqual(final)
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(4, '', true), { authoritativeReconciliation: true }))?.status).toBe('committed')
    expect(f.state().item?.content).toBe('')
  })
  it('does not append duplicates/stale observations or infer order across connections', async () => {
    const f = fixture(); const first = operation(2, 'a')
    await appendConversationTextOperation(f.pool, 'conversation', 'A', first)
    const before = f.state()
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', first))?.status).toBe('ignored')
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(1, 'stale')))?.status).toBe('ignored')
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', { ...operation(3, 'unproven'), source: { connectionId: 'new', sequence: 1 } }))?.status).toBe('reconciliation_required')
    expect(f.state()).toEqual(before)
  })
  it('keeps the native item row key shared with completed-message/cold settlement paths', async () => {
    const f = fixture(); const value = operation(1, 'draft'); value.identity.partId = 'part-metadata'
    await appendConversationTextOperation(f.pool, 'conversation', 'A', value)
    expect(f.state().item?.record.nativeMessageId).toBe('item')
    expect(f.state().item?.record.activityNative).toMatchObject({ itemId: 'item', partId: 'part-metadata' })
  })
  it('rejects old turn and incorrect immutable selection before any mutation', async () => {
    const f = fixture(); const old = operation(1, 'old'); old.identity.turnId = 'old-turn'
    expect(await appendConversationTextOperation(f.pool, 'conversation', 'A', old)).toBeUndefined()
    const foreign = operation(1, 'foreign'); foreign.identity.scope = { kind: 'operator_chat', conversationId: 'conversation' }
    expect(await appendConversationTextOperation(f.pool, 'conversation', 'A', foreign)).toBeUndefined()
    const oldGeneration = operation(1, 'old generation'); oldGeneration.identity.generation = 'old'
    expect(await appendConversationTextOperation(f.pool, 'conversation', 'A', oldGeneration, { nativeGeneration: 'current' })).toBeUndefined()
    expect(f.writes).toHaveLength(0)
  })
  for (const finalText of ['short', '']) it(`preserves a history-only ${finalText ? 'shorter' : 'empty'} final against a later canonical delta`, async () => {
    const f = fixture()
    await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(1, 'long provisional'))
    f.finalizeHistory(finalText)
    const finalized = f.state()
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(3, 'late')))?.status).toBe('ignored')
    expect(f.state()).toEqual(finalized)
    expect(f.state().item?.record.nativeMessageComplete).toBe(true)
  })

  for (const finalText of ['short', '']) it(`synchronizes canonical provenance when actual history writer finalizes ${finalText ? 'shorter' : 'empty'} text`, async () => {
    const f = fixture()
    await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(1, 'long provisional'))
    expect(await new PostgresOperatorConversationRepository(f.pool).appendAssistantMessage('conversation', 'A', 'item', finalText)).toBe(true)
    expect(f.state().item?.text_provenance).toMatchObject({ final: true })
    const finalized = f.state()
    expect((await appendConversationTextOperation(f.pool, 'conversation', 'A', operation(3, 'late')))?.status).toBe('ignored')
    expect(f.state()).toEqual(finalized)
  })

})
