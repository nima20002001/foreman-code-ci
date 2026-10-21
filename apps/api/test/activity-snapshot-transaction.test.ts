import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { agentActivitySnapshot } from '../src/modules/conversations/activitySnapshot.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
describe('activity persistence transaction boundaries', () => {
  it('reads missing state in an isolated transaction and always releases', async () => {
    let released = false
    const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => { released = true } }
    const pool = { connect: async () => client, query: async () => { throw new Error('Snapshot escaped transaction') } } as unknown as pg.Pool
    expect(await new PostgresAgentChatRepository(pool).state('missing')).toBeUndefined()
    expect(released).toBe(true)
  })
  it('keeps populated row, receipt, message and activity reads on one isolated client', async () => {
    const client = { query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('select * from operator_conversations')) return { rows: [{ id: 'conversation', workspace_id: 'ws', workflow_id: 'wf', workflow_node_id: 'node', agent_id: 'agent', revision: '0', active_request_id: null, origin_run_id: null, harness: 'codex', native_session_id: null }], rowCount: 1 }
      if (sql.startsWith('with candidates as (')) return { rows: [{ messages: [], has_earlier: false }], rowCount: 1 }
      if (sql.startsWith('select (select started_at')) return { rows: [{ started_at: null, latest_request_id: null }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }, release() {} }
    const pool = { connect: async () => client, query: async () => { throw new Error('Read escaped snapshot transaction') } } as unknown as pg.Pool
    const value = await new PostgresAgentChatRepository(pool).state('conversation')
    expect(value).toMatchObject({ row: { id: 'conversation' }, turns: [], messages: [], activeStartedAt: null, activityPage: { activities: [] } })
  })
  it('returns no mutation for a missing owner and releases the transaction', async () => {
    let released = false
    const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => { released = true } }
    const pool = { connect: async () => client, query: async () => { throw new Error('Mutation escaped transaction') } } as unknown as pg.Pool
    const repo = new PostgresOperatorActivityRepository(pool)
    expect(await repo.append('conversation', 'A', { id: 'tool', requestId: 'A', kind: 'tool', title: 'Tool', status: 'completed' },
      { nativeSessionId: 'session', nativeTurnId: 'turn', source: { eventId: 'event', sequence: '4' } })).toBeUndefined()
    expect(released).toBe(true)
  })
  it('captures actual input-file source revisions during the same scoped state/hydration transaction', async () => {
    const owner = { id: 'conversation', kind: 'agent', active_request_id: null, native_session_id: null, active_native_turn_id: null,
      origin_run_id: null, origin_execution_id: null, workspace_id: 'workspace', workflow_id: 'workflow', workflow_node_id: 'node',
      agent_id: 'agent', harness: 'codex', revision: '4', cancel_requested: false, pending_interaction: null, turn_state: 'idle' }
    const message = { id: 'message', conversationId: 'conversation', requestId: 'A', role: 'user', content: 'Input', revision: '1', sequence: '1',
      attachmentRefs: [{ fileId: 'input-file', revisionId: 'pinned-version' }] }
    const file = { file_id: 'input-file', current_revision_id: 'new-head', activity_record_revision: '7', revision_id: 'pinned-version',
      chat_kind: 'agent', owner_principal_id: 'owner', operator_id: null, conversation_id: 'conversation', agent_id: 'agent',
      workspace_id: 'workspace', workflow_id: 'workflow', run_id: null, execution_id: null, state: 'ready',
      created_at: new Date('2026-10-01T00:00:00Z'), retention_duration_seconds: 3600, expires_at: new Date('2026-10-01T01:00:00Z'),
      filename: 'input.md', media_type: 'text/markdown', byte_size: '1', sha256: '0'.repeat(64), origin: 'upload',
      revision_created_at: new Date('2026-10-01T00:00:00Z'), read_at: new Date('2026-10-01T00:30:00Z') }
    const client = { query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('select * from operator_conversations')) return { rows: [owner], rowCount: 1 }
      if (sql.startsWith('with candidates as (')) return { rows: [{ messages: [message], has_earlier: false }], rowCount: 1 }
      if (sql.includes('jsonb_to_recordset')) return { rows: [file], rowCount: 1 }
      if (sql.startsWith('select (select started_at')) return { rows: [{ started_at: null, latest_request_id: null }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }, release() {} }
    const pool = { connect: async () => client, query: async () => { throw new Error('Input file source escaped the snapshot transaction') } } as unknown as pg.Pool
    const repository = new PostgresAgentChatRepository(pool), first = (await repository.state('conversation'))!
    expect(agentActivitySnapshot(first).sourceRevisions).toContainEqual({ source: 'file', id: 'input-file', revision: '7' })
    file.state = 'removed'; file.activity_record_revision = '8'
    const next = (await repository.state('conversation'))!
    expect(next.messages[0]?.attachments?.[0]?.file.state).toBe('removed')
    expect(agentActivitySnapshot(next).sourceRevisions).toContainEqual({ source: 'file', id: 'input-file', revision: '8' })
    expect(next.row.revision).toBe(first.row.revision); expect(next.messages[0]?.revision).toBe('1')
  })

})
