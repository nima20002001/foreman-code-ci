import type { RunSubagent } from '@foreman-code/contracts/subagents'
import { completedNativeAssistantMessage, nativeAssistantText } from '../conversations/operatorText.js'
import { createClaudeEventNormalizer } from '../harnesses/claudeSdk/normalization.js'
import { describe, expect, it } from 'vitest'
import { isChildCandidate, normalizeSubagentEvent, sanitizeSubagentValue } from './normalization.js'
import type { SubagentProjectionContext } from './types.js'

export const context: SubagentProjectionContext = { workspaceId: 'w', workflowId: 'wf', workflowVersionId: 'v', runId: 'r',
  parentNodeId: 'node', parentAgentId: 'a', parentExecutionId: 'e', parentAttemptKey: 'e:1', provider: 'codex',
  parentSessionId: 'root', profile: { deviceId: 'main', harnessInstanceId: 'instance', providerVersion: '0.154.0' } }
const event = (type: string, payload: Record<string, unknown>, sequence = 1) => ({ executionId: 'e', sequence, type,
  occurredAt: '2026-10-02T20:00:00.000Z', payload })
describe('child evidence normalization', () => {
  it('discovers one child from subAgentActivity with stable parent proof', () => {
    const changes = normalizeSubagentEvent(context, event('item.completed', { threadId: 'root', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' } }), [])
    expect(changes).toMatchObject([{ kind: 'discover', childId: 'child', parentSessionId: 'root', nativeMode: 'codex-multi-agent-v2', status: 'running' }])
  })
  it('keeps a child running when its parent sends it more input', () => {
    const changes = normalizeSubagentEvent(context, event('item.completed', { threadId: 'root', item: { type: 'subAgentActivity', id: 'send', kind: 'interacted', agentThreadId: 'child', agentPath: '/root/worker' } }), [])
    expect(changes).toMatchObject([{ kind: 'discover', childId: 'child', status: 'running' }])
  })
  it('queues only Codex child evidence that a later discovery could still claim', () => {
    const known = { native: { childSessionId: 'child' } } as RunSubagent
    const note = (method: string, threadId: string) => event('native.unlinked_notification', { method, params: { threadId, item: { id: 'i', type: 'reasoning' } } })
    expect(isChildCandidate(context, note('item/completed', 'unseen'), [known])).toBe(true)
    expect(isChildCandidate(context, note('item/completed', 'child'), [known])).toBe(false)
    expect(isChildCandidate(context, note('item/agentMessage/delta', 'unseen'), [known])).toBe(false)
    expect(isChildCandidate(context, note('thread/tokenUsage/updated', 'unseen'), [known])).toBe(false)
    expect(isChildCandidate(context, note('item/completed', 'root'), [known])).toBe(false)
  })
  it('quarantines foreign notifications until structured parent proof exists', () => {
    expect(normalizeSubagentEvent(context, event('native.unlinked_notification', { threadId: 'foreign', method: 'item/completed', params: { threadId: 'foreign', item: { id: 'm', type: 'agentMessage', text: 'CHILD ONLY' } } }), [])).toEqual([])
  })
  it('preserves command exit results and treats declined/nonzero child tools as failed', () => {
    const parent = { native: { childSessionId: 'child' } } as RunSubagent
    const command = (status: string, exitCode?: number) => event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'commandExecution', id: 'command', command: 'read sentinel', status, aggregatedOutput: 'result', ...(exitCode === undefined ? {} : { exitCode }) } } })
    expect(normalizeSubagentEvent(context, command('completed', 1), [parent])).toMatchObject([{ kind: 'tool', status: 'failed', output: { text: 'result', exitCode: 1 }, error: { exitCode: 1 } }])
    expect(normalizeSubagentEvent(context, command('completed', 0), [parent])).toMatchObject([{ kind: 'tool', status: 'completed', output: { exitCode: 0 } }])
    expect(normalizeSubagentEvent(context, command('declined'), [parent])).toMatchObject([{ kind: 'tool', status: 'failed' }])
  })
  it('retains a nested child spawn as a tool of its immediate parent child', () => {
    const parent = { native: { childSessionId: 'child' } } as RunSubagent
    expect(normalizeSubagentEvent(context, event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['nested'], status: 'completed' } } }), [parent]))
      .toMatchObject([{ kind: 'discover', childId: 'nested', parentSessionId: 'child' }, { kind: 'tool', childId: 'child', nativeToolId: 'spawn' }])
  })
  it('keeps explicitly addressed child history out of every parent answer path', () => {
    for (const harness of ['claude', 'codex'] as const) {
      const record = { sequence: 0, occurredAt: '2026-10-02T20:00:00.000Z', type: harness === 'claude' ? 'claude.text' : 'item.completed',
        payload: { subagentNativeId: 'child', itemId: 'm', operation: 'replace', text: 'CHILD ONLY', final: true,
          item: { id: 'm', type: 'agentMessage', text: 'CHILD ONLY' }, part: { id: 'm', messageID: 'm', type: 'text', text: 'CHILD ONLY' } } }
      expect(nativeAssistantText(record)).toEqual([])
      expect(completedNativeAssistantMessage(record, harness)).toBeUndefined()
    }
  })
  it('redacts structured credentials and private reasoning and bounds results', () => {
    expect(sanitizeSubagentValue({ token: 'secret', reasoning: 'hidden', result: 'ok', nested: { Authorization: 'Bearer secret' } }).value)
      .toEqual({ token: '[redacted]', reasoning: '[redacted]', result: 'ok', nested: { Authorization: '[redacted]' } })
    expect(sanitizeSubagentValue('x'.repeat(40000)).truncation.truncated).toBe(true)
  })
})


describe('Claude child evidence preservation', () => {
  it('retains local_agent type, explicit agent identity, description and child user text', () => {
    const normalizer = createClaudeEventNormalizer({ owner: { ownerId: 'r', attemptId: 'e', generation: 'g' }, observedAt: () => '2026-10-02T20:00:00.000Z' })
    expect(normalizer.ingest({ type: 'system', subtype: 'task_started', session_id: 'root', uuid: 'event-task', task_id: 'task', task_type: 'local_agent', agent_id: 'agent', tool_use_id: 'spawn', description: 'Worker', depth: 2 })[0]!.change)
      .toMatchObject({ kind: 'task', taskType: 'local_agent', agentId: 'agent', description: 'Worker', depth: 2 })
    expect(normalizer.ingest({ type: 'user', session_id: 'root', uuid: 'event-user', parent_tool_use_id: 'spawn', message: { content: [{ type: 'text', text: 'CHILD USER ONLY' }] } })[0]!.change)
      .toMatchObject({ kind: 'text', role: 'user', text: 'CHILD USER ONLY', operation: 'replace' })
  })
})


it('retains Claude child clipping coverage and original byte count at the decoder boundary', () => {
  const normalizer = createClaudeEventNormalizer({ owner: { ownerId: 'r', attemptId: 'e', generation: 'g' }, observedAt: () => '2026-10-02T20:00:00.000Z' })
  const decoded = normalizer.ingest({ type: 'assistant', session_id: 'root', uuid: 'child-message', parent_tool_use_id: 'spawn', message: { id: 'message', content: [{ type: 'text', text: 'x'.repeat(25000) }] } })[0]!
  expect(decoded.change).toMatchObject({ kind: 'text', text: 'x'.repeat(24000), truncation: { truncated: true, originalBytes: 25000 } })
  expect(decoded.evidence.contentIndex).toBe(0)
})
