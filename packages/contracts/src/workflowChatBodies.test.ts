import { expect, it } from 'vitest'
import { WorkflowChatPostSchema, WorkflowChatPostRequestSchema } from './workflowChat.js'

it('retains complete native replies while keeping public posts within 16 KiB', () => {
  const scope = { workspaceId: 'workspace', workflowId: 'workflow' }
  const body = '🙂'.repeat(5000)
  const post = { ...scope, id: 'reply', channelId: 'channel', sequence: 1,
    author: { kind: 'agent', agent: { ...scope, agentId: 'agent', workflowNodeId: 'node',
      configurationVersionId: 'config', productRole: 'coder', displayName: 'Agent' } },
    kind: 'message', body, mentions: [], cardIds: [], replyToPostId: 'question',
    sourceEventKey: 'native-answer', createdAt: '2026-10-01T00:00:00Z' }
  expect(WorkflowChatPostSchema.parse(post).body).toBe(body)
  expect(WorkflowChatPostRequestSchema.safeParse({ ...scope, body, mentions: [], deliveries: [], cardIds: [] }).success).toBe(false)
  expect(WorkflowChatPostRequestSchema.parse({ ...scope, body: 'x'.repeat(16384), mentions: [], deliveries: [], cardIds: [] }).body)
    .toHaveLength(16384)
})
