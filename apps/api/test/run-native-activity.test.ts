import { describe, expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { projectNativeActivityFacts, type NativeActivityFact } from '../src/modules/runs/nativeActivitySnapshot.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('native-activity')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const row: ActivityReadRow = {
  sequence: '1', source: 'harness', kind: 'harness_output', occurred_at: new Date(fixture.createdAt),
  harness_execution_id: 'execution', execution_node_id: node.id, execution_agent_id: node.agentId,
  execution_attempt: 1, work_activation_id: null, result_outcome: null, safe_payload: {}, native: null,
}

describe('native Run activity status', () => {
  it('shows skipped events as observation recovery without reporting a work failure', () => {
    const activity = publicRunActivity({ ...row, source: 'backend', kind: 'native_events_skipped',
      safe_payload: { fromSequence: 10, toSequence: 29, reason: 'retention' } },
    fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity).toMatchObject({ kind: 'recovery', status: 'recorded',
      summary: '20 events skipped', detail: 'Activity observation resumed at event 30. The Agent kept running.',
      actor: { nodeId: node.id, agentId: node.agentId }, refs: { executionId: 'execution' } })
  })
  it('shows model capacity backoff as waiting activity', () => {
    const activity = publicRunActivity({ ...row, native: { type: 'turn.capacity_wait' } },
      fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity).toMatchObject({ summary: 'Waiting for model capacity', status: 'pending' })
  })
  it('shows MCP startup retries on the execution activity', () => {
    const activity = publicRunActivity({ ...row, native: { type: 'turn.mcp_startup_retry' } },
      fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity).toMatchObject({ kind: 'recovery', status: 'pending',
      summary: 'Retrying Foreman Code MCP startup', refs: { executionId: 'execution' } })
  })
  it.each(['result_recorded', 'work_result_accepted', 'work_needs_direction'])(
    'exposes only redacted work result details for %s', (kind) => {
      const token = `opm_${'a'.repeat(43)}`
      const workResult = { outcome: 'succeeded', output: { text: JSON.stringify({
        routing: { kind: 'finish', outcome: 'done' },
        data: { latestDeliverable: { text: `Implemented the fix ${token}` },
          remainingFindings: [{ message: `Review is incomplete ${token}` }] },
      }) } }
      const activity = publicRunActivity({ ...row, kind, work_result: workResult, safe_payload: { unresolvedId: 'unresolved', prompt: 'private prompt',
      } }, fixture.version, fixture.run.id, fixture.run.outcome)
      expect(activity.workResult).toEqual({ outcome: 'done',
        latestDeliverable: { text: 'Implemented the fix [REDACTED]' },
        remainingFindings: [{ message: 'Review is incomplete [REDACTED]' }] })
      expect(activity.kind).toBe(kind === 'work_needs_direction' ? 'needs_direction' : 'agent_work')
      expect(JSON.stringify(activity)).not.toContain(token)
      expect(JSON.stringify(activity)).not.toContain('private prompt')
      expect(JSON.stringify(workResult)).toContain(token)
    })

  it('keeps malformed result text from breaking the activity page', () => {
    const activity = publicRunActivity({ ...row, kind: 'work_result_accepted',
      work_result: { outcome: 'succeeded', output: 'unfinished JSON' } },
    fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity.summary).toBe('Work result recorded')
    expect(activity.workResult).toBeUndefined()
  })

  it.each([
    ['item/agentMessage/delta', 'Agent message updated'],
    ['item/commandExecution/outputDelta', 'Command output updated'],
    ['item/fileChange/outputDelta', 'File change output updated'],
    ['item/reasoning/textDelta', 'Reasoning text updated'],
    ['item/reasoning/summaryTextDelta', 'Reasoning summary updated'],
    ['item/reasoning/summaryPartAdded', 'Reasoning summary added'],
    ['item/mcpToolCall/progress', 'MCP tool progress updated'],
    ['mcpServer/startupStatus/updated', 'MCP server startup updated'],
    ['account/rateLimits/updated', 'Account rate limits updated'],
    ['thread/tokenUsage/updated', 'Token usage updated'],
    ['thread/status/changed', 'Native session status updated'],
    ['turn/diff/updated', 'File changes updated'],
    ['turn/plan/updated', 'Agent plan updated'],
    ['serverRequest/resolved', 'Native request resolved'],
  ])('names %s without exposing its native body', (nativeMethod, summary) => {
    const activity = publicRunActivity({ ...row, native: { type: 'native.notification', nativeMethod,
      deltaLength: 12, delta: 'private message', command: 'private command', diff: 'private diff' } },
    fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity).toMatchObject({ kind: 'tool_log', summary, status: 'recorded', detail: 'Received 12 characters.' })
    expect(JSON.stringify(activity)).not.toContain('private')
  })

  it.each([
    { itemType: 'agentMessage', title: 'Agent message', fields: { messagePhase: 'commentary' }, detail: 'Progress update.' },
    { itemType: 'agentMessage', title: 'Agent message', fields: { messagePhase: 'final_answer' }, detail: 'Final answer.' },
    { itemType: 'userMessage', title: 'User message', fields: {}, detail: undefined },
    { itemType: 'reasoning', title: 'Agent reasoning', fields: {}, detail: undefined },
    { itemType: 'contextCompaction', title: 'Context compaction', fields: {}, detail: undefined },
    { itemType: 'fileChange', title: 'File change', fields: { fileChangeCount: 2 }, detail: 'Changes cover 2 files.' },
    { itemType: 'commandExecution', title: 'Command: git', fields: { commandName: 'git', exitCode: -1 },
      detail: 'Exit code: -1.' },
    { itemType: 'mcpToolCall', title: 'Tool: workspace_list', fields: { toolName: 'workspace_list' }, detail: undefined },
    { itemType: 'dynamicToolCall', title: 'Tool action', fields: {}, detail: undefined },
  ])('names $itemType items and preserves start and completion', ({ itemType, title, fields, detail }) => {
    for (const [type, status, action] of [
      ['item.started', 'running', 'started'], ['item.completed', 'completed', 'completed'],
    ]) {
      const activity = publicRunActivity({ ...row, native: { type, itemType, ...fields, text: 'private body' } },
        fixture.version, fixture.run.id, fixture.run.outcome)
      expect(activity).toMatchObject({ summary: `${title} ${action}`, status })
      expect(activity.detail).toBe(detail)
      expect(JSON.stringify(activity)).not.toContain('private body')
    }
  })

  it('names reconciled native session history instead of reporting it unavailable', () => {
    const activity = publicRunActivity({ ...row, native: { type: 'thread.reconciled' } }, fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity.summary).toBe('Native session history reconciled')
  })

  it.each(['constructor', 'unknown/providerMethod'])('keeps unknown method %s redacted', (nativeMethod) => {
    const activity = publicRunActivity({ ...row, native: {
      type: 'native.notification', nativeMethod, deltaLength: 20, delta: 'private body',
    } }, fixture.version, fixture.run.id, fixture.run.outcome)
    expect(activity.summary).toBe('Native activity recorded; details unavailable')
    expect(activity.detail).toBeUndefined()
    expect(JSON.stringify(activity)).not.toContain('private body')
  })

  it.each([
    ['turn.started', 'inProgress', 'running', 'Agent turn started'],
    ['turn.completed', 'completed', 'completed', 'Agent turn completed'],
    ['turn.completed', 'failed', 'failed', 'Agent turn failed'],
    ['turn.completed', 'interrupted', 'canceled', 'Agent turn canceled'],
    ['thread.started', undefined, 'recorded', 'Native session created'],
  ])('names %s lifecycle activity', (type, turnStatus, status, summary) => {
    expect(publicRunActivity({ ...row, native: { type, turnStatus } },
      fixture.version, fixture.run.id, fixture.run.outcome)).toMatchObject({ summary, status })
  })

  const resolve = (executionId: string) => ({
    owner: { kind: 'execution' as const, ...fixture.scope, executionId, attemptKey: '1' },
    harness: 'codex', sessionId: 'session', terminal: executionId === 'terminated-parent' })
  const fact = (index: number, status: string, execution = 'execution'): NativeActivityFact => ({
    execution_id: execution, sequence: String(index + 1), item_id: `command-${index}`, item_type: 'commandExecution',
    status, native_session_id: 'session', native_turn_id: null, generation: null, observed_at: fixture.createdAt,
  })

  it('retains unfinished tools beyond completed history and reports only unfinished overflow', () => {
    const history = Array.from({ length: 1001 }, (_, index) => fact(index, 'completed'))
    const completed = projectNativeActivityFacts(history, resolve)
    expect(completed.activities).toHaveLength(1000)
    expect(completed.active).toEqual([])
    expect(completed.hasMore).toBe(false)
    const withActive = projectNativeActivityFacts([...history, fact(1001, 'running', 'other-execution')], resolve)
    expect(withActive.active).toHaveLength(1)
    expect(withActive.active[0]?.native?.itemId).toBe('command-1001')
    expect(withActive.activities.at(-1)).toMatchObject({ status: 'running', owner: { executionId: 'other-execution' } })
    expect(withActive.hasMore).toBe(false)
  })

  it('bounds unfinished work independently and retains uncertain children of terminated parents', () => {
    const unfinished = Array.from({ length: 1001 }, (_, index) => fact(index, 'running'))
    const projected = projectNativeActivityFacts(unfinished, resolve)
    expect(projected.active).toHaveLength(1000)
    expect(projected.hasMore).toBe(true)
    const child = { ...fact(1002, 'running', 'terminated-parent'), item_type: 'subagent' }
    const uncertain = projectNativeActivityFacts([child], resolve)
    expect(uncertain.activities[0]).toMatchObject({ kind: 'subagent', status: 'unknown', evidence: 'unknown' })
    expect(uncertain.active[0]).toMatchObject({ evidence: 'unknown', native: { itemId: child.item_id } })
    expect(uncertain.hasMore).toBe(false)
  })

  it.each(['canceled', 'cancelled', 'interrupted'])('keeps %s canceled across native envelopes', (status) => {
    for (const type of ['item.started', 'item.completed', 'item.snapshot']) {
      for (const fields of [{ itemType: 'commandExecution', itemStatus: status, itemError: true },
        { partTool: 'bash', partStatus: status }]) {
        const activity = publicRunActivity({ ...row, native: { type, ...fields } },
          fixture.version, fixture.run.id, fixture.run.outcome)
        expect(activity).toMatchObject({ kind: 'tool_action', status: 'canceled', severity: 'info',
          summary: 'Command action canceled' })
      }
    }
    const snapshot = projectNativeActivityFacts([{
      execution_id: 'execution', sequence: '1', item_id: 'command', item_type: 'commandExecution', status, item_error: true,
      native_session_id: 'session', native_turn_id: null, generation: null, observed_at: fixture.createdAt,
    }], () => ({ owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'session', terminal: false }))
    expect(snapshot.activities[0]).toMatchObject({ status: 'canceled', evidence: 'confirmed' })
    expect(snapshot.active).toEqual([])
  })

  it.each([
    { itemStatus: 'completed', itemError: false, expected: 'completed' },
    { itemStatus: 'completed', itemError: true, expected: 'failed' },
    { itemStatus: 'failed', itemError: false, expected: 'failed' },
    { itemStatus: 'declined', itemError: false, expected: 'failed' },
  ])('preserves completion and real failures: $expected', ({ expected, ...native }) => {
    expect(publicRunActivity({ ...row, native: { type: 'item.completed', itemType: 'commandExecution', ...native } },
      fixture.version, fixture.run.id, fixture.run.outcome).status).toBe(expected)
    const snapshot = projectNativeActivityFacts([{
      execution_id: 'execution', sequence: '1', item_id: 'command', item_type: 'commandExecution',
      status: native.itemStatus, item_error: native.itemError,
      native_session_id: 'session', native_turn_id: null, generation: null, observed_at: fixture.createdAt,
    }], () => ({ owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'session', terminal: false }))
    expect(snapshot.activities[0]).toMatchObject({ status: expected, evidence: 'confirmed' })
    expect(snapshot.active).toEqual([])
  })
})
