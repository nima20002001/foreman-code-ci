import { describe, expect, it } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import type { ActivitySourceRevision } from '@foreman-code/contracts/activity'
// Cross-boundary unit proof only; product modules continue to use their HTTP client.
import { hydrateMessageAttachments } from '../../../../../api/src/modules/conversations/messageAttachments.js'
import { agentActivitySnapshot } from '../../../../../api/src/modules/conversations/activitySnapshot.js'
import { readOperatorActivitySnapshot } from '../../../../../api/src/modules/conversations/operatorActivitySnapshot.js'
import { acceptAgentChatState } from './model'
import { newerOperatorConversationState as newer } from '../../operator-chat/operatorConversationReadback'
import { operatorState } from '../../operator-chat/pr17-test-fixtures'

type Query = Parameters<typeof hydrateMessageAttachments>[0]
function fileRow(conversationId: string, kind: 'agent' | 'operator', context = agentChatFixtures.idleAfterCompletion.context) {
  return { file_id: 'input-file', revision_id: 'input-revision', current_revision_id: 'input-revision', activity_record_revision: '7',
    chat_kind: kind, owner_principal_id: 'owner', operator_id: kind === 'operator' ? 'application-operator' : null,
    conversation_id: conversationId, agent_id: kind === 'agent' ? context.agentId : null,
    workspace_id: kind === 'agent' ? context.workspaceId : null, workflow_id: kind === 'agent' ? context.workflowId : null,
    run_id: null, execution_id: null, state: 'ready', created_at: new Date('2026-10-01T00:00:00Z'), retention_duration_seconds: 3600,
    expires_at: new Date('2026-10-01T01:00:00Z'), filename: 'input.md', media_type: 'text/markdown', byte_size: '1', sha256: '0'.repeat(64),
    origin: 'upload', revision_created_at: new Date('2026-10-01T00:00:00Z'), read_at: new Date('2026-10-01T00:30:00Z') }
}

describe('actual attachment metadata, snapshot and mounted consumer readback', () => {
  for (const change of ['removed', 'clock_expired'] as const) it(`Agent refreshes an input file ${change} without rewriting message/scope revisions`, async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
    const conversationId = state.conversation!.id, context = state.context, file = fileRow(conversationId, 'agent')
    const stored = { ...state.messages[0]!, revision: '1', sequence: '1', requestId: 'A',
      attachmentRefs: [{ fileId: file.file_id, revisionId: file.revision_id }] }
    delete stored.attachments
    const query = { query: async (sql: string) => ({ rows: sql.includes('jsonb_to_recordset') ? [file] : [] }) } as unknown as Query
    const read = async () => {
      const fileSourceRevisions: ActivitySourceRevision[] = []
      const messages = await hydrateMessageAttachments(query, conversationId, [stored], (source) => fileSourceRevisions.push(source))
      const loaded = { row: { id: conversationId, agent_key: 'fixture-key', agent_configuration_version_id: state.conversation!.agentConfigurationVersionId,
        provider_version: null, last_error: null, last_result: null, record: { origin: state.conversation!.origin, workingDirectory: '/fixture', runtimeDirectory: '/fixture' },
        created_at: new Date('2026-10-01T00:00:00Z'), updated_at: new Date('2026-10-01T00:00:00Z'), workspace_id: context.workspaceId, workflow_id: context.workflowId,
        workflow_node_id: context.workflowNodeId, agent_id: context.agentId, active_request_id: null, native_session_id: null,
        active_native_turn_id: null, harness: 'codex', origin_run_id: null, origin_execution_id: null, turn_state: 'idle',
        cancel_requested: false, pending_interaction: null, revision: String(state.revision) }, turns: [], latestRequestId: null,
        activeStartedAt: null, activityPage: { activities: [], nextCursor: null, itemRevisions: {} }, selection: null,
        unfinishedActivities: [], messages, fileSourceRevisions, hasEarlierMessages: false, publicationReceipts: [] } as Parameters<typeof agentActivitySnapshot>[0]
      return { ...state, messages, activitySnapshot: agentActivitySnapshot(loaded) }
    }
    const previous = await read()
    if (change === 'removed') { file.state = 'removed'; file.activity_record_revision = '8' }
    else file.read_at = new Date('2026-10-01T01:01:00Z')
    const incoming = await read(), accepted = acceptAgentChatState(previous, incoming, 'read')
    expect(incoming.messages[0]?.attachments?.[0]?.file.state).toBe(change === 'removed' ? 'removed' : 'expired')
    expect(accepted.messages[0]?.attachments?.[0]?.file.state).toBe(change === 'removed' ? 'removed' : 'expired')
    expect(accepted.messages[0]?.revision).toBe('1'); expect(accepted.revision).toBe(previous.revision)
    expect(incoming.activitySnapshot.sourceRevisions).toContainEqual({ source: 'file', id: 'input-file', revision: change === 'removed' ? '8' : '7' })
    if (change === 'clock_expired') {
      expect(incoming.activitySnapshot.sourceRevisions).toEqual(previous.activitySnapshot.sourceRevisions)
      expect(acceptAgentChatState(previous, incoming, 'receipt').messages[0]?.attachments?.[0]?.file.state).toBe('ready')
    } else expect(acceptAgentChatState(accepted, previous, 'read').messages[0]?.attachments?.[0]?.file.state).toBe('removed')
  })

  it('Operator accepts current input-file metadata after the actual producer file vector advances', async () => {
    const base = operatorState({ revision: 4 }), conversationId = base.conversation.id, file = fileRow(conversationId, 'operator')
    const stored = { ...base.messages[0]!, revision: '1', sequence: '1', requestId: 'A',
      attachmentRefs: [{ fileId: file.file_id, revisionId: file.revision_id }] }
    const query = { query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('select id,revision')) return { rows: [{ id: conversationId, revision: '4', harness: 'codex', native_session_id: null,
        active_request_id: null, active_native_turn_id: null, turn_state: 'idle', cancel_requested: false, pending_interaction: null, response_delivery: null }] }
      if (sql.includes('jsonb_to_recordset')) return { rows: [file] }
      if (sql.includes('from operator_conversation_messages')) return { rows: [{ record: stored }] }
      return { rows: [] }
    } } as unknown as Query
    const read = async () => ({ ...base, messages: await hydrateMessageAttachments(query, conversationId, [stored]),
      activitySnapshot: (await readOperatorActivitySnapshot({} as Parameters<typeof readOperatorActivitySnapshot>[0], query, conversationId))! })
    const previous = await read()
    file.state = 'removed'; file.activity_record_revision = '8'
    const incoming = await read(), accepted = newer(previous, incoming, 'read')
    expect(accepted.activitySnapshot?.sourceRevisions).toContainEqual({ source: 'file', id: file.file_id, revision: '8' })
    expect(accepted.messages[0]?.attachments?.[0]?.file.state).toBe('removed')
    expect(accepted.messages[0]?.revision).toBe('1'); expect(accepted.revision).toBe(4)
    expect(newer(accepted, previous, 'read').messages[0]?.attachments?.[0]?.file.state).toBe('removed')
    // Equal-vector cached receipts cannot replace dynamically expired metadata learned by a read.
    file.state = 'ready'; file.activity_record_revision = '9'
    const ready = await read()
    file.read_at = new Date('2026-10-01T01:01:00Z')
    const expired = await read(), observed = newer(ready, expired, 'read')
    expect(observed.messages[0]?.attachments?.[0]?.file.state).toBe('expired')
    expect(newer(observed, ready, 'receipt').messages[0]?.attachments?.[0]?.file.state).toBe('expired')
  })
})
