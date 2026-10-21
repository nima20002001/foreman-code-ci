import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { bindingIdentity } from '../../files/tools/context.js'
import { readClaudeMessagePublicationReceipts, readClaudeMessagePublications } from './publications.js'

const conversationId = 'conversation'
function fixture(kind: 'agent' | 'operator' = 'operator') {
  const turn = { message_id: 'original-message', owner_principal_id: 'original-sender', native_session_id: 'observed-session',
    native_message_id: 'observed-message', kind, operator_id: kind === 'operator' ? 'operator' : null,
    workspace_id: kind === 'agent' ? 'workspace' : null, workflow_id: kind === 'agent' ? 'workflow' : null,
    agent_id: kind === 'agent' ? 'agent' : null, origin_run_id: null, origin_execution_id: null }
  const binding = bindingIdentity({ ownerPrincipalId: turn.owner_principal_id, nativeSessionId: turn.native_session_id,
    nativeMessageId: turn.native_message_id, messageId: turn.message_id, allowMutation: false, allowedTools: [],
    scope: { kind: 'temporary', chat: kind === 'operator'
      ? { kind: 'operator', conversationId, ownerPrincipalId: turn.owner_principal_id, operatorId: 'operator' }
      : { kind: 'agent', conversationId, workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent' } } })
  const publication = { binding, owner_principal_id: turn.owner_principal_id, request_id: 'original-publication-receipt',
    file_id: 'published-file', revision_id: 'original-file-revision', file_activity_revision: '17', file_state: 'deleted' }
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(sql.trim().startsWith('select')).toBe(true)
    if (sql.includes('from operator_conversations')) {
      expect(values).toEqual([conversationId, [turn.message_id]])
      expect(sql).toContain("c.harness='claude'")
      expect(sql).toContain("m.client_request_id=t.request_id and m.role='user'")
      expect(sql).toContain("t.payload->'nativeSubmission'->>'kind'='message'")
      return { rows: [turn] }
    }
    expect(values).toEqual([[binding]])
    expect(sql).toContain("a.state='finalized'")
    expect(sql).toContain('a.request_id=p.request_id')
    expect(sql).toContain('a.revision_id=p.revision_id')
    expect(sql).toContain('f.owner_principal_id=p.owner_principal_id')
    return { rows: [publication] }
  })
  return { query: { query } as unknown as Pick<pg.PoolClient, 'query'>, calls: query, turn, publication }
}

describe('Claude finalized publication receipt evidence', () => {
  it.each(['agent', 'operator'] as const)('returns original %s receipt without an adopted pin or live credentials', async kind => {
    const f = fixture(kind)
    expect(await readClaudeMessagePublicationReceipts(f.query, conversationId, [f.turn.message_id])).toEqual([{
      receiptId: f.publication.request_id, messageId: f.turn.message_id, fileId: f.publication.file_id,
      fileRevisionId: f.publication.revision_id, nativeSessionId: f.turn.native_session_id,
      nativeMessageId: f.turn.native_message_id, fileActivityRevision: '17', fileState: 'deleted',
    }])
    expect(f.calls).toHaveBeenCalledTimes(2)
    expect(await readClaudeMessagePublications(f.query, conversationId, [f.turn.message_id])).toEqual(
      new Map([[f.turn.message_id, [{ fileId: f.publication.file_id, revisionId: f.publication.revision_id }]]]))
  })
  it('rejects a wrong owner or binding without reviving authority', async () => {
    const f = fixture()
    f.publication.owner_principal_id = 'other-sender'
    expect(await readClaudeMessagePublicationReceipts(f.query, conversationId, [f.turn.message_id])).toEqual([])
    f.publication.owner_principal_id = f.turn.owner_principal_id
    f.publication.binding = 'different-message-binding'
    expect(await readClaudeMessagePublicationReceipts(f.query, conversationId, [f.turn.message_id])).toEqual([])
  })
  it('does not query for empty input or missing admitted messages', async () => {
    const f = fixture()
    expect(await readClaudeMessagePublicationReceipts(f.query, conversationId, [])).toEqual([])
    expect(f.calls).not.toHaveBeenCalled()
    f.calls.mockResolvedValueOnce({ rows: [] })
    expect(await readClaudeMessagePublicationReceipts(f.query, conversationId, [f.turn.message_id])).toEqual([])
    expect(f.calls).toHaveBeenCalledOnce()
  })
})
