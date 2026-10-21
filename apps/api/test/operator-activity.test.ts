import { describe, expect, it } from 'vitest'
import { CODEX_UNSUPPORTED_INTERACTION_ERRORS, type NativeHarnessEvent } from '@foreman-code/contracts'
import { currentOperatorHistory, operatorActivity } from '../src/modules/conversations/operatorActivity.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'
import { knownNativeActivity } from '../src/modules/conversations/knownNativeActivity.js'

const event = (type: string, payload: Record<string, unknown>): NativeHarnessEvent => ({ type, payload, sequence: 1, occurredAt: '2026-09-19T00:00:00.000Z' })

describe('Operator native activity projection', () => {
  it.each(Object.entries(CODEX_UNSUPPORTED_INTERACTION_ERRORS))('shows the %s error without native question text', (code, message) => {
    const projected = operatorActivity(event('interaction.unsupported', {
      activityId: 'unsupported-request', turnId: 'turn', code, message: 'Untrusted native text',
    }), 'codex', 'request')
    expect(projected).toEqual({ id: 'unsupported-request', requestId: 'request', kind: 'tool',
      status: 'failed', title: message, output: message })
    expect(knownNativeActivity(event('interaction.unsupported', { threadId: 'thread', turnId: 'turn',
      activityId: 'unsupported-request', code }), 'codex')).toBeUndefined()
    expect(operatorActivity(event('interaction.unsupported', { activityId: 'unsupported-request', code }), 'codex', 'request'))
      .toBeUndefined()
  })

  it.each([
    ['tool', { type: 'commandExecution', command: 'printf hello', cwd: '/project', commandActions: [{ type: 'unknown', command: 'printf hello' }], aggregatedOutput: 'hello' }],
    ['file_read', { type: 'commandExecution', command: 'cat note.txt', cwd: '/project', commandActions: [{ type: 'read', command: 'cat note.txt', name: 'note.txt', path: '/project/note.txt' }], aggregatedOutput: 'saved note' }],
    ['file_write', { type: 'fileChange', changes: [{ path: '/project/note.txt', kind: { type: 'add' }, diff: '+saved note' }] }],
    ['mcp', { type: 'mcpToolCall', server: 'graphql', tool: 'workspace_list', arguments: {}, result: { content: [{ type: 'text', text: '[]' }] } }],
    ['web_search', { type: 'webSearch', query: 'IANA examples', action: { type: 'search', query: 'IANA examples' } }],
    ['subagent', { type: 'collabAgentToolCall', tool: 'spawnAgent', model: 'gpt-5.6-luna', reasoningEffort: 'high', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }],
  ] as const)('projects Codex %s from structured native items', (kind, item) => {
    const projected = operatorActivity(event('item.completed', { turnId: 'turn', item: { ...item, id: 'item', status: 'completed' } }), 'codex', 'request')
    expect(projected).toMatchObject({ id: 'item', requestId: 'request', kind, status: 'completed' })
  })

  it('uses only public thinking summaries and does not confuse failures with successful completion', () => {
    expect(operatorActivity(event('item.completed', { item: { id: 'think', type: 'reasoning', summary: ['Public summary'], content: ['Private content'] } }), 'codex', 'request'))
      .toMatchObject({ kind: 'thinking', output: 'Public summary' })
    expect(JSON.stringify(operatorActivity(event('item.completed', { item: { id: 'think', type: 'reasoning', summary: [], content: ['Private content'] } }), 'codex', 'request'))).not.toContain('Private content')
    expect(operatorActivity(event('item.completed', { item: { id: 'tool', type: 'mcpToolCall', server: 'app', tool: 'read', status: 'failed', error: { message: 'Denied' } } }), 'codex', 'request'))
      .toMatchObject({ status: 'failed' })
  })

  it('bounds large details and redacts old scoped credentials before persistence', () => {
    const token = `opm_${'a'.repeat(43)}`
    const projected = operatorActivity(event('item.completed', { item: { id: 'tool', type: 'commandExecution', command: token, commandActions: [], status: 'completed', aggregatedOutput: 'x'.repeat(25000) } }), 'codex', 'request')!
    expect(projected.output).toHaveLength(24000)
    expect(projected.truncated).toBe(true)
    const redacted = nativePersistenceRedactor([]).value(projected)
    expect(JSON.stringify(redacted)).not.toContain(token)
    expect(redacted.input).toContain('[REDACTED]')
  })

  it('excludes previous Codex turns from the current request history', () => {
    const history = {
      nativeTurnId: 'right-turn',
      events: [event('item.snapshot', { turnId: 'wrong-turn' })],
      pendingInteractions: [],
    }
    expect(currentOperatorHistory(history, 'codex')).toEqual([])
  })

})
