import { expect, it, vi } from 'vitest'
import { OperatorConversationEvents } from './operatorChat.js'
import { AgentChatEvents } from './agentChat.js'
import { ExecutionActivityReader } from './executionActivity.js'
import { observeGraph } from '../run-graph/measurements.js'
import { readOperationalFailures } from '../diagnostics/logger.js'

it.each([OperatorConversationEvents, AgentChatEvents])('isolates and counts a failed conversation subscriber', Events => {
  const before = readOperationalFailures().find(item => item.operation === 'publish conversation event')?.failureCount ?? 0
  const events = new Events()
  const received = vi.fn()
  events.subscribe('conversation', () => { throw Object.assign(new Error('Subscriber failed'), { code: 'EIO' }) })
  events.subscribe('conversation', received)
  events.publish('conversation', 'state', {})
  expect(received).toHaveBeenCalledOnce()
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'publish conversation event',
    lastError: 'EIO', failureCount: before + 1 }))
})

it('isolates and counts a failed graph measurement sink', () => {
  observeGraph(() => { throw Object.assign(new Error('Sink failed'), { code: 'EIO' }) },
    { stage: 'publication', outcome: 'ok', durationMs: 1 })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'publish graph measurement', lastError: 'EIO' }))
})

it('does not silently restart execution activity after an invalid cursor', async () => {
  const reader = new ExecutionActivityReader({ query: async () => ({ rows: [] }) } as never)
  await expect(reader.read({ workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    workflowNodeId: 'node', agentId: 'agent' }, { cursor: 'invalid' })).rejects.toMatchObject({ code: 'EXECUTION_ACTIVITY_CURSOR_INVALID' })
})
