import { describe, expect, it } from 'vitest'
import { agentActivitySnapshot } from '../src/modules/conversations/activitySnapshot.js'
import type { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
type State = NonNullable<Awaited<ReturnType<PostgresAgentChatRepository['state']>>>
const state = (): State => ({
  row: { id: 'conversation', workspace_id: 'workspace', workflow_id: 'workflow', workflow_node_id: 'node', agent_id: 'agent',
    active_request_id: 'A', native_session_id: 'session', active_native_turn_id: 'native-A', harness: 'codex',
    origin_run_id: null, origin_execution_id: null, turn_state: 'active', cancel_requested: false,
    pending_interaction: null, revision: '9007199254740993', updated_at: new Date('2026-10-01T02:00:00Z') } as State['row'],
  turns: [{ requestId: 'A', sequence: '1', delivery: 'accepted', intent: 'next_turn', messageId: 'a', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z' },
    { requestId: 'B', sequence: '2', delivery: 'queued', intent: 'next_turn', messageId: 'b', createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z' }],
  latestRequestId: 'B', activeStartedAt: new Date('2026-10-01T00:00:00Z'), activityPage: { activities: [], nextCursor: null, itemRevisions: {} }, selection: null,
  unfinishedActivities: [], messages: [], hasEarlierMessages: false,
})
describe('persisted Agent activity adapter', () => {
  it('reads exact revision and keeps active A, queued B, latest B with stable start', () => {
    const loaded = state(); const snapshot = agentActivitySnapshot(loaded)
    expect(snapshot.revision).toBe('9007199254740993')
    expect(snapshot.active[0]).toMatchObject({ ref: { requestId: 'A' }, startedAt: '2026-10-01T00:00:00.000Z', native: { turnId: 'native-A' } })
    expect(snapshot.queued[0]).toMatchObject({ requestId: 'B' }); expect(snapshot.latest).toEqual(snapshot.queued[0])
    loaded.row.updated_at = new Date('2026-10-01T03:00:00Z')
    expect(agentActivitySnapshot(loaded)).toEqual(snapshot)
  })
  it('preserves unresolved children and omits private tool input/output', () => {
    const loaded = state(); loaded.row.active_request_id = null
    loaded.activityPage.activities.push({ id: 'child', requestId: 'A', sequence: '5', revision: 2, kind: 'subagent', title: 'Child', status: 'unknown', input: 'secret args', output: 'secret output' })
    loaded.unfinishedActivities.push(loaded.activityPage.activities[0]!)
    loaded.activityPage.itemRevisions[JSON.stringify(['A', 'child'])] = '9007199254740993'
    const snapshot = agentActivitySnapshot(loaded)
    expect(snapshot.activities[0]?.revision).toBe('9007199254740993')
    expect(snapshot.active).toMatchObject([{ ref: { kind: 'subagent', itemId: JSON.stringify(['conversation-activity', 'conversation', 'A', 'child']) }, evidence: 'unknown', outcome: null }])
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })
  it('keeps an unfinished child active when chronological history contains only newer completions', () => {
    const loaded = state(); loaded.row.active_request_id = null
    loaded.activityPage.activities = Array.from({ length: 100 }, (_, index) => ({ id: `completed-${index}`, requestId: 'A',
      sequence: String(index + 2), revision: 1, kind: 'tool', title: 'Completed', status: 'completed' }))
    loaded.unfinishedActivities = [{ id: 'old-child', requestId: 'A', sequence: '1', revision: 2, kind: 'subagent', title: 'Child', status: 'unknown' }]
    const snapshot = agentActivitySnapshot(loaded)
    expect(snapshot.active).toMatchObject([{ ref: { kind: 'subagent', itemId: JSON.stringify(['conversation-activity', 'conversation', 'A', 'old-child']) }, evidence: 'unknown', outcome: null }])
    expect(snapshot.activities.some((entry) => entry.id === 'old-child')).toBe(false)
  })
  it('keeps immutable selected origin and rejects missing origin facts', () => {
    const loaded = state(); loaded.row.origin_run_id = 'run'; loaded.row.origin_execution_id = 'execution'
    expect(() => agentActivitySnapshot(loaded)).toThrow('exact persisted origin')
    loaded.selection = { workflowVersionId: 'saved-version', attemptKey: '3' }
    expect(agentActivitySnapshot(loaded).scope).toMatchObject({ kind: 'selected_run_chat', selection: { runId: 'run', executionId: 'execution', workflowVersionId: 'saved-version', attemptKey: '3' } })
  })
  it('publication item revision follows actual independent file state while scope revision stays equal', () => {
    const loaded = state()
    loaded.messages = [{ id: 'message', conversationId: loaded.row.id, requestId: 'A', role: 'user', content: 'Publish', sequence: '1', revision: '0',
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }]
    loaded.publicationReceipts = [{ receiptId: 'receipt', messageId: 'message', fileId: 'file', fileRevisionId: 'file-version',
      nativeSessionId: 'session', nativeTurnId: 'native-A', fileActivityRevision: '7', fileState: 'ready' }]
    const ready = agentActivitySnapshot(loaded)
    loaded.publicationReceipts[0] = { ...loaded.publicationReceipts[0]!, fileActivityRevision: '8', fileState: 'expired' }
    const expired = agentActivitySnapshot(loaded)
    expect(ready.revision).toBe(expired.revision)
    expect(ready.activities.find((item) => item.kind === 'file_publication')).toMatchObject({ revision: '7', status: 'ready' })
    expect(expired.activities.find((item) => item.kind === 'file_publication')).toMatchObject({ revision: '8', status: 'unknown' })
  })

})
