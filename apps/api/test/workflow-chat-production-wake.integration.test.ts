import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WorkflowChatPostResponseSchema } from '@foreman-code/contracts'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { closeActivityReplay, setup, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

it('wakes a mentioned Agent once and supplies a scoped read-only Group credential to its native session', async () => {
  const f = await setup({ chatTools: true })
  const { workspaceId, workflowId } = f.saved.scope
  const node = f.saved.version.definition.nodes[0]!
  const selected = await f.call('agent_chat_read', { workspaceId,
    query: { workflowId, workflowNodeId: node.id, agentId: node.agentId } })
  expect(selected.isError, JSON.stringify(selected)).not.toBe(true)
  const target = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(selected)).deliveryTarget
  if (target?.kind !== 'agent_conversation') throw new Error('Expected the exact standalone Agent target.')
  const request = { workspaceId, workflowId, commandId: randomUUID(), body: '@Agent inspect the current work',
    mentions: [{ workflowNodeId: node.id, start: 0, end: 6 }],
    deliveries: [{ workflowNodeId: node.id, target, intent: 'auto' }], cardIds: [] }
  const response = await f.call('workflow_chat_post', request)
  expect(response.isError, JSON.stringify(response)).not.toBe(true)
  const posted = WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(response))
  expect(posted.receipts).toHaveLength(1)
  const started = await eventually(async () => f.replay.starts, starts => starts.length === 1).catch(async cause => {
    const readback = await f.call('agent_chat_read', { workspaceId,
      query: { workflowId, workflowNodeId: node.id, agentId: node.agentId } })
    throw new Error(JSON.stringify(decodeMcpToolResult(readback)), { cause })
  })
  const token = f.replay.appTokens.get(started[0]!.sessionId)
  expect(token).toBeTruthy()
  const read = await f.call('workflow_chat_read', { workspaceId, workflowId }, token!)
  expect(read.isError, JSON.stringify(read)).not.toBe(true)
  expect(decodeMcpToolResult(read)).toMatchObject({ items: [posted.post] })
  const denied = await f.call('workflow_chat_post', { ...request, commandId: randomUUID(), mentions: [], deliveries: [] }, token!)
  expect(denied.isError).toBe(true)
  const foreign = await f.call('workflow_chat_read', { workspaceId, workflowId: 'unrelated-workflow' }, token!)
  expect(foreign.isError).toBe(true)
  const replay = await f.call('workflow_chat_post', request)
  expect(replay.isError, JSON.stringify(replay)).not.toBe(true)
  expect(WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(replay)).post.id).toBe(posted.post.id)
  expect(f.replay.starts).toHaveLength(1)
}, 60_000)
