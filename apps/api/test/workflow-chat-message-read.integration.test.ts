import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { EngineChatReadbackSchema } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'

it('reads complete execution messages through authenticated MCP with HTTP parity and scoped denial', async () => {
  const f = await currentOperatorIntegration({ executionChat: true, approvalNodeIds: [] })
  try {
    await f.engine.start(f.f.run.id)
    const execution = (await f.runs.listRepeatExecutions(f.f.run.id))[0]!.execution
    const target = await workflowChatTarget(f, execution.workflowNodeId, execution.id)
    const content = 'Complete native answer. '.repeat(4000)
    await f.db.pool.query(`insert into harness_native_events(execution_id,sequence,record) values($1,1000,$2::jsonb)`,
      [execution.id, JSON.stringify({ sequence: 1000, occurredAt: new Date().toISOString(), type: 'item.completed',
        payload: { threadId: execution.nativeSessionId, turnId: 'answer-turn',
          item: { id: 'large-answer', type: 'agentMessage', text: content } } })])
    const page = await f.client.callTool({ name: 'agent_chat_read', arguments: { target } })
    expect(page.isError, JSON.stringify(page)).not.toBe(true)
    const message = EngineChatReadbackSchema.parse(decodeMcpToolResult(page)).messages.find(row => row.nativeMessageId === 'large-answer')!
    expect(message.content.length).toBe(65_536)
    expect(message.truncation?.truncated).toBe(true)
    const input = { target, messageId: message.id }
    const http = await f.app.inject({ method: 'POST',
      url: `/api/workspaces/${target.agent.workspaceId}/workflows/${target.agent.workflowId}/execution-chat/message`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.json().content).toBe(content)
    const full = await f.client.callTool({ name: 'agent_chat_read', arguments: input })
    expect(full.isError, JSON.stringify(full)).not.toBe(true)
    expect(decodeMcpToolResult(full)).toEqual(http.json())
    const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['different-workspace'] } }] })
    const deniedClient = await f.connect(denied.token)
    const refusal = await deniedClient.callTool({ name: 'agent_chat_read', arguments: input })
    expect(refusal.isError).toBe(true)
    const reread = await f.client.callTool({ name: 'agent_chat_read', arguments: input })
    expect(decodeMcpToolResult(reread)).toEqual(http.json())
  } finally { await f.close() }
}, 60_000)
